#![allow(non_snake_case)]

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::commands::sync_support::{post_sync_warning_from_result, run_post_import_sync};
use crate::services::selective_config as service;
use crate::services::selective_config::{
    SelectiveCatalog, SelectiveExportResult, SelectiveImportMode, SelectiveImportPreview,
    SelectiveImportSummary, SelectiveSelection,
};
use crate::services::sync_protocol::sync_mutex;
use crate::store::AppState;

#[tauri::command]
pub async fn get_selective_export_catalog(
    state: State<'_, AppState>,
) -> Result<SelectiveCatalog, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::get_selective_export_catalog(&db).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取选择性导出目录失败: {error}"))?
}

#[tauri::command]
pub async fn export_selective_config(
    #[allow(non_snake_case)] filePath: String,
    selection: SelectiveSelection,
    state: State<'_, AppState>,
) -> Result<SelectiveExportResult, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::export_selective_config(&db, &filePath, &selection)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("导出选择性配置失败: {error}"))?
}

#[tauri::command]
pub async fn read_selective_import_file(
    #[allow(non_snake_case)] filePath: String,
    state: State<'_, AppState>,
) -> Result<SelectiveImportPreview, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::read_selective_import_file(&db, &filePath).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取选择性导入文件失败: {error}"))?
}

#[tauri::command]
pub async fn import_selective_config(
    #[allow(non_snake_case)] filePath: String,
    selection: SelectiveSelection,
    mode: SelectiveImportMode,
    state: State<'_, AppState>,
) -> Result<SelectiveImportSummary, String> {
    let app_state = state.inner().clone();
    let db = app_state.db.clone();
    let _sync_guard = sync_mutex().lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        log::info!("[selective-config] command start: {filePath}");
        let mut summary = service::import_selective_config(&db, &filePath, &selection, mode)
            .map_err(|error| error.to_string())?;
        log::info!("[selective-config] service done, running post-import sync");
        let warning = post_sync_warning_from_result(Ok(run_post_import_sync(&app_state)));
        log::info!("[selective-config] post-import sync done");
        if let Some(message) = warning {
            log::warn!("[selective-config] post-import sync warning: {message}");
            summary.warning = Some(match summary.warning {
                Some(existing) => format!("{existing}; {message}"),
                None => message,
            });
        }
        Ok::<_, String>(summary)
    })
    .await
    .map_err(|error| format!("导入选择性配置失败: {error}"))?
}

#[tauri::command]
pub async fn save_json_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    #[allow(non_snake_case)] defaultName: String,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&defaultName)
        .blocking_save_file();
    Ok(result.map(|path| path.to_string()))
}

#[tauri::command]
pub async fn open_json_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    Ok(result.map(|path| path.to_string()))
}
