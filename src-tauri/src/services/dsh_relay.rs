//! DSH 中转接管
//!
//! 接管时把 DeepSeek Harness 每个供应商的 `baseURL` 改写成本机代理的
//! `http://127.0.0.1:<port>/dsh/<provider_id>`，退出 CC Switch 时再换回原始地址——
//! 这样关掉 CC Switch 也能直接用 DSH（不依赖本机的转发进程）。
//!
//! 原始地址记在 `<app config dir>/dsh_relay_state.json`（下称「账本」）：进程被强杀时下次
//! 启动还能照着恢复。恢复不靠「账本里的中转地址和文件里的值相等」这种字符串比对——只看
//! **当前地址是不是中转地址**（回环 + `/dsh/`），因为账本和文件迟早会不同步（端口变了、
//! 账本被清过）。用户在 DSH 里手改的直连地址不匹配，不会被覆盖。
//!
//! 三条不变式：
//! - 账本先于原生配置落盘；接管时把上一轮的条目一起带上，原始地址只增不减。
//! - 恢复成功也**不清账本**，只把 `attached` 放下来：条目继续当原始地址台账，文件以后又被
//!   写回中转地址时还能照着恢复；查不到原始地址的条目留着，下次启动/退出继续重试。
//! - 原始地址永远不能是另一个中转地址，否则退出时会把死端口写回 DSH。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::{atomic_write_private, get_app_config_dir};
use crate::database::Database;
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

/// 只接受「非空且不是中转地址」的地址：原始地址一旦本身是中转地址，退出时就会把死端口
/// 写回 DSH，那比不恢复更糟。
fn direct_url(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !is_relay_url(value)).then(|| value.to_string())
}

/// 账本里记着的原始地址。
fn ledger_original(snapshot: &DshRelaySnapshot, provider_id: &str) -> Option<String> {
    snapshot
        .providers
        .iter()
        .find(|entry| entry.provider_id == provider_id)
        .and_then(|entry| entry.original_base_url.as_deref())
        .and_then(direct_url)
}

/// 从中转地址里取出它指向的本机代理 origin（`http://127.0.0.1:15721`）。
fn relay_origin(base_url: &str) -> Option<String> {
    let url = url::Url::parse(base_url).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    Some(format!("{}://{host}:{port}", url.scheme()))
}

/// 是否处于接管状态。
///
/// 不只看账本：账本可能被上一版恢复失败时清掉，而文件里还留着中转地址——那种状态同样
/// 需要退出时救回来，否则用户就一直卡在中转端口上（真实反馈过的问题）。
pub fn is_attached() -> bool {
    if read_snapshot().attached {
        return true;
    }
    live_has_relay().unwrap_or(false)
}

/// DSH 里现在还有没有指向中转端口的地址。
fn live_has_relay() -> Result<bool, String> {
    Ok(live_providers()?
        .iter()
        .any(|(_, provider)| provider.base_url.as_deref().is_some_and(is_relay_url)))
}

/// 账本里记着的原始地址（接管期间把原生配置回流数据库时用）。
///
/// 不看 `attached`：接管标记丢了但账本条目还在的历史状态，也要拿它去修数据库里的中转地址。
pub fn recorded_original(provider_id: &str) -> Option<String> {
    ledger_original(&read_snapshot(), provider_id)
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
#[derive(Debug, Clone)]
struct LiveProvider {
    name: String,
    source: NativeProviderSource,
    base_url: Option<String>,
    api: Option<String>,
    api_key: Option<String>,
}

/// 读 DSH 原生配置。失败必须向上报——把「读不到」当成「供应商没了」会丢掉原始地址。
///
/// Windows 上 DSH 的 watcher（chokidar 的 `awaitWriteFinish` 轮询）、杀毒软件和索引器会
/// 短暂独占这个 YAML，读也会撞上共享冲突。一次读失败就返回 Err 的后果很严重：用户点「切回
/// 直连」会直接失败并停在原来的中转地址上，所以他点了等于没点。这里用短退避重试几次，
/// 把「文件正被占用」和「文件真的读不了」区分开。
fn live_providers() -> Result<Vec<(String, LiveProvider)>, String> {
    const ATTEMPTS: u32 = 6;
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        match read_live_providers() {
            Ok(live) => return Ok(live),
            Err(error) => {
                last = error;
                if attempt + 1 < ATTEMPTS {
                    log::debug!(
                        "[DSH-Relay] 读取 DSH 配置失败（第 {} 次），稍后重试: {last}",
                        attempt + 1
                    );
                    std::thread::sleep(std::time::Duration::from_millis(u64::from(
                        40 * (attempt + 1),
                    )));
                }
            }
        }
    }
    Err(last)
}

fn read_live_providers() -> Result<Vec<(String, LiveProvider)>, String> {
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
///
/// 「有没有在走中转」按**文件里的实际地址**算，不按账本算：账本和文件不同步时，
/// 界面必须显示真实情况（否则用户点了切回直连、界面说已断开，实际还在走中转）。
fn build_status(snapshot: &DshRelaySnapshot, live: &[(String, LiveProvider)]) -> DshRelaySnapshot {
    let any_relay = live
        .iter()
        .any(|(_, provider)| provider.base_url.as_deref().is_some_and(is_relay_url));
    let providers = live
        .iter()
        .map(|(provider_id, provider)| {
            let current = provider.base_url.clone().filter(|value| !value.is_empty());
            let relayed = current.as_deref().is_some_and(is_relay_url);
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
        // 文件里还有中转地址就算接管中：这样前端一定会给出「切回直连」的入口。
        attached: snapshot.attached || any_relay,
        // 账本丢了但地址还在中转时，从地址本身还原出代理 origin，别让界面显示空端口。
        base_url: snapshot.base_url.clone().or_else(|| {
            live.iter().find_map(|(_, provider)| {
                provider
                    .base_url
                    .as_deref()
                    .filter(|value| is_relay_url(value))
                    .and_then(relay_origin)
            })
        }),
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
/// 关键点：DSH 里已经是中转地址时**只能**沿用账本里的原始地址——重复接管绝不能把中转地址
/// 记成「原始地址」，否则退出时会把死端口写回 DSH。账本里没有（历史版本丢过账本）时再查
/// 数据库/备份（`resolve`）；仍然找不到就跳过这个供应商：宁可少接管一条，也不能记错原始地址。
fn plan_attach(
    previous: &DshRelaySnapshot,
    origin: &str,
    live: &[(String, LiveProvider)],
    resolve: impl Fn(&str, NativeProviderSource) -> Option<String>,
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
            Some(value) if is_relay_url(value) => {
                ledger_original(previous, provider_id).or_else(|| {
                    let resolved = resolve(provider_id, provider.source);
                    if resolved.is_some() {
                        log::info!(
                            "[DSH-Relay] 供应商 `{provider_id}` 的原始地址已从数据库/备份找回"
                        );
                    }
                    resolved
                })
            }
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
pub async fn attach(
    proxy_service: &ProxyService,
    database: Option<&Database>,
) -> Result<DshRelaySnapshot, String> {
    let proxy_status = ensure_running(proxy_service).await?;
    let origin = proxy_origin(&proxy_status.address, proxy_status.port);
    let previous = read_snapshot();
    let live = live_providers()?;
    let resolve = |provider_id: &str, source: NativeProviderSource| {
        resolve_original(provider_id, source, database)
    };
    let plans = plan_attach(&previous, &origin, &live, resolve);
    if plans.is_empty() {
        return Err("DSH 里没有可接管的供应商（需要先有 baseURL）".to_string());
    }

    // 第一步：把「将要被改写」的全部条目记进账本，再动配置。
    // 上一轮的账本条目也要带上：它们记着还没恢复成功的原始地址，丢掉就再也查不回来了。
    let carried = prune_journal(&previous, &live);
    let mut journal = carried
        .iter()
        .filter(|entry| {
            !plans
                .iter()
                .any(|plan| plan.provider_id == entry.provider_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    journal.extend(plans.iter().map(AttachPlan::entry));
    let mut snapshot = DshRelaySnapshot {
        attached: true,
        base_url: Some(origin.clone()),
        providers: journal,
    };
    write_snapshot(&snapshot)?;

    // 第二步：逐条改原生配置。
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
        // 写失败的供应商没被动过：把上一轮记着的原始地址放回去，别让一次写失败把台账抹掉。
        snapshot
            .providers
            .retain(|entry| !failed.contains(&entry.provider_id));
        for entry in carried
            .iter()
            .filter(|entry| failed.contains(&entry.provider_id))
        {
            let mut entry = entry.clone();
            entry.relayed = live
                .iter()
                .find(|(provider_id, _)| provider_id == &entry.provider_id)
                .and_then(|(_, provider)| provider.base_url.as_deref())
                .is_some_and(is_relay_url);
            snapshot.providers.push(entry);
        }
        if failed.len() == plans.len() {
            // 一个都没写成：把账本退回接管前的样子，别让退出钩子去「恢复」没被动过的配置。
            let _ = write_snapshot(&DshRelaySnapshot {
                attached: previous.attached,
                base_url: previous.base_url.clone(),
                providers: carried,
            });
            refresh_targets();
            return Err("接管 DSH 供应商地址失败，已保持原样".to_string());
        }
        if let Err(error) = write_snapshot(&snapshot) {
            log::warn!("[DSH-Relay] 更新接管账本失败: {error}");
        }
    }

    refresh_targets();
    log::info!(
        "[DSH-Relay] 已接管 {} 个 DSH 供应商 -> {origin}/dsh/*",
        plans.len() - failed.len()
    );
    Ok(status())
}

/// 一条要恢复的记录：哪个供应商、它的地址该换回什么。
#[derive(Debug, Clone)]
struct RestoreItem {
    provider_id: String,
    name: String,
    source: NativeProviderSource,
    original_base_url: String,
}

impl RestoreItem {
    fn leftover(&self) -> DshRelayProvider {
        DshRelayProvider {
            provider_id: self.provider_id.clone(),
            name: self.name.clone(),
            original_base_url: Some(self.original_base_url.clone()),
            relay_base_url: None,
            relayed: true,
        }
    }
}

/// 一次恢复的计划。
#[derive(Debug, Default)]
struct RestorePlan {
    /// 能换回直连的条目。
    items: Vec<RestoreItem>,
    /// 指向中转地址、但任何来源都查不到原始地址的条目：留着，等人工处理。
    unknown: Vec<DshRelayProvider>,
}

/// 算出这次要恢复谁。纯函数，方便单测。
///
/// 判定只看**当前地址是不是中转地址**，不再和账本里记的中转地址比对字符串。
/// 上一版正是因为「账本里的端口号和文件里的不一样」跳过了恢复、随后又把账本清空，
/// 地址就永久停在中转端口上了。用户在 DSH 里手改成的直连地址不受影响（不匹配就不动）。
fn plan_restore(
    snapshot: &DshRelaySnapshot,
    live: &[(String, LiveProvider)],
    resolve: impl Fn(&str, NativeProviderSource) -> Option<String>,
) -> RestorePlan {
    let mut plan = RestorePlan::default();
    for (provider_id, provider) in live {
        let Some(current) = provider
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !is_relay_url(current) {
            continue;
        }
        let original = ledger_original(snapshot, provider_id)
            .or_else(|| resolve(provider_id, provider.source));
        match original {
            Some(original_base_url) => plan.items.push(RestoreItem {
                provider_id: provider_id.clone(),
                name: provider.name.clone(),
                source: provider.source,
                original_base_url,
            }),
            None => {
                log::warn!(
                    "[DSH-Relay] 供应商 `{provider_id}` 指向中转地址，但账本、数据库和备份里都查不到原始地址"
                );
                plan.unknown.push(DshRelayProvider {
                    provider_id: provider_id.clone(),
                    name: provider.name.clone(),
                    original_base_url: None,
                    relay_base_url: Some(current.to_string()),
                    relayed: true,
                });
            }
        }
    }
    plan
}

/// 恢复的重试轮数。Windows 上目标文件常被 Harness 的 watcher 占着，一次写不成很正常。
const RESTORE_ROUNDS: usize = 3;

/// 执行恢复计划：逐条写回原始地址，然后**回读核对**。
///
/// 只写一次就宣布成功是不够的——写失败、或者别的进程把文件覆盖回去，用户明明点了「切回
/// 直连」而 DSH 还在走中转。所以每一轮写完都回读文件，剩下的下一轮再写；最后仍然指向中转
/// 的条目作为 leftovers 交回调用方，写进账本留档，退出/下次启动继续重试。
fn run_restore(
    plan: RestorePlan,
    write: impl Fn(&str, NativeProviderSource, &str) -> Result<(), String>,
    read_live: impl Fn() -> Result<Vec<(String, LiveProvider)>, String>,
) -> (usize, Vec<DshRelayProvider>) {
    let mut pending = plan.items;
    let mut leftovers = plan.unknown;
    let mut restored = 0usize;

    for round in 0..RESTORE_ROUNDS {
        if pending.is_empty() {
            break;
        }
        if round > 0 {
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        for item in &pending {
            if let Err(error) = write(&item.provider_id, item.source, &item.original_base_url) {
                log::warn!(
                    "[DSH-Relay] 恢复供应商 `{}` 的原始地址失败（第 {} 轮）: {error}",
                    item.provider_id,
                    round + 1
                );
            }
        }
        // 以文件里的实际值为准，不信写操作自己的返回值。
        let live = match read_live() {
            Ok(live) => live,
            Err(error) => {
                log::warn!("[DSH-Relay] 恢复后回读 DSH 配置失败，下一轮再核对: {error}");
                continue;
            }
        };
        let mut retry = Vec::new();
        for item in std::mem::take(&mut pending) {
            let current = live
                .iter()
                .find(|(provider_id, _)| provider_id == &item.provider_id)
                .and_then(|(_, provider)| provider.base_url.clone())
                .filter(|value| !value.is_empty());
            if current.as_deref().is_some_and(is_relay_url) {
                retry.push(item);
            } else {
                restored += 1;
            }
        }
        pending = retry;
    }

    leftovers.extend(pending.iter().map(RestoreItem::leftover));
    (restored, leftovers)
}

/// 账本里还值得留的条目：供应商还在 DSH 配置里。
///
/// 不在的恢复不了，留着只会让状态变脏；恢复成功的把 `relayed` 放下（它们现在是直连），
/// 条目继续留作原始地址台账。
fn prune_journal(
    snapshot: &DshRelaySnapshot,
    live: &[(String, LiveProvider)],
) -> Vec<DshRelayProvider> {
    snapshot
        .providers
        .iter()
        .filter(|entry| {
            live.iter()
                .any(|(provider_id, _)| provider_id == &entry.provider_id)
        })
        .map(|entry| DshRelayProvider {
            relayed: false,
            relay_base_url: None,
            ..entry.clone()
        })
        .collect()
}

/// 取消接管：把 DSH 里所有**指向中转端口**的地址换回原始地址。
///
/// 恢复范围不只账本里的条目：账本被清空、或者文件被改回中转地址的历史状态，也在这里一并
/// 救回来（原始地址依次查账本 → 数据库 → patch 备份 → Harness 的 recovery 目录）。
/// 只有真的换来回了才放下 `attached`；换不回来的留在账本里（`attached` 保持 true）等下次重试。
///
/// `database` 是可选的兜底来源：账本丢失时用它找原始地址，拿不到就只能记进 leftovers。
pub fn detach_with(database: Option<&Database>) -> Result<DshRelaySnapshot, String> {
    let snapshot = read_snapshot();
    // 读不到 DSH 配置就别动账本，否则原始地址会随着一次读失败一起消失。
    let live = live_providers()?;
    let resolve = |provider_id: &str, source: NativeProviderSource| {
        resolve_original(provider_id, source, database)
    };
    let plan = plan_restore(&snapshot, &live, resolve);

    if plan.items.is_empty() && plan.unknown.is_empty() {
        if snapshot.attached {
            let journal = prune_journal(&snapshot, &live);
            write_snapshot(&DshRelaySnapshot {
                attached: false,
                base_url: None,
                providers: journal,
            })?;
            log::info!("[DSH-Relay] DSH 里已经是直连地址，账本标记为未接管");
        }
        refresh_targets();
        return Ok(status());
    }

    let (restored, leftovers) = run_restore(plan, write_base_url, live_providers);

    // 账本永远不清空：条目留着当「原始地址台账」。万一 Harness 之后又把这个文件写回中转
    // 地址，下次自检还能照着台账再恢复一遍；清掉就永久丢了。
    let mut journal = prune_journal(&snapshot, &live)
        .into_iter()
        .filter(|entry| {
            !leftovers
                .iter()
                .any(|leftover| leftover.provider_id == entry.provider_id)
        })
        .collect::<Vec<_>>();
    journal.extend(leftovers.iter().cloned());
    let attached = !leftovers.is_empty();
    write_snapshot(&DshRelaySnapshot {
        attached,
        base_url: snapshot.base_url.clone(),
        providers: journal,
    })?;
    refresh_targets();

    if attached {
        log::warn!(
            "[DSH-Relay] {} 个 DSH 供应商的原始地址没换回来（已恢复 {restored} 个），下次启动/退出继续重试",
            leftovers.len()
        );
    } else {
        log::info!("[DSH-Relay] 已恢复 {restored} 个 DSH 供应商的原始地址");
    }
    Ok(status())
}

/// 原始地址的外部来源，按可靠性排序：CC Switch 数据库 → patch 备份 → Harness 自己的恢复副本。
///
/// 只会在账本里查不到时用（账本丢失、或者接管前的记录被上一版抹掉）。
fn resolve_original(
    provider_id: &str,
    source: NativeProviderSource,
    database: Option<&Database>,
) -> Option<String> {
    database_original(provider_id, database)
        .or_else(|| {
            entry_base_url(
                &patch::backup_path(&dsh::get_patch_path()),
                source,
                provider_id,
            )
        })
        .or_else(|| recovery_original(provider_id, source))
}

/// CC Switch 数据库里那条 DSH 供应商的 `baseURL`。
///
/// DSH 写配置只改单行、且接管期间 `sync_native_locked` 会用账本里的原始地址修数据库，
/// 所以这里的值基本总是干净的。只在账本缺失时作为兜底，不当成唯一真相。
fn database_original(provider_id: &str, database: Option<&Database>) -> Option<String> {
    let database = database?;
    let providers =
        match database.get_all_providers(crate::app_config::AppType::DeepSeekHarness.as_str()) {
            Ok(providers) => providers,
            Err(error) => {
                log::warn!("[DSH-Relay] 读取数据库里的 DSH 供应商失败: {error}");
                return None;
            }
        };
    providers
        .get(provider_id)?
        .settings_config
        .get(BASE_URL_FIELD)
        .and_then(Value::as_str)
        .and_then(direct_url)
}

/// Harness 自己在 `$DSH_HOME/recovery/` 留的配置副本（新→旧）。
fn recovery_original(provider_id: &str, source: NativeProviderSource) -> Option<String> {
    let file_name = dsh::get_patch_path().file_name()?.to_owned();
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dsh::get_dsh_home().join("recovery"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(&file_name))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
    });
    candidates.reverse();
    candidates
        .iter()
        .find_map(|path| entry_base_url(path, source, provider_id))
}

/// 从某个 patch 文件里读一个供应商的 `baseURL`。
fn entry_base_url(
    path: &std::path::Path,
    source: NativeProviderSource,
    provider_id: &str,
) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let config = patch::read_entry_config(
        path,
        match source {
            NativeProviderSource::DeepSeek => patch::OFFICIAL_ENTRY_ID,
            NativeProviderSource::PiAi => patch::PI_AI_ENTRY_ID,
        },
    )
    .ok()??;
    let value = match source {
        NativeProviderSource::DeepSeek => config.get(BASE_URL_FIELD)?.as_str()?,
        NativeProviderSource::PiAi => config
            .get("providers")?
            .get(provider_id)?
            .get(BASE_URL_FIELD)?
            .as_str()?,
    };
    direct_url(value)
}

/// 启动自检：**按设置里的开关决定**，不以账本里的 `attached` 为准。
///
/// 正常退出会清账本（`attached=false`），所以只看 `attached` 的话，开机后开关还开着
/// 但 DSH 已经直连了，用户得手动关一次再开一次才能回到接管态。
///
/// 开关关着时也要扫一遍原生配置：账本丢过、文件里却还是中转地址的状态必须在这里救回来，
/// 否则 DSH 会一直连一个没启动的端口。
pub async fn heal_on_startup(proxy_service: &ProxyService, database: &Database) {
    let (relay_enabled, _) = crate::settings::get_dsh_relay_flags();
    if relay_enabled {
        // 开关就是状态：不管上次留没留账本，都按当前端口重新接管（attach 幂等）。
        match attach(proxy_service, Some(database)).await {
            Ok(_) => log::info!("[DSH-Relay] 启动自检：已按当前端口接管 DSH"),
            Err(error) => {
                log::warn!("[DSH-Relay] 启动自检接管失败，改为恢复原始地址: {error}");
                if let Err(error) = detach_with(Some(database)) {
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

    let orphaned = read_snapshot().attached || live_has_relay().unwrap_or(false);
    if orphaned {
        log::info!("[DSH-Relay] 启动自检：开关已关，换回原始地址");
        if let Err(error) = detach_with(Some(database)) {
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

    fn live_entry(
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
            live_entry(
                "company",
                "Company",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/company"),
            ),
            live_entry(
                "spare",
                "Spare",
                NativeProviderSource::PiAi,
                Some("https://spare.example/v1"),
            ),
            live_entry("no-url", "NoUrl", NativeProviderSource::PiAi, None),
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

        // 账本空着但文件里还是中转地址：状态必须照实说「在走中转」，
        // 否则界面会显示直连、退出时也不会去还原（老版本就是这么把地址丢在死端口上的）。
        let detached = build_status(&DshRelaySnapshot::default(), &live);
        assert!(detached.attached);
        assert!(detached.providers[0].relayed);
        assert_eq!(
            detached.base_url.as_deref(),
            Some("http://127.0.0.1:15721"),
            "文件里认得出中转地址时，状态要能给出当前端口"
        );
        assert!(!detached.providers[1].relayed);
        assert!(!detached.providers[2].relayed);
    }

    /// 判定只看「回环 + `/dsh/`」，端口变了也照样认出来。
    #[test]
    fn detects_relay_urls_on_any_port() {
        assert!(is_relay_url("http://127.0.0.1:18888/dsh/company"));
        assert!(is_relay_url("http://127.0.0.1:1/dsh/company"));
        assert!(!is_relay_url("http://127.0.0.1:18888/v1"));
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
        let live = vec![live_entry(
            "company",
            "Company",
            NativeProviderSource::PiAi,
            Some("http://127.0.0.1:15721/dsh/company"),
        )];
        let no_lookup = |_: &str, _: NativeProviderSource| None;
        let plans = plan_attach(&previous, "http://127.0.0.1:15721", &live, no_lookup);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
        assert_eq!(
            plans[0].relay_base_url,
            "http://127.0.0.1:15721/dsh/company"
        );

        // 换端口再接管一次：原始地址依然是用户当初填的那个
        let plans = plan_attach(&previous, "http://127.0.0.1:18888/", &live, no_lookup);
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
            live_entry(
                "company",
                "Company",
                NativeProviderSource::PiAi,
                Some("https://gateway.example/v1"),
            ),
            live_entry("no-url", "NoUrl", NativeProviderSource::PiAi, None),
            live_entry(
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
            |_, _| None,
        );
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].provider_id, "company");
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
    }

    /// 账本丢了、地址还在中转：靠数据库/备份里的原始地址照样能接管（线上真实出现过）。
    #[test]
    fn plan_attach_falls_back_to_the_resolver_when_the_ledger_is_gone() {
        let live = vec![
            live_entry(
                "company",
                "Company",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/company"),
            ),
            live_entry(
                "unknown",
                "Unknown",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/unknown"),
            ),
        ];
        let plans = plan_attach(
            &DshRelaySnapshot::default(),
            "http://127.0.0.1:15721",
            &live,
            |provider_id, _| {
                (provider_id == "company").then(|| "https://gateway.example/v1".to_string())
            },
        );
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].provider_id, "company");
        assert_eq!(plans[0].original_base_url, "https://gateway.example/v1");
        // 一个来源都查不到的那个坚决不记：记错等于把死端口存成原始地址
        assert!(plans.iter().all(|plan| plan.provider_id != "unknown"));
    }

    /// 恢复只看「当前是不是中转地址」：端口对不上、账本里没这一条，该恢复还是要恢复。
    #[test]
    fn plan_restore_ignores_stale_ports_and_direct_edits() {
        let snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![
                // 账本里记的是 15721，文件里已经是 18888：上一版会因此跳过
                entry(
                    "stale-port",
                    "https://stale.example/v1",
                    "http://127.0.0.1:15721/dsh/stale-port",
                ),
                // 用户手改成了别的直连地址：不能覆盖
                entry(
                    "edited",
                    "https://edited.example/v1",
                    "http://127.0.0.1:15721/dsh/edited",
                ),
            ],
        );
        let live = vec![
            live_entry(
                "stale-port",
                "Stale",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:18888/dsh/stale-port"),
            ),
            live_entry(
                "edited",
                "Edited",
                NativeProviderSource::PiAi,
                Some("https://other.example/v1"),
            ),
            // 账本里没有这一条，地址却在走中转：靠数据库/备份兜底
            live_entry(
                "orphan",
                "Orphan",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/orphan"),
            ),
            live_entry(
                "unknown",
                "Unknown",
                NativeProviderSource::PiAi,
                Some("http://127.0.0.1:15721/dsh/unknown"),
            ),
            live_entry(
                "direct",
                "Direct",
                NativeProviderSource::PiAi,
                Some("https://direct.example/v1"),
            ),
        ];

        let plan = plan_restore(&snapshot, &live, |provider_id, _| {
            (provider_id == "orphan").then(|| "https://orphan-db.example/v1".to_string())
        });

        let ids: Vec<&str> = plan
            .items
            .iter()
            .map(|item| item.provider_id.as_str())
            .collect();
        assert_eq!(ids, vec!["stale-port", "orphan"]);
        assert_eq!(plan.items[0].original_base_url, "https://stale.example/v1");
        assert_eq!(
            plan.items[1].original_base_url,
            "https://orphan-db.example/v1"
        );
        // 哪都查不到的那个留在 unknown 里，绝不清账本
        assert_eq!(plan.unknown.len(), 1);
        assert_eq!(plan.unknown[0].provider_id, "unknown");
        assert_eq!(
            plan.unknown[0].relay_base_url.as_deref(),
            Some("http://127.0.0.1:15721/dsh/unknown")
        );
    }

    /// 第一轮写失败、第二轮成功：以文件回读为准，不能报 leftovers。
    #[test]
    fn run_restore_retries_until_the_file_stops_pointing_at_the_relay() {
        let mut snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        snapshot.providers[0].relay_base_url = None;
        let live = vec![live_entry(
            "company",
            "Company",
            NativeProviderSource::PiAi,
            Some("http://127.0.0.1:15721/dsh/company"),
        )];
        let plan = plan_restore(&snapshot, &live, |_, _| None);
        assert_eq!(plan.items.len(), 1);

        let attempts = std::cell::Cell::new(0);
        let reads = std::cell::Cell::new(0);
        let (restored, leftovers) = run_restore(
            plan,
            |provider_id, _, base_url| {
                attempts.set(attempts.get() + 1);
                assert_eq!(provider_id, "company");
                assert_eq!(base_url, "https://gateway.example/v1");
                // 第一轮：写到一半失败（模拟 1175）
                if attempts.get() == 1 {
                    return Err("原子替换失败: os error 1175".to_string());
                }
                Ok(())
            },
            || {
                reads.set(reads.get() + 1);
                let current = if attempts.get() >= 2 {
                    "https://gateway.example/v1"
                } else {
                    "http://127.0.0.1:15721/dsh/company"
                };
                Ok(vec![live_entry(
                    "company",
                    "Company",
                    NativeProviderSource::PiAi,
                    Some(current),
                )])
            },
        );

        assert_eq!(restored, 1);
        assert!(leftovers.is_empty());
        assert_eq!(attempts.get(), 2);
        assert_eq!(reads.get(), 2);
    }

    /// 一直写不回去：条目作为 leftover 交回调用方，账本保持 attached 等下次重试。
    #[test]
    fn run_restore_keeps_persistent_failures_as_leftovers() {
        let live = vec![live_entry(
            "company",
            "Company",
            NativeProviderSource::PiAi,
            Some("http://127.0.0.1:15721/dsh/company"),
        )];
        let snapshot = ledger(
            "http://127.0.0.1:15721",
            vec![entry(
                "company",
                "https://gateway.example/v1",
                "http://127.0.0.1:15721/dsh/company",
            )],
        );
        let plan = plan_restore(&snapshot, &live, |_, _| None);
        let (restored, leftovers) = run_restore(
            plan,
            |_, _, _| Err("原子替换失败: os error 1175".to_string()),
            || Ok(live.clone()),
        );

        assert_eq!(restored, 0);
        assert_eq!(leftovers.len(), 1);
        assert_eq!(leftovers[0].provider_id, "company");
        assert!(leftovers[0].relayed);
        assert_eq!(
            leftovers[0].original_base_url.as_deref(),
            Some("https://gateway.example/v1")
        );
    }

    /// 账本空了但文件里还是中转地址：状态必须照实说「在走中转」，并给出代理端口。
    #[test]
    fn build_status_reports_relay_state_from_the_live_file() {
        let live = vec![live_entry(
            "company",
            "Company",
            NativeProviderSource::PiAi,
            Some("http://127.0.0.1:15721/dsh/company"),
        )];
        let status = build_status(&DshRelaySnapshot::default(), &live);
        assert!(status.attached, "文件里还有中转地址就必须显示接管中");
        assert_eq!(status.base_url.as_deref(), Some("http://127.0.0.1:15721"));
        assert!(status.providers[0].relayed);
        assert!(status.providers[0].original_base_url.is_none());
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
