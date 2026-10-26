//! 自定义应用 CRUD 命令。

use indexmap::IndexMap;
use tauri::State;

use crate::provider::Provider;
use crate::services::custom_apps::{
    delete_custom_app_provider as delete_provider, list_custom_app_models as list_models,
    list_custom_app_providers as list_providers, save_custom_app_provider as save_provider,
    CustomApp, CustomAppModel,
};
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
    list_models(&state.db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_custom_app_providers(
    state: State<'_, AppState>,
    id: String,
) -> Result<IndexMap<String, Provider>, String> {
    list_providers(&state.db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_custom_app_provider(
    state: State<'_, AppState>,
    id: String,
    provider: Provider,
) -> Result<bool, String> {
    save_provider(&state.db, &id, &provider).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_custom_app_provider(
    state: State<'_, AppState>,
    id: String,
    provider_id: String,
) -> Result<bool, String> {
    delete_provider(&state.db, &id, &provider_id).map_err(|e| e.to_string())
}
