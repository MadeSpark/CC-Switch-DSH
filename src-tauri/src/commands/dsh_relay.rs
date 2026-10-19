use serde::Serialize;
use tauri::State;

use crate::services::dsh_relay::{self, DshRelayProvider, DshRelaySnapshot};
use crate::settings;
use crate::store::AppState;

/// DSH 中转设置页要的状态，字段与前端 `DshRelayStatus` 一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRelayStatus {
    /// 用户是否开着接管开关（落盘值，接管失败不会置 true）。
    relay_enabled: bool,
    /// 退出 CC Switch 时是否把 baseURL 换回原始地址。
    restore_on_exit: bool,
    /// 当前是否真的处于接管状态（以磁盘快照为准，进程被强杀后可能和开关不一致）。
    attached: bool,
    /// 当前监听地址的对外 origin，接管时写给 DSH 的前缀。
    base_url: Option<String>,
    providers: Vec<DshRelayProvider>,
}

fn status_from(snapshot: DshRelaySnapshot) -> DshRelayStatus {
    let (relay_enabled, restore_on_exit) = settings::get_dsh_relay_flags();
    DshRelayStatus {
        relay_enabled,
        restore_on_exit,
        attached: snapshot.attached,
        base_url: snapshot.base_url,
        providers: snapshot.providers,
    }
}

/// 读取当前接管状态。只读，不会去启动本地代理。
///
/// `providers` 是 DSH 里所有供应商的现状（不只是被接管的那些）。
#[tauri::command]
pub async fn dsh_relay_status() -> Result<DshRelayStatus, String> {
    Ok(status_from(dsh_relay::status()))
}

/// 开关接管。打开时先接管成功再落盘；关闭时先落盘再恢复原始地址——
/// 这样中途失败的话，下次启动自检一定会把残留的中转地址换回去。
#[tauri::command]
pub async fn dsh_set_relay(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<DshRelayStatus, String> {
    if !enabled {
        settings::set_dsh_relay_enabled(false).map_err(|error| error.to_string())?;
        let snapshot = dsh_relay::detach_with(Some(state.db.as_ref()))?;
        return Ok(status_from(snapshot));
    }

    let snapshot = dsh_relay::attach(&state.proxy_service, Some(state.db.as_ref())).await?;
    if let Err(error) = settings::set_dsh_relay_enabled(true) {
        // 开关没落盘就回滚，避免退出后 DSH 还挂在只会存在于本次进程里的中转地址上。
        if let Err(rollback) = dsh_relay::detach_with(Some(state.db.as_ref())) {
            log::warn!("[DSH-Relay] 回滚接管失败: {rollback}");
        }
        return Err(format!("保存 DSH 中转开关失败: {error}"));
    }
    Ok(status_from(snapshot))
}

/// 「退出后自动切回原始地址」开关。只改设置，退出时由退出钩子执行恢复。
#[tauri::command]
pub async fn dsh_set_restore_on_exit(enabled: bool) -> Result<DshRelayStatus, String> {
    settings::set_dsh_restore_on_exit(enabled).map_err(|error| error.to_string())?;
    Ok(status_from(dsh_relay::status()))
}
