//! DSH 中转接管
//!
//! 接管时把 DeepSeek Harness 每个供应商的 `baseURL` 改写成本机代理的
//! `http://127.0.0.1:<port>/dsh/<provider_id>`，退出 CC Switch 时再换回原始地址——
//! 这样关掉 CC Switch 也能直接用 DSH（不依赖本机的转发进程）。
//!
//! 原始地址记在 `<app config dir>/dsh_relay_state.json`（下称「账本」）：进程被强杀时下次
//! 启动还能照着恢复；恢复前会先比对当前值，避免覆盖用户在 DSH 里手改的地址。
//!
//! 两条不变式：
//! - 账本永远先于原生配置落盘，且只会多记不会少记（多记的条目恢复时按「当前值≠中转地址」跳过）。
//! - 原始地址永远不能是另一个中转地址，否则退出时会把死端口写回 DSH。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::{atomic_write_private, get_app_config_dir};
use crate::deepseek_harness_config::{self as dsh, NativeProviderSource};
use crate::deepseek_harness_patch as patch;
use crate::error::AppError;
use crate::proxy::http_client;
use crate::proxy::ProxyStatus;
use crate::services::proxy::{proxy_origin, ProxyService};

const STATE_FILE_NAME: &str = "dsh_relay_state.json";
const BASE_URL_FIELD: &str = "baseURL";

/// 一个 DSH 供应商的地址记录：接管前是什么、接管时写成了什么。
///
/// 落盘时只记 `relayed` 的条目；返回前端时则是「当前全量供应商」的现状（见 [`build_status`]）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRelayProvider {
    pub provider_id: String,
    #[serde(default)]
    pub name: String,
    /// 接管前的原始地址，退出/关闭接管时写回这里。
    #[serde(default)]
    pub original_base_url: Option<String>,
    /// 接管期间写给 DSH 的本机中转地址。
    #[serde(default)]
    pub relay_base_url: Option<String>,
    #[serde(default)]
    pub relayed: bool,
}

/// 落盘的接管快照，同时也是前端 `DshRelayStatus` 的主体。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRelaySnapshot {
    #[serde(default)]
    pub attached: bool,
    #[serde(default)]
    pub base_url: Option<String>,
    /// 永远序列化成数组：前端按数组遍历，`null` 会让它在 `.map` 上炸。
    #[serde(default)]
    pub providers: Vec<DshRelayProvider>,
}

/// 请求转发时真正要用的东西：原始地址，外加兜底补认证要用的 api 类型和密钥。
#[derive(Debug, Clone)]
pub struct RelayTarget {
    pub base_url: String,
    pub api: Option<String>,
    pub api_key: Option<String>,
}

/// 内存里的转发目标表，`relay_target` 每次请求都会查它，避免逐请求读文件。
static TARGETS: LazyLock<RwLock<HashMap<String, RelayTarget>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
static LOADED: AtomicBool = AtomicBool::new(false);

/// 接管快照文件（含供应商原始地址，不需要密钥，但仍按私有文件写）。
pub fn state_path() -> PathBuf {
    get_app_config_dir().join(STATE_FILE_NAME)
}

pub fn read_snapshot() -> DshRelaySnapshot {
    let path = state_path();
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return DshRelaySnapshot::default();
    };
    serde_json::from_str(&contents).unwrap_or_else(|error| {
        log::warn!(
            "[DSH-Relay] 解析 {} 失败，按未接管处理: {error}",
            path.display()
        );
        DshRelaySnapshot::default()
    })
}

fn write_snapshot(snapshot: &DshRelaySnapshot) -> Result<(), String> {
    let path = state_path();
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|error| format!("序列化 DSH 中转状态失败: {error}"))?;
    atomic_write_private(&path, json.as_bytes())
        .map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

/// 这个地址是不是本机中转地址（自己转给自己会打转）。
///
/// 只认「回环主机 + `/dsh/` 路径」：上游本来就可能是回环（Ollama 之类），所以不能只看主机。
pub fn is_relay_url(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    http_client::is_loopback_url(base_url) && url.path().starts_with("/dsh/")
}

/// 是否处于接管状态。退出钩子用，不读取 DSH 配置。
pub fn is_attached() -> bool {
    read_snapshot().attached
}

/// 账本里记着的原始地址（接管期间把原生配置回流数据库时用）。
pub fn recorded_original(provider_id: &str) -> Option<String> {
    let snapshot = read_snapshot();
    if !snapshot.attached {
        return None;
    }
    snapshot
        .providers
        .iter()
        .find(|entry| entry.provider_id == provider_id)
        .and_then(|entry| entry.original_base_url.clone())
        .filter(|value| !is_relay_url(value))
}

/// 设置页要的完整状态：接管标记 + **当前 DSH 里所有供应商的现状**。
///
/// 读失败不会报错（设置页只是展示），但会保留上一次算出来的转发目标表。
pub fn status() -> DshRelaySnapshot {
    let snapshot = read_snapshot();
    let live = match live_providers() {
        Ok(live) => live,
        Err(error) => {
            log::warn!("[DSH-Relay] 读取 DeepSeek Harness 配置失败: {error}");
            Vec::new()
        }
    };
    apply_targets(&snapshot, &live);
    build_status(&snapshot, &live)
}

/// 某个供应商当前的转发目标；没接管就是 `None`。
pub fn relay_target(provider_id: &str) -> Option<RelayTarget> {
    if !LOADED.load(Ordering::Relaxed) {
        refresh_targets();
    }
    cached_target(provider_id)
}

fn cached_target(provider_id: &str) -> Option<RelayTarget> {
    let targets = TARGETS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    targets.get(provider_id).cloned()
}

/// 按账本重建内存里的转发目标表（接管时请求要转去原始地址）。
fn refresh_targets() {
    let snapshot = read_snapshot();
    match live_providers() {
        Ok(live) => apply_targets(&snapshot, &live),
        Err(error) => {
            log::warn!("[DSH-Relay] 读取 DeepSeek Harness 配置失败: {error}");
            apply_targets(&snapshot, &[]);
        }
    }
}

fn apply_targets(snapshot: &DshRelaySnapshot, live: &[(String, LiveProvider)]) {
    let mut targets = HashMap::new();
    if snapshot.attached {
        for provider in snapshot.providers.iter().filter(|entry| entry.relayed) {
            let Some(original) = provider
                .original_base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if is_relay_url(original) {
                log::warn!(
                    "[DSH-Relay] 供应商 `{}` 记录的原始地址本身就是中转地址，跳过",
                    provider.provider_id
                );
                continue;
            }
            let auth = live
                .iter()
                .find(|(provider_id, _)| provider_id == &provider.provider_id)
                .map(|(_, entry)| entry);
            targets.insert(
                provider.provider_id.clone(),
                RelayTarget {
                    base_url: original.to_string(),
                    api: auth.and_then(|entry| entry.api.clone()),
                    api_key: auth.and_then(|entry| entry.api_key.clone()),
                },
            );
        }
    }
    *TARGETS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = targets;
    LOADED.store(true, Ordering::Relaxed);
}

/// DSH 当前真实的供应商：来源（官方 / pi-ai）、地址、api 类型与解析好的密钥。
///
/// 用 `Vec` 而不是 `HashMap`：设置页按 DSH 配置里的顺序展示，顺序要稳定。
struct LiveProvider {
    name: String,
    source: NativeProviderSource,
    base_url: Option<String>,
    api: Option<String>,
    api_key: Option<String>,
}

/// 读 DSH 原生配置。失败必须向上报——把「读不到」当成「供应商没了」会丢掉原始地址。
fn live_providers() -> Result<Vec<(String, LiveProvider)>, String> {
    let state = dsh::read_native_state()
        .map_err(|error| format!("读取 DeepSeek Harness 配置失败: {error}"))?;
    Ok(state
        .providers
        .into_iter()
        .map(|(provider_id, provider)| {
            let text = |field: &str| {
                provider
                    .config
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
            };
            (
                provider_id,
                LiveProvider {
                    name: provider.name.clone(),
                    source: provider.source,
                    base_url: text(BASE_URL_FIELD),
                    api: text("api"),
                    api_key: text("apiKey"),
                },
            )
        })
        .collect())
}

/// 把「账本 + 当前原生状态」拼成前端状态。
///
/// `providers` 是 DSH 里所有供应商的全量现状，而不只是被接管的那几个：
/// 前端要能同时显示「哪些走中转、续口指向哪、原始地址是什么」。
fn build_status(snapshot: &DshRelaySnapshot, live: &[(String, LiveProvider)]) -> DshRelaySnapshot {
    let providers = live
        .iter()
        .map(|(provider_id, provider)| {
            let current = provider.base_url.clone().filter(|value| !value.is_empty());
            let relayed = snapshot.attached && current.as_deref().is_some_and(is_relay_url);
            let recorded = snapshot
                .providers
                .iter()
                .find(|entry| entry.provider_id == *provider_id)
                .and_then(|entry| entry.original_base_url.clone())
                .filter(|value| !is_relay_url(value));
            DshRelayProvider {
                provider_id: provider_id.clone(),
                name: provider.name.clone(),
                // 账本里的原始地址优先：接管期间原生地址是中转地址，直接显示会把用户吓到。
                original_base_url: recorded
                    .or_else(|| current.clone().filter(|value| !is_relay_url(value))),
                relay_base_url: if relayed { current } else { None },
                relayed,
            }
        })
        .collect();
    DshRelaySnapshot {
        attached: snapshot.attached,
        base_url: snapshot.base_url.clone(),
        providers,
    }
}

/// 一次接管的计划：把 `provider` 的中转地址写进去，原始地址记下来。
struct AttachPlan {
    provider_id: String,
    name: String,
    source: NativeProviderSource,
    original_base_url: String,
    relay_base_url: String,
}

impl AttachPlan {
    fn entry(&self) -> DshRelayProvider {
        DshRelayProvider {
            provider_id: self.provider_id.clone(),
            name: self.name.clone(),
            original_base_url: Some(self.original_base_url.clone()),
            relay_base_url: Some(self.relay_base_url.clone()),
            relayed: true,
        }
    }
}

/// 算出这次要接管谁、原始地址是什么。纯函数，方便单测。
///
/// 关键点：DSH 里已经是中转地址时只能沿用账本里的原始地址——重复接管绝不能把中转地址
/// 记成「原始地址」，否则退出时会把死端口写回 DSH。
fn plan_attach(
    previous: &DshRelaySnapshot,
    origin: &str,
    live: &[(String, LiveProvider)],
) -> Vec<AttachPlan> {
    let origin = origin.trim_end_matches('/');
    let mut plans = Vec::with_capacity(live.len());
    for (provider_id, provider) in live {
        let current = provider
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let original = match current {
            Some(value) if is_relay_url(value) => previous
                .providers
                .iter()
                .find(|entry| entry.provider_id == *provider_id)
                .and_then(|entry| entry.original_base_url.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty() && !is_relay_url(value))
                .map(ToOwned::to_owned),
            Some(value) => Some(value.to_string()),
            None => None,
        };
        let Some(original) = original else {
            log::warn!("[DSH-Relay] 供应商 `{provider_id}` 没有可用的原始地址，跳过接管");
            continue;
        };
        plans.push(AttachPlan {
            provider_id: provider_id.clone(),
            name: provider.name.clone(),
            source: provider.source,
            original_base_url: original,
            relay_base_url: format!("{origin}/dsh/{provider_id}"),
        });
    }
    plans
}

/// 接管：把每个有 `baseURL` 的供应商改写到当前监听端口，并记下原始地址。
///
/// 顺序是「先记账、后改配置」：两步之间被强杀时，账本已经指向可恢复的原始地址；
/// 反过来（先改配置再记账）一旦崩在中间，原始地址就永久丢了。
pub async fn attach(proxy_service: &ProxyService) -> Result<DshRelaySnapshot, String> {
    let proxy_status = ensure_running(proxy_service).await?;
    let origin = proxy_origin(&proxy_status.address, proxy_status.port);
    let previous = read_snapshot();
    let live = live_providers()?;
    let plans = plan_attach(&previous, &origin, &live);
    if plans.is_empty() {
        return Err("DSH 里没有可接管的供应商（需要先有 baseURL）".to_string());
    }

    // 第一步：把「将要被改写」的全部条目记进账本（宁多记，恢复时按当前值比对跳过）。
    let mut snapshot = DshRelaySnapshot {
        attached: true,
        base_url: Some(origin.clone()),
        providers: plans.iter().map(AttachPlan::entry).collect(),
    };
    write_snapshot(&snapshot)?;

    // 第二步：逐条改原生配置。写失败的从账本里摘掉——它没被动过，继续走原始地址。
    let mut failed: Vec<String> = Vec::new();
    for plan in &plans {
        if let Err(error) = write_base_url(&plan.provider_id, plan.source, &plan.relay_base_url) {
            log::warn!(
                "[DSH-Relay] 接管供应商 `{}` 失败: {error}",
                plan.provider_id
            );
            failed.push(plan.provider_id.clone());
        }
    }
    if !failed.is_empty() {
        snapshot
            .providers
            .retain(|entry| !failed.contains(&entry.provider_id));
        if snapshot.providers.is_empty() {
            // 一个都没写成：账本清掉，别让退出钩子去「恢复」没被动过的配置。
            let _ = write_snapshot(&DshRelaySnapshot::default());
            refresh_targets();
            return Err("接管 DSH 供应商地址失败，已保持原样".to_string());
        }
        if let Err(error) = write_snapshot(&snapshot) {
            // 多记几条无害：恢复时比对不到中转地址就跳过。
            log::warn!("[DSH-Relay] 更新接管账本失败（多记的条目会被自动跳过）: {error}");
        }
    }

    refresh_targets();
    log::info!(
        "[DSH-Relay] 已接管 {} 个 DSH 供应商 -> {origin}/dsh/*",
        snapshot.providers.len()
    );
    Ok(status())
}

/// 逐条把中转地址换回原始地址，返回「没能换回去」的条目。
///
/// 只在当前值确实等于记录的中转地址时才改回——用户在 DSH 里手改过就不覆盖。
fn restore_original(
    snapshot: &DshRelaySnapshot,
    live: &[(String, LiveProvider)],
    mut write: impl FnMut(&str, NativeProviderSource, &str) -> Result<(), String>,
) -> Vec<DshRelayProvider> {
    let mut leftovers = Vec::new();
    for provider in snapshot.providers.iter().filter(|entry| entry.relayed) {
        let Some(original) = provider
            .original_base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(relay_base_url) = provider
            .relay_base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some((_, current)) = live
            .iter()
            .find(|(provider_id, _)| provider_id == &provider.provider_id)
        else {
            log::warn!(
                "[DSH-Relay] 供应商 `{}` 已不在 DSH 配置里，跳过恢复",
                provider.provider_id
            );
            continue;
        };
        if current.base_url.as_deref() != Some(relay_base_url) {
            log::info!(
                "[DSH-Relay] 供应商 `{}` 的地址已不是中转地址，跳过恢复",
                provider.provider_id
            );
            continue;
        }
        if let Err(error) = write(&provider.provider_id, current.source, original) {
            log::warn!(
                "[DSH-Relay] 恢复供应商 `{}` 的原始地址失败: {error}",
                provider.provider_id
            );
            leftovers.push(provider.clone());
        }
    }
    leftovers
}

/// 取消接管：把当初改成中转地址的供应商换回原始地址。
///
/// 部分失败时**不清账本**：只把失败的条目留在账本里（`attached` 保持 true），
/// 退出钩子和下次启动自检会继续重试；否则原始地址就再也找不回来了。
pub fn detach() -> Result<DshRelaySnapshot, String> {
    let snapshot = read_snapshot();
    if snapshot.providers.is_empty() {
        if snapshot.attached {
            write_snapshot(&DshRelaySnapshot::default())?;
        }
        return Ok(status());
    }

    // 读不到 DSH 配置就别动账本，否则原始地址会随着一次读失败一起消失。
    let live = live_providers()?;
    let leftovers = restore_original(&snapshot, &live, |provider_id, source, base_url| {
        write_base_url(provider_id, source, base_url)
    });

    if leftovers.is_empty() {
        write_snapshot(&DshRelaySnapshot::default())?;
        log::info!("[DSH-Relay] 已恢复 DSH 的原始地址");
        return Ok(status());
    }

    let retry = DshRelaySnapshot {
        attached: true,
        base_url: snapshot.base_url.clone(),
        providers: leftovers,
    };
    write_snapshot(&retry)?;
    log::warn!(
        "[DSH-Relay] {} 个 DSH 供应商的原始地址没换回来，下次启动重试",
        retry.providers.len()
    );
    Ok(status())
}

/// 启动自检：**按设置里的开关决定**，不以账本里的 `attached` 为准。
///
/// 正常退出会清账本（`attached=false`），所以只看 `attached` 的话，开机后开关还开着
/// 但 DSH 已经直连了，用户得手动关一次再开一次才能回到接管态。
pub async fn heal_on_startup(proxy_service: &ProxyService) {
    let (relay_enabled, _) = crate::settings::get_dsh_relay_flags();
    if relay_enabled {
        // 开关就是状态：不管上次留没留账本，都按当前端口重新接管（attach 幂等）。
        match attach(proxy_service).await {
            Ok(_) => log::info!("[DSH-Relay] 启动自检：已按当前端口接管 DSH"),
            Err(error) => {
                log::warn!("[DSH-Relay] 启动自检接管失败，改为恢复原始地址: {error}");
                if let Err(error) = detach() {
                    log::warn!("[DSH-Relay] 启动自检恢复原始地址失败: {error}");
                }
                // 开关必须写回 false：界面完全按服务端状态渲染，不能显示「开着」却没接管。
                if let Err(error) = crate::settings::set_dsh_relay_enabled(false) {
                    log::warn!("[DSH-Relay] 写回 DSH 中转开关失败: {error}");
                }
            }
        }
        return;
    }

    if read_snapshot().attached {
        log::info!("[DSH-Relay] 启动自检：开关已关，换回原始地址");
        if let Err(error) = detach() {
            log::warn!("[DSH-Relay] 启动自检恢复原始地址失败: {error}");
        }
        return;
    }

    refresh_targets();
}

/// 接管期间用户在 CC Switch 里改供应商地址：把用户填的地址记成原始地址，
/// 返回真正该写进 DSH 的中转地址。
///
/// 返回 `None` 表示「照常写原值」：未接管、地址为空、记账失败，或者调用方传进来的
/// 本来就是个中转地址（原生配置被同步回数据库后很常见，此时原始地址只能查账本）。
pub fn redirect_base_url(provider_id: &str, name: &str, desired_base_url: &str) -> Option<String> {
    let desired = desired_base_url.trim();
    let mut snapshot = read_snapshot();
    if !snapshot.attached {
        return None;
    }
    let relay_base_url = plan_redirect(&mut snapshot, provider_id, name, desired)?;
    if let Err(error) = write_snapshot(&snapshot) {
        // 记不住原始地址就别改：宁可这一次直连，也不能让退出时还原成错地址。
        log::warn!("[DSH-Relay] 记录 DSH 原始地址失败，本次不改写: {error}");
        return None;
    }
    refresh_targets();
    Some(relay_base_url)
}

/// `redirect_base_url` 的纯逻辑部分：更新账本，返回要写进 DSH 的中转地址。
fn plan_redirect(
    snapshot: &mut DshRelaySnapshot,
    provider_id: &str,
    name: &str,
    desired: &str,
) -> Option<String> {
    let desired = desired.trim();
    // 没有地址就说明这个供应商不该有 baseURL，别凭空塞一个。
    if desired.is_empty() {
        return None;
    }
    let origin = snapshot.base_url.as_deref()?.trim_end_matches('/');
    if origin.is_empty() {
        return None;
    }
    let relay_base_url = format!("{origin}/dsh/{provider_id}");
    let existing = snapshot
        .providers
        .iter()
        .position(|entry| entry.provider_id == provider_id);
    if desired == relay_base_url && existing.is_some() {
        // 保存的本来就是当前中转地址：账本里的原始地址不能被它覆盖。
        return Some(relay_base_url);
    }
    let original = if is_relay_url(desired) {
        // 旧端口的中转地址 / 从原生配置同步回来的值：原始地址只能查账本。
        snapshot
            .providers
            .iter()
            .find(|entry| entry.provider_id == provider_id)
            .and_then(|entry| entry.original_base_url.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty() && !is_relay_url(value))
            .map(ToOwned::to_owned)?
    } else {
        desired.to_string()
    };

    match existing.map(|index| &mut snapshot.providers[index]) {
        Some(entry) => {
            entry.name = name.to_string();
            entry.original_base_url = Some(original);
            entry.relay_base_url = Some(relay_base_url.clone());
            entry.relayed = true;
        }
        None => snapshot.providers.push(DshRelayProvider {
            provider_id: provider_id.to_string(),
            name: name.to_string(),
            original_base_url: Some(original),
            relay_base_url: Some(relay_base_url.clone()),
            relayed: true,
        }),
    }
    Some(relay_base_url)
}

async fn ensure_running(proxy_service: &ProxyService) -> Result<ProxyStatus, String> {
    let mut status = proxy_service.get_status().await?;
    if !status.running {
        log::info!("[DSH-Relay] 本地代理未运行，为接管 DSH 启动它");
        proxy_service.start().await?;
        status = proxy_service.get_status().await?;
    }
    if !status.running || status.port == 0 {
        return Err("本地代理没能启动，DSH 接管失败".to_string());
    }
    Ok(status)
}

/// 只改 `baseURL`，其余字段（含注释、其它条目）由 patch 层原样保留。
fn write_base_url(
    provider_id: &str,
    source: NativeProviderSource,
    base_url: &str,
) -> Result<(), String> {
    let path = dsh::get_patch_path();
    let value = Value::String(base_url.to_string());
    match source {
        NativeProviderSource::DeepSeek => update_entry(
            &path,
            patch::OFFICIAL_ENTRY_ID,
            patch::OFFICIAL_ENTRY_NAME,
            |config| {
                config.insert(BASE_URL_FIELD.to_string(), value);
                Ok(())
            },
        ),
        NativeProviderSource::PiAi => update_entry(
            &path,
            patch::PI_AI_ENTRY_ID,
            patch::PI_AI_ENTRY_NAME,
            |config| {
                let providers = config
                    .get_mut("providers")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| {
                        AppError::Config(
                            "DeepSeek Harness 的 `llm-pi-ai` 条目缺少 providers 映射".to_string(),
                        )
                    })?;
                let entry = providers
                    .get_mut(provider_id)
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| {
                        AppError::Config(format!(
                            "DeepSeek Harness 的 `llm-pi-ai` 条目里没有供应商 `{provider_id}`"
                        ))
                    })?;
                entry.insert(BASE_URL_FIELD.to_string(), value);
                Ok(())
            },
        ),
    }
}

/// 读-改-写单条 patch 条目。与 `deepseek_harness_config` 里的私有实现同构：Harness 自己
/// 也写这个文件，所以每次都重新读，只替换 CC Switch 拥有的子树。
fn update_entry(
    path: &std::path::Path,
    entry_id: &str,
    entry_name: &str,
    mutate: impl FnOnce(&mut Map<String, Value>) -> Result<(), AppError>,
) -> Result<(), String> {
    let mut config = match patch::read_entry_config(path, entry_id) {
        Ok(Some(Value::Object(map))) => map,
        Ok(Some(_)) => {
            return Err(format!(
                "DeepSeek Harness patch entry `{entry_id}` 不是 YAML 映射"
            ))
        }
        Ok(None) => Map::new(),
        Err(error) => return Err(format!("读取 patch 条目 `{entry_id}` 失败: {error}")),
    };
    mutate(&mut config).map_err(|error| error.to_string())?;
    patch::write_entry_config(path, entry_id, entry_name, &Value::Object(config))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(
        provider_id: &str,
        name: &str,
        source: NativeProviderSource,
        base_url: Option<&str>,
    ) -> (String, LiveProvider) {
        (
            provider_id.to_string(),
            LiveProvider {
                name: name.to_string(),
                source,
                base_url: base_url.map(ToOwned::to_owned),
                api: Some("openai-completions".to_string()),
                api_key: Some("sk-test".to_string()),
            },
        )
    }

    fn entry(provider_id: &str, original: &str, relay: &str) -> DshRelayProvider {
        DshRelayProvider {
            provider_id: provider_id.to_string(),
            name: provider_id.to_string(),
            original_base_url: Some(original.to_string()),
            relay_base_url: Some(relay.to_string()),
            relayed: true,
        }
    }

    fn ledger(origin: &str, providers: Vec<DshRelayProvider>) -> DshRelaySnapshot {
        DshRelaySnapshot {
            attached: true,
            base_url: Some(origin.to_string()),
            providers,
        }
    }

    #[test]
    fn detects_relay_urls() {
        assert!(is_relay_url("http://127.0.0.1:15721/dsh/deepseek-official"));
        assert!(is_relay_url("http://localhost:15721/dsh/pi/v1"));
        assert!(is_relay_url("http://[::1]:15721/dsh/pi"));
        assert!(!is_relay_url("https://api.deepseek.com"));
        assert!(!is_relay_url("http://127.0.0.1:11434/v1"));
        // 上游自己的路径里带 /dsh/ 也不算中转
        assert!(!is_relay_url("https://example.com/dsh/deepseek-official"));
    }

    #[test]
    fn snapshot_serializes_to_frontend_shape() {
        let snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "deepseek-official",
                "https://api.deepseek.com/anthropic",
                "http://127.0.0.1:15721/dsh/deepseek-official",
            )],
        );
        let json = serde_json::to_value(&snapshot).expect("snapshot is serializable");
        assert_eq!(json["attached"], Value::Bool(true));
        assert_eq!(json["baseUrl"], Value::from("http://127.0.0.1:15721"));
        assert_eq!(
            json["providers"][0]["originalBaseUrl"],
            Value::from("https://api.deepseek.com/anthropic")
        );
        assert_eq!(
            json["providers"][0]["relayBaseUrl"],
            Value::from("http://127.0.0.1:15721/dsh/deepseek-official")
        );
        assert_eq!(
            json["providers"][0]["providerId"],
            Value::from("deepseek-official")
        );
        assert_eq!(json["providers"][0]["relayed"], Value::Bool(true));
        assert_eq!(
            serde_json::from_value::<DshRelaySnapshot>(json).expect("round trip"),
            snapshot
        );
    }

    #[test]
    fn snapshot_tolerates_missing_fields() {
        let empty: DshRelaySnapshot = serde_json::from_str("{}").expect("empty object parses");
        assert!(!empty.attached);
        assert!(empty.base_url.is_none());
        assert!(empty.providers.is_empty());
        // 前端字段可空：缺 originalBaseUrl / relayBaseUrl 也要能解析
        let partial: DshRelaySnapshot =
            serde_json::from_str(r#"{"attached":true,"providers":[{"providerId":"x"}]}"#)
                .expect("partial provider parses");
        assert_eq!(partial.providers.len(), 1);
        assert!(partial.providers[0].original_base_url.is_none());
        assert!(partial.providers[0].relay_base_url.is_none());
        assert!(!partial.providers[0].relayed);
    }

    /// 每个供应商都是全量现状：接管的那条显示中转地址，没接管的显示原始地址。
    #[test]
    fn status_lists_every_live_provider() {
        let snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        let live = vec![
            live(
                "company",
                "Company",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/company"),
            ),
            live(
                "spare",
                "Spare",
                NativeProviderSource::PiAi,
                Some("https://spare.example/v1"),
            ),
            live("no-url", "NoUrl", NativeProviderSource::PiAi, None),
        ];
        let status = build_status(&snapshot, &live);
        assert!(status.attached);
        assert_eq!(status.providers.len(), 3);

        let company = &status.providers[0];
        assert!(company.relayed);
        assert_eq!(
            company.original_base_url.as_deref(),
            Some("https://gateway.example/v1")
        );
        assert_eq!(
            company.relay_base_url.as_deref(),
            Some("http://127.0.0.1:15721/dsh/company")
        );

        let spare = &status.providers[1];
        assert!(!spare.relayed);
        assert_eq!(
            spare.original_base_url.as_deref(),
            Some("https://spare.example/v1")
        );
        assert!(spare.relay_base_url.is_none());

        let no_url = &status.providers[2];
        assert!(!no_url.relayed);
        assert!(no_url.original_base_url.is_none());

        // 未接管时不会有人被标成中转
        let detached = build_status(&DshRelaySnapshot::default(), &live);
        assert!(detached.providers.iter().all(|entry| !entry.relayed));
    }

    /// 重复接管（同一端口）不能把中转地址记成原始地址。
    #[test]
    fn plan_attach_keeps_the_recorded_original_on_repeated_attach() {
        let previous = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        let live = vec![live(
            "company",
            "Company",
            NativeProviderSource::PiAi,
            Some("http://127.0.0.1:15721/dsh/company"),
        )];
        let plans = plan_attach(&previous, "http://127.0.0.1:15721", &live);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
        assert_eq!(
            plans[0].relay_base_url,
            "http://127.0.0.1:15721/dsh/company"
        );

        // 换端口再接管一次：原始地址依然是用户当初填的那个
        let plans = plan_attach(&previous, "http://127.0.0.1:18888/", &live);
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
        assert_eq!(
            plans[0].relay_base_url,
            "http://127.0.0.1:18888/dsh/company"
        );
    }

    /// 直接地址照原样记；已经挂着中转地址却没账本的，宁可不接管。
    #[test]
    fn plan_attach_records_direct_addresses_and_skips_unrecoverable() {
        let live = vec![
            live(
                "company",
                "Company",
                NativeProviderSource::PiAi,
                Some("https://gateway.example/v1"),
            ),
            live("no-url", "NoUrl", NativeProviderSource::PiAi, None),
            live(
                "orphan",
                "Orphan",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/orphan"),
            ),
        ];
        let plans = plan_attach(
            &DshRelaySnapshot::default(),
            "http://127.0.0.1:15721",
            &live,
        );
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].provider_id, "company");
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
    }

    /// 部分恢复失败：账本只留失败的那几条，成功的不能再被写第二次。
    #[test]
    fn restore_original_keeps_only_failed_entries() {
        let snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![
                entry(
                    "ok",
                    "https://ok.example/v1",
                    "http://127.0.0.1:15721/dsh/ok",
                ),
                entry(
                    "broken",
                    "https://broken.example/v1",
                    "http://127.0.0.1:15721/dsh/broken",
                ),
                // 用户手改过地址：不是中转地址，跳过（不写、也不算失败）
                entry(
                    "edited",
                    "https://edited.example/v1",
                    "http://127.0.0.1:15721/dsh/edited",
                ),
                // 已经从 DSH 里删掉：跳过
                entry(
                    "gone",
                    "https://gone.example/v1",
                    "http://127.0.0.1:15721/dsh/gone",
                ),
            ],
        );
        let live = vec![
            live(
                "ok",
                "Ok",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/ok"),
            ),
            live(
                "broken",
                "Broken",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/broken"),
            ),
            live(
                "edited",
                "Edited",
                NativeProviderSource::PiAi,
                Some("https://other.example/v1"),
            ),
        ];
        let mut writes = Vec::new();
        let leftovers = restore_original(&snapshot, &live, |provider_id, _, base_url| {
            writes.push((provider_id.to_string(), base_url.to_string()));
            if provider_id == "broken" {
                return Err("磁盘只读".to_string());
            }
            Ok(())
        });

        assert_eq!(
            writes,
            vec![
                ("ok".to_string(), "https://ok.example/v1".to_string()),
                (
                    "broken".to_string(),
                    "https://broken.example/v1".to_string()
                ),
            ]
        );
        assert_eq!(leftovers.len(), 1);
        assert_eq!(leftovers[0].provider_id, "broken");
        assert_eq!(
            leftovers[0].original_base_url.as_deref(),
            Some("https://broken.example/v1")
        );
    }

    /// 接管期间改地址：用户填的记成原始地址，实际写进 DSH 的是中转地址。
    #[test]
    fn plan_redirect_records_the_user_address_and_returns_the_relay_url() {
        let mut snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        let relay = plan_redirect(
            &mut snapshot,
            "company",
            "Company",
            "  https://gateway2.example/v1  ",
        );
        assert_eq!(relay.as_deref(), Some("http://127.0.0.1:15721/dsh/company"));
        assert_eq!(
            snapshot.providers[0].original_base_url.as_deref(),
            Some("https://gateway2.example/v1")
        );
        assert_eq!(snapshot.providers.len(), 1);
    }

    /// 保存的本来就是中转地址（原生配置同步回数据库后的常见情况）：原始地址必须保留。
    #[test]
    fn plan_redirect_never_overwrites_the_original_with_a_relay_url() {
        let mut snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        // 旧端口的中转地址
        let relay = plan_redirect(
            &mut snapshot,
            "company",
            "Company",
            "http://127.0.0.1:9999/dsh/company",
        );
        assert_eq!(relay.as_deref(), Some("http://127.0.0.1:15721/dsh/company"));
        assert_eq!(
            snapshot.providers[0].original_base_url.as_deref(),
            Some("https://gateway.example/v1")
        );
        // 当前端口的中转地址：同样不能覆盖
        plan_redirect(
            &mut snapshot,
            "company",
            "Company",
            "http://127.0.0.1:15721/dsh/company",
        );
        assert_eq!(
            snapshot.providers[0].original_base_url.as_deref(),
            Some("https://gateway.example/v1")
        );
    }

    /// 未接管 / 没有地址 / 没记录可查：一律不动，调用方照常写原值。
    #[test]
    fn plan_redirect_bails_out_when_it_cannot_be_trusted() {
        let mut detached = DshRelaySnapshot::default();
        assert!(plan_redirect(
            &mut detached,
            "company",
            "Company",
            "https://gateway.example/v1"
        )
        .is_none());

        let mut snapshot = ledger("http://127.0.0.1:15721", Vec::new());
        // 空地址：不凭空造 baseURL
        assert!(plan_redirect(&mut snapshot, "company", "Company", "   ").is_none());
        // 中转地址但账本里没有它：还原不了，别接管
        assert!(plan_redirect(
            &mut snapshot,
            "company",
            "Company",
            "http://127.0.0.1:15721/dsh/company"
        )
        .is_none());
        assert!(snapshot.providers.is_empty());

        // 新供应商：账本里补一条
        let relay = plan_redirect(&mut snapshot, "fresh", "Fresh", "https://fresh.example/v1");
        assert_eq!(relay.as_deref(), Some("http://127.0.0.1:15721/dsh/fresh"));
        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(
            snapshot.providers[0].original_base_url.as_deref(),
            Some("https://fresh.example/v1")
        );
    }
}
