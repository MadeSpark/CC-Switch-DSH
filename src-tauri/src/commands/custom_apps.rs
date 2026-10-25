//! 自定义应用 CRUD 命令。

use tauri::State;

use crate::services::custom_apps::{CustomApp, CustomAppModel};
use crate::store::AppState;

#[tauri::command]
pub fn list_custom_apps(state: State<'_, AppState>) -> Result<Vec<CustomApp>, String> {
    state.db.list_custom_apps().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_custom_app(
    state: State<'_, AppState>,
    name: String,
    icon: String,
    icon_color: Option<String>,
) -> Result<CustomApp, String> {
    state
        .db
        .create_custom_app(&name, &icon, icon_color)
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_custom_app(
    state: State<'_, AppState>,
    id: String,
    name: String,
    icon: String,
    icon_color: Option<String>,
) -> Result<CustomApp, String> {
    state
        .db
        .update_custom_app(&id, &name, &icon, icon_color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_custom_app(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.db.delete_custom_app(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn regenerate_custom_app_key(
    state: State<'_, AppState>,
    id: String,
) -> Result<CustomApp, String> {
    state
        .db
        .regenerate_custom_app_key(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_custom_app_models(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<CustomAppModel>, String> {
    // 路由列表只依赖固定供应商；先确认自定义应用存在，避免 UI 对已删除 app 展开空列表。
    state
        .db
        .get_custom_app_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "自定义应用不存在".to_string())?;
    crate::services::custom_apps::list_custom_app_models(&state.db).map_err(|e| e.to_string())
}
