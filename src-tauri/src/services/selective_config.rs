//! 选择性配置导出/导入。
//!
//! 文件格式为独立 JSON，不复用 SQL 全量备份。导入会先完整校验、备份数据库，
//! 再在一个 SQLite 事务内写库。自定义应用的 API Key 永不导出，覆盖导入时也不覆盖目标设备已有 Key。

use crate::app_config::AppType;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::{Provider, ProviderMeta};
use crate::services::custom_apps::{
    custom_app_type_for_id, generate_custom_app_api_key, CustomApp,
};
use crate::services::model_pricing::ModelPricingInfo;
use crate::settings::{
    get_model_presets, save_model_presets, ModelPreset, ModelPresetParams, ModelPresetSettings,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::str::FromStr;

pub(crate) const SELECTIVE_EXPORT_FORMAT: &str = "cc-switch.selective-export";
pub(crate) const SELECTIVE_EXPORT_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_SELECTIVE_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAppGroup {
    pub app_type: String,
    pub items: Vec<CatalogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCustomApp {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
    pub providers: Vec<CatalogItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveCatalog {
    #[serde(default)]
    pub providers: Vec<CatalogAppGroup>,
    #[serde(default)]
    pub custom_apps: Vec<CatalogCustomApp>,
    #[serde(default)]
    pub model_pricing: Vec<CatalogItem>,
    #[serde(default)]
    pub model_presets: Vec<CatalogItem>,
    #[serde(default)]
    pub has_generic_preset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveSelection {
    #[serde(default)]
    pub providers: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub custom_apps: Vec<String>,
    #[serde(default)]
    pub model_pricing: Vec<String>,
    #[serde(default)]
    pub model_presets: Vec<String>,
    #[serde(default)]
    pub generic_preset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveImportPreview {
    pub catalog: SelectiveCatalog,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SelectiveImportMode {
    Overwrite,
    Append,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionResult {
    pub section: String,
    pub added: usize,
    pub overwritten: usize,
    pub skipped: usize,
    pub renamed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveImportSummary {
    pub sections: Vec<SectionResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveExportResult {
    pub file_path: String,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectiveExportFile {
    format: String,
    schema_version: u32,
    app_version: String,
    exported_at: String,
    #[serde(default)]
    providers: Vec<ExportedProviderItem>,
    #[serde(default)]
    custom_apps: Vec<ExportedCustomApp>,
    #[serde(default)]
    model_pricing: Vec<ModelPricingInfo>,
    #[serde(default)]
    model_presets: Vec<ModelPreset>,
    #[serde(default)]
    generic_preset: Option<ModelPresetParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedProviderItem {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    app_type: String,
    provider: Provider,
    #[serde(default)]
    endpoints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedCustomApp {
    app: ExportedCustomAppInfo,
    #[serde(default)]
    providers: Vec<ExportedProviderItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedCustomAppInfo {
    id: String,
    name: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    icon_color: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalProviderRow {
    provider: Provider,
    endpoints: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Counts {
    added: usize,
    overwritten: usize,
    skipped: usize,
    renamed: usize,
}

impl Counts {
    fn section(self, section: impl Into<String>) -> SectionResult {
        SectionResult {
            section: section.into(),
            added: self.added,
            overwritten: self.overwritten,
            skipped: self.skipped,
            renamed: self.renamed,
        }
    }
}

pub fn get_selective_export_catalog(db: &Database) -> Result<SelectiveCatalog, AppError> {
    let rows = load_provider_rows_from_db(db)?;
    let mut by_app: HashMap<String, Vec<LocalProviderRow>> = HashMap::new();
    for (app_type, row) in rows {
        by_app.entry(app_type).or_default().push(row);
    }

    let mut providers = Vec::new();
    for app_type in AppType::all() {
        let app_type_id = app_type.as_str().to_string();
        if let Some(mut items) = by_app.remove(&app_type_id) {
            sort_local_rows(&mut items);
            providers.push(CatalogAppGroup {
                app_type: app_type_id,
                items: items.iter().map(catalog_item_for_provider).collect(),
            });
        }
    }

    let mut custom_apps = Vec::new();
    for app in db.list_custom_apps()? {
        let mut items = by_app
            .remove(&custom_app_type_for_id(&app.id))
            .unwrap_or_default();
        sort_local_rows(&mut items);
        custom_apps.push(CatalogCustomApp {
            id: app.id.clone(),
            name: app.name,
            icon: Some(app.icon),
            icon_color: app.icon_color,
            providers: items.iter().map(catalog_item_for_provider).collect(),
            exists: None,
        });
    }

    let model_pricing = load_model_pricing(db)?
        .into_iter()
        .map(|entry| CatalogItem {
            id: entry.model_id.clone(),
            name: entry.display_name,
            detail: None,
            exists: None,
        })
        .collect();
    let model_presets = get_model_presets()
        .presets
        .into_iter()
        .map(|preset| CatalogItem {
            id: preset.id.clone(),
            name: preset.name,
            detail: Some(preset.model_id),
            exists: None,
        })
        .collect();

    Ok(SelectiveCatalog {
        providers,
        custom_apps,
        model_pricing,
        model_presets,
        has_generic_preset: true,
    })
}

pub fn export_selective_config(
    db: &Database,
    file_path: &str,
    selection: &SelectiveSelection,
) -> Result<SelectiveExportResult, AppError> {
    let document = build_export_document(db, selection)?;
    let mut data = serde_json::to_vec_pretty(&document)
        .map_err(|error| AppError::Config(format!("序列化选择性导出文件失败: {error}")))?;
    data.push(b'\n');
    crate::config::atomic_write(Path::new(file_path), &data)?;
    let total = document.providers.len()
        + document.custom_apps.len()
        + document.model_pricing.len()
        + document.model_presets.len()
        + usize::from(document.generic_preset.is_some());
    Ok(SelectiveExportResult {
        file_path: file_path.to_string(),
        total,
    })
}

fn build_export_document(
    db: &Database,
    selection: &SelectiveSelection,
) -> Result<SelectiveExportFile, AppError> {
    let rows = load_provider_rows_from_db(db)?;
    let mut by_app: HashMap<String, Vec<LocalProviderRow>> = HashMap::new();
    for (app_type, row) in rows {
        by_app.entry(app_type).or_default().push(row);
    }

    let mut selected_providers: HashMap<String, HashSet<&str>> = HashMap::new();
    for (raw_app_type, selected_ids) in &selection.providers {
        let Ok(parsed) = AppType::from_str(raw_app_type) else {
            continue;
        };
        selected_providers
            .entry(parsed.as_str().to_string())
            .or_default()
            .extend(selected_ids.iter().map(String::as_str));
    }

    // 按 AppType 枚举顺序组织供应商，避免 HashMap 遍历顺序导致导出文件不稳定。
    let mut providers = Vec::new();
    for app_type in AppType::all() {
        let canonical = app_type.as_str().to_string();
        let Some(selected) = selected_providers.remove(&canonical) else {
            continue;
        };
        if let Some(mut items) = by_app.remove(&canonical) {
            sort_local_rows(&mut items);
            providers.extend(items.into_iter().filter_map(|row| {
                selected
                    .contains(row.provider.id.as_str())
                    .then(|| exported_provider_item(canonical.clone(), row))
            }));
        }
    }

    let selected_custom_apps: HashSet<&str> =
        selection.custom_apps.iter().map(String::as_str).collect();
    let mut custom_apps = Vec::new();
    for app in db.list_custom_apps()? {
        if !selected_custom_apps.contains(app.id.as_str()) {
            continue;
        }
        let mut items = by_app
            .remove(&custom_app_type_for_id(&app.id))
            .unwrap_or_default();
        sort_local_rows(&mut items);
        custom_apps.push(ExportedCustomApp {
            app: ExportedCustomAppInfo {
                id: app.id,
                name: app.name,
                icon: app.icon,
                icon_color: app.icon_color,
            },
            providers: items
                .into_iter()
                .map(|row| exported_provider_item(String::new(), row))
                .collect(),
        });
    }

    let selected_pricing: HashSet<&str> =
        selection.model_pricing.iter().map(String::as_str).collect();
    let model_pricing = load_model_pricing(db)?
        .into_iter()
        .filter(|entry| selected_pricing.contains(entry.model_id.as_str()))
        .collect();
    let preset_settings = get_model_presets();
    let selected_presets: HashSet<&str> =
        selection.model_presets.iter().map(String::as_str).collect();
    let model_presets = preset_settings
        .presets
        .into_iter()
        .filter(|preset| selected_presets.contains(preset.id.as_str()))
        .collect();
    let generic_preset = selection.generic_preset.then_some(preset_settings.generic);

    Ok(SelectiveExportFile {
        format: SELECTIVE_EXPORT_FORMAT.to_string(),
        schema_version: SELECTIVE_EXPORT_SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Local::now().to_rfc3339(),
        providers,
        custom_apps,
        model_pricing,
        model_presets,
        generic_preset,
    })
}

fn catalog_item_for_provider(row: &LocalProviderRow) -> CatalogItem {
    CatalogItem {
        id: row.provider.id.clone(),
        name: row.provider.name.clone(),
        detail: provider_detail(&row.provider, &row.endpoints),
        exists: None,
    }
}

fn provider_detail(provider: &Provider, endpoints: &[String]) -> Option<String> {
    if let Some(url) = endpoints.iter().find(|url| !url.trim().is_empty()) {
        return Some(url.clone());
    }
    let value = &provider.settings_config;
    for key in [
        "baseURL",
        "baseUrl",
        "base_url",
        "apiEndpoint",
        "endpoint",
        "url",
    ] {
        if let Some(url) = value.get(key).and_then(Value::as_str) {
            if !url.trim().is_empty() {
                return Some(url.to_string());
            }
        }
    }
    if let Some(env) = value.get("env") {
        for key in [
            "ANTHROPIC_BASE_URL",
            "OPENAI_BASE_URL",
            "GOOGLE_GEMINI_BASE_URL",
            "BASE_URL",
        ] {
            if let Some(url) = env.get(key).and_then(Value::as_str) {
                if !url.trim().is_empty() {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

fn exported_provider_item(app_type: String, row: LocalProviderRow) -> ExportedProviderItem {
    let mut provider = row.provider;
    if let Some(meta) = provider.meta.as_mut() {
        // 端点已经迁移到 provider_endpoints，历史 meta 字段不应进入导出文件。
        meta.custom_endpoints.clear();
    }
    ExportedProviderItem {
        app_type,
        provider,
        endpoints: row.endpoints,
    }
}

pub fn read_selective_import_file(
    db: &Database,
    file_path: &str,
) -> Result<SelectiveImportPreview, AppError> {
    let document = read_and_validate_import_file(file_path)?;
    let rows = load_provider_rows_from_db(db)?;
    let local_providers: HashSet<(String, String)> = rows
        .into_iter()
        .map(|(app_type, row)| (app_type, row.provider.id))
        .collect();
    let local_custom_apps: HashSet<String> = db
        .list_custom_apps()?
        .into_iter()
        .map(|app| app.id)
        .collect();
    let local_pricing: HashSet<String> = load_model_pricing(db)?
        .into_iter()
        .map(|entry| entry.model_id)
        .collect();
    let local_presets: HashSet<String> = get_model_presets()
        .presets
        .into_iter()
        .map(|preset| preset.id)
        .collect();

    let mut groups: Vec<CatalogAppGroup> = Vec::new();
    for item in &document.providers {
        let exists = local_providers.contains(&(item.app_type.clone(), item.provider.id.clone()));
        let catalog_item = CatalogItem {
            id: item.provider.id.clone(),
            name: item.provider.name.clone(),
            detail: provider_detail(&item.provider, &item.endpoints),
            exists: Some(exists),
        };
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.app_type == item.app_type)
        {
            group.items.push(catalog_item);
        } else {
            groups.push(CatalogAppGroup {
                app_type: item.app_type.clone(),
                items: vec![catalog_item],
            });
        }
    }

    let mut custom_apps = Vec::new();
    for entry in &document.custom_apps {
        let app_type = custom_app_type_for_id(&entry.app.id);
        custom_apps.push(CatalogCustomApp {
            id: entry.app.id.clone(),
            name: entry.app.name.clone(),
            icon: (!entry.app.icon.is_empty()).then(|| entry.app.icon.clone()),
            icon_color: entry.app.icon_color.clone(),
            providers: entry
                .providers
                .iter()
                .map(|item| CatalogItem {
                    id: item.provider.id.clone(),
                    name: item.provider.name.clone(),
                    detail: provider_detail(&item.provider, &item.endpoints),
                    exists: Some(
                        local_providers.contains(&(app_type.clone(), item.provider.id.clone())),
                    ),
                })
                .collect(),
            exists: Some(local_custom_apps.contains(&entry.app.id)),
        });
    }

    let model_pricing = document
        .model_pricing
        .iter()
        .map(|entry| CatalogItem {
            id: entry.model_id.clone(),
            name: entry.display_name.clone(),
            detail: None,
            exists: Some(local_pricing.contains(&entry.model_id)),
        })
        .collect();
    let model_presets = document
        .model_presets
        .iter()
        .map(|preset| CatalogItem {
            id: preset.id.clone(),
            name: preset.name.clone(),
            detail: Some(preset.model_id.clone()),
            exists: Some(local_presets.contains(&preset.id)),
        })
        .collect();

    Ok(SelectiveImportPreview {
        catalog: SelectiveCatalog {
            providers: groups,
            custom_apps,
            model_pricing,
            model_presets,
            has_generic_preset: document.generic_preset.is_some(),
        },
        app_version: Some(document.app_version),
        exported_at: Some(document.exported_at),
    })
}

fn read_and_validate_import_file(file_path: &str) -> Result<SelectiveExportFile, AppError> {
    let path = Path::new(file_path);
    let metadata = fs::metadata(path).map_err(|error| AppError::io(path, error))?;
    if metadata.len() > MAX_SELECTIVE_IMPORT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "导入文件过大（{} 字节），最大允许 {} 字节",
            metadata.len(),
            MAX_SELECTIVE_IMPORT_BYTES
        )));
    }
    let file = fs::File::open(path).map_err(|error| AppError::io(path, error))?;
    let mut bytes = Vec::new();
    file.take(MAX_SELECTIVE_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::io(path, error))?;
    if bytes.len() as u64 > MAX_SELECTIVE_IMPORT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "导入文件过大，最大允许 {} 字节",
            MAX_SELECTIVE_IMPORT_BYTES
        )));
    }
    validate_import_file_bytes(&bytes)
}

fn validate_import_file_bytes(bytes: &[u8]) -> Result<SelectiveExportFile, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|error| AppError::InvalidInput(format!("导入文件不是有效的 UTF-8: {error}")))?;
    let mut document: SelectiveExportFile = serde_json::from_str(&text)
        .map_err(|error| AppError::InvalidInput(format!("导入文件 JSON 格式无效: {error}")))?;

    if document.format != SELECTIVE_EXPORT_FORMAT {
        return Err(AppError::InvalidInput(format!(
            "不支持的导入文件格式: {}",
            document.format
        )));
    }
    if document.schema_version != SELECTIVE_EXPORT_SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "不支持的导入文件版本: {}",
            document.schema_version
        )));
    }

    let mut provider_keys = HashSet::new();
    let mut custom_app_ids = HashSet::new();
    let mut pricing_ids = HashSet::new();
    let mut preset_ids = HashSet::new();

    for item in &mut document.providers {
        let parsed = AppType::from_str(&item.app_type).map_err(|error| {
            AppError::InvalidInput(format!("供应商应用类型无效 '{}': {error}", item.app_type))
        })?;
        item.app_type = parsed.as_str().to_string();
        validate_provider_item(item)?;
        if !provider_keys.insert((item.app_type.clone(), item.provider.id.clone())) {
            return Err(AppError::InvalidInput(format!(
                "导入文件包含重复供应商: {} / {}",
                item.app_type, item.provider.id
            )));
        }
    }

    for entry in &mut document.custom_apps {
        if !entry.app.id.starts_with("custom-") {
            return Err(AppError::InvalidInput(format!(
                "自定义应用 ID 必须以 custom- 开头: {}",
                entry.app.id
            )));
        }
        if !custom_app_ids.insert(entry.app.id.clone()) {
            return Err(AppError::InvalidInput(format!(
                "导入文件包含重复自定义应用: {}",
                entry.app.id
            )));
        }
        for item in &mut entry.providers {
            item.app_type = custom_app_type_for_id(&entry.app.id);
            validate_provider_item(item)?;
            if !provider_keys.insert((item.app_type.clone(), item.provider.id.clone())) {
                return Err(AppError::InvalidInput(format!(
                    "导入文件包含重复供应商: {} / {}",
                    item.app_type, item.provider.id
                )));
            }
        }
    }

    for entry in &document.model_pricing {
        if !pricing_ids.insert(entry.model_id.clone()) {
            return Err(AppError::InvalidInput(format!(
                "导入文件包含重复模型定价: {}",
                entry.model_id
            )));
        }
    }
    for preset in &document.model_presets {
        if !preset_ids.insert(preset.id.clone()) {
            return Err(AppError::InvalidInput(format!(
                "导入文件包含重复模型预设: {}",
                preset.id
            )));
        }
    }

    Ok(document)
}

fn validate_provider_item(item: &ExportedProviderItem) -> Result<(), AppError> {
    if item.provider.id.trim().is_empty() {
        return Err(AppError::InvalidInput("供应商 ID 不能为空".to_string()));
    }
    Ok(())
}

pub fn import_selective_config(
    db: &Database,
    file_path: &str,
    selection: &SelectiveSelection,
    mode: SelectiveImportMode,
) -> Result<SelectiveImportSummary, AppError> {
    let document = read_and_validate_import_file(file_path)?;
    import_document(db, document, selection, mode, true)
}

fn import_document(
    db: &Database,
    document: SelectiveExportFile,
    selection: &SelectiveSelection,
    mode: SelectiveImportMode,
    apply_external_side_effects: bool,
) -> Result<SelectiveImportSummary, AppError> {
    let selected_provider_ids: HashMap<String, HashSet<String>> = selection
        .providers
        .iter()
        .filter_map(|(app_type, ids)| {
            AppType::from_str(app_type)
                .ok()
                .map(|parsed| (parsed.as_str().to_string(), ids.iter().cloned().collect()))
        })
        .collect();
    let selected_custom_apps: HashSet<String> = selection.custom_apps.iter().cloned().collect();
    let selected_pricing: HashSet<String> = selection.model_pricing.iter().cloned().collect();
    let selected_presets: HashSet<String> = selection.model_presets.iter().cloned().collect();

    let wants_presets = !selected_presets.is_empty();
    let wants_generic = selection.generic_preset && document.generic_preset.is_some();

    log::info!(
        "[selective-config] import start: mode={mode:?}, providers={}, customApps={}, pricing={}, presets={}, generic={}",
        selected_provider_ids.values().map(HashSet::len).sum::<usize>(),
        selected_custom_apps.len(),
        selected_pricing.len(),
        selected_presets.len(),
        wants_generic
    );
    let preset_plan = if !wants_presets && !wants_generic {
        None
    } else {
        let current = get_model_presets();
        let imported: Vec<ModelPreset> = document
            .model_presets
            .iter()
            .filter(|preset| selected_presets.contains(&preset.id))
            .cloned()
            .collect();
        Some(plan_model_preset_merge(
            &current,
            &imported,
            document.generic_preset.as_ref(),
            mode,
            wants_presets,
            wants_generic,
        ))
    };

    let backup_id = if apply_external_side_effects {
        let Some(path) = db.backup_database_file()? else {
            return Err(AppError::Config(
                "导入前备份数据库失败：未找到数据库文件，已取消导入".to_string(),
            ));
        };
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
    } else {
        None
    };

    // Lock order must match model_pricing.rs: pricing file lock first, then db.conn.
    // Declared before `conn` so that on every early return `conn` drops first.
    if let Some(id) = backup_id.as_deref() {
        log::info!("[selective-config] import backup created: {id}");
    }
    let pricing_file_guard = if apply_external_side_effects && !selected_pricing.is_empty() {
        Some(crate::services::model_pricing::lock_local_pricing_file()?)
    } else {
        None
    };
    if pricing_file_guard.is_some() {
        log::info!("[selective-config] pricing file lock acquired");
    }
    let mut conn = lock_conn!(db.conn);
    log::info!("[selective-config] database lock acquired");
    let pricing_plan = if selected_pricing.is_empty() {
        None
    } else {
        Some(plan_pricing_import(
            &conn,
            &document,
            &selected_pricing,
            mode,
        )?)
    };
    let pricing_snapshot = if apply_external_side_effects {
        match (pricing_plan.as_ref(), pricing_file_guard.as_ref()) {
            (Some(plan), Some(file_guard)) if !plan.writes.is_empty() => {
                match crate::services::model_pricing::merge_entries_into_local_pricing_file(
                    file_guard,
                    &plan
                        .writes
                        .iter()
                        .map(|(_, entry)| entry.clone())
                        .collect::<Vec<_>>(),
                ) {
                    Ok(snapshot) => snapshot,
                    Err(error) => return Err(error),
                }
            }
            _ => None,
        }
    } else {
        None
    };

    let transaction = match conn.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            return Err(restore_pricing_snapshot_after_failure(
                pricing_file_guard.as_ref(),
                pricing_snapshot,
                AppError::from(error),
            ));
        }
    };
    let sections_result = (|| -> Result<Vec<SectionResult>, AppError> {
        let mut sections = Vec::new();

        let mut provider_keys: HashSet<(String, String)> = load_provider_rows(&transaction)?
            .into_iter()
            .map(|(app_type, row)| (app_type, row.provider.id))
            .collect();

        let mut grouped_providers: Vec<(String, Vec<ExportedProviderItem>)> = Vec::new();
        for item in &document.providers {
            let selected = selected_provider_ids
                .get(&item.app_type)
                .is_some_and(|ids| ids.contains(&item.provider.id));
            if !selected {
                continue;
            }
            if let Some((_, items)) = grouped_providers
                .iter_mut()
                .find(|(app_type, _)| app_type == &item.app_type)
            {
                items.push(item.clone());
            } else {
                grouped_providers.push((item.app_type.clone(), vec![item.clone()]));
            }
        }

        for (app_type, items) in grouped_providers {
            let counts =
                import_provider_group(&transaction, &app_type, &items, mode, &mut provider_keys)?;
            sections.push(counts.section(format!("providers:{app_type}")));
        }

        for entry in &document.custom_apps {
            if !selected_custom_apps.contains(&entry.app.id) {
                continue;
            }
            let app_type = custom_app_type_for_id(&entry.app.id);
            ensure_custom_app(&transaction, &entry.app, mode)?;
            let counts = import_provider_group(
                &transaction,
                &app_type,
                &entry.providers,
                mode,
                &mut provider_keys,
            )?;
            sections.push(counts.section(format!("customApp:{}", entry.app.id)));
        }

        if let Some(plan) = &pricing_plan {
            for (existed, entry) in &plan.writes {
                if *existed {
                    upsert_pricing(&transaction, entry)?;
                } else {
                    insert_pricing(&transaction, entry)?;
                }
            }
            sections.push(plan.counts.section("modelPricing"));
        }

        Ok(sections)
    })();

    let mut sections = match sections_result {
        Ok(sections) => sections,
        Err(error) => {
            drop(transaction);
            return Err(restore_pricing_snapshot_after_failure(
                pricing_file_guard.as_ref(),
                pricing_snapshot,
                error,
            ));
        }
    };

    if let Err(error) = transaction.commit() {
        return Err(restore_pricing_snapshot_after_failure(
            pricing_file_guard.as_ref(),
            pricing_snapshot,
            AppError::from(error),
        ));
    }
    drop(conn);
    drop(pricing_file_guard);
    log::info!("[selective-config] transaction committed");

    let mut warning_parts = Vec::new();

    if let Some((merged, preset_counts, generic_counts, changed)) = preset_plan {
        let mut pending_sections = Vec::new();
        if !selected_presets.is_empty() {
            pending_sections.push(preset_counts.section("modelPresets"));
        }
        if let Some(counts) = generic_counts {
            pending_sections.push(counts.section("genericPreset"));
        }

        if apply_external_side_effects && changed {
            match save_model_presets(merged) {
                Ok(_) => sections.extend(pending_sections),
                Err(error) => {
                    let message = format!("数据库已导入，但模型预设保存失败: {error}");
                    log::warn!("[selective-config] {message}");
                    warning_parts.push(message);
                }
            }
        } else {
            sections.extend(pending_sections);
        }
    }

    log::info!(
        "[selective-config] import finished: {} section(s), {} warning(s)",
        sections.len(),
        warning_parts.len()
    );
    Ok(SelectiveImportSummary {
        sections,
        backup_id,
        warning: (!warning_parts.is_empty()).then(|| warning_parts.join("; ")),
    })
}

fn import_provider_group(
    transaction: &Transaction<'_>,
    app_type: &str,
    items: &[ExportedProviderItem],
    mode: SelectiveImportMode,
    provider_keys: &mut HashSet<(String, String)>,
) -> Result<Counts, AppError> {
    let mut counts = Counts::default();
    for item in items {
        let key = (app_type.to_string(), item.provider.id.clone());
        let exists = provider_keys.contains(&key);
        match (mode, exists) {
            (SelectiveImportMode::Overwrite, true) => {
                overwrite_provider(transaction, app_type, &item.provider)?;
                replace_endpoints(transaction, app_type, &item.provider.id, &item.endpoints)?;
                counts.overwritten += 1;
            }
            (SelectiveImportMode::Overwrite, false) => {
                insert_provider_at_end(
                    transaction,
                    app_type,
                    &item.provider.id,
                    &item.provider.name,
                    &item.provider,
                    &item.endpoints,
                )?;
                provider_keys.insert(key);
                counts.added += 1;
            }
            (SelectiveImportMode::Append, true) => {
                let local = load_provider_row(transaction, app_type, &item.provider.id)?
                    .expect("provider exists");
                if provider_content_equal(&local, &item.provider, &item.endpoints) {
                    counts.skipped += 1;
                } else {
                    let new_id =
                        first_available_provider_id(provider_keys, app_type, &item.provider.id);
                    let new_name = format!("{}（导入）", item.provider.name);
                    insert_provider_at_end(
                        transaction,
                        app_type,
                        &new_id,
                        &new_name,
                        &item.provider,
                        &item.endpoints,
                    )?;
                    provider_keys.insert((app_type.to_string(), new_id));
                    counts.renamed += 1;
                }
            }
            (SelectiveImportMode::Append, false) => {
                insert_provider_at_end(
                    transaction,
                    app_type,
                    &item.provider.id,
                    &item.provider.name,
                    &item.provider,
                    &item.endpoints,
                )?;
                provider_keys.insert(key);
                counts.added += 1;
            }
        }
    }
    Ok(counts)
}

fn ensure_custom_app(
    transaction: &Transaction<'_>,
    app: &ExportedCustomAppInfo,
    mode: SelectiveImportMode,
) -> Result<(), AppError> {
    let existing = load_custom_app(transaction, &app.id)?;
    let now = now_millis();
    let icon = if app.icon.trim().is_empty() {
        "openai".to_string()
    } else {
        app.icon.clone()
    };
    match (mode, existing) {
        (SelectiveImportMode::Overwrite, Some(_)) => {
            transaction.execute(
                "UPDATE custom_apps SET name = ?1, icon = ?2, icon_color = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![app.name, icon, app.icon_color, now, app.id],
            )?;
        }
        (SelectiveImportMode::Overwrite, None) | (SelectiveImportMode::Append, None) => {
            let api_key = generate_custom_app_api_key();
            transaction.execute(
                "INSERT INTO custom_apps (id, name, icon, icon_color, api_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![app.id, app.name, icon, app.icon_color, api_key, now, now],
            )?;
        }
        (SelectiveImportMode::Append, Some(_)) => {
            // Append 不修改已有应用元数据，只追加供应商。
        }
    }
    Ok(())
}

fn load_provider_rows_from_db(db: &Database) -> Result<Vec<(String, LocalProviderRow)>, AppError> {
    let conn = lock_conn!(db.conn);
    load_provider_rows(&conn)
}

fn load_provider_rows(conn: &Connection) -> Result<Vec<(String, LocalProviderRow)>, AppError> {
    let mut endpoint_map: HashMap<(String, String), Vec<String>> = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT app_type, provider_id, url FROM provider_endpoints
             ORDER BY app_type ASC, provider_id ASC, COALESCE(added_at, 0) ASC, url ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (app_type, provider_id, url) = row?;
            if url.trim().is_empty() {
                continue;
            }
            let endpoints = endpoint_map.entry((app_type, provider_id)).or_default();
            if !endpoints.contains(&url) {
                endpoints.push(url);
            }
        }
    }

    let mut statement = conn.prepare(
        "SELECT app_type, id, name, settings_config, website_url, category, created_at,
                sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue
         FROM providers
         ORDER BY app_type ASC, COALESCE(sort_index, 999999), created_at ASC, id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let app_type: String = row.get(0)?;
        let settings_config: String = row.get(3)?;
        let meta: String = row.get(11)?;
        let sort_index: Option<i64> = row.get(7)?;
        let parsed_meta = serde_json::from_str(&meta).unwrap_or_else(|_| ProviderMeta::default());
        Ok((
            app_type,
            LocalProviderRow {
                provider: Provider {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    settings_config: serde_json::from_str(&settings_config).unwrap_or(Value::Null),
                    website_url: row.get(4)?,
                    category: row.get(5)?,
                    created_at: row.get(6)?,
                    sort_index: sort_index.and_then(|value| usize::try_from(value).ok()),
                    notes: row.get(8)?,
                    icon: row.get(9)?,
                    icon_color: row.get(10)?,
                    meta: Some(parsed_meta),
                    in_failover_queue: row.get(13)?,
                },
                endpoints: Vec::new(),
            },
        ))
    })?;

    let mut result = Vec::new();
    for row in rows {
        let (app_type, mut local) = row?;
        if let Some(endpoints) = endpoint_map.remove(&(app_type.clone(), local.provider.id.clone()))
        {
            local.endpoints = endpoints;
        }
        result.push((app_type, local));
    }
    Ok(result)
}

fn load_provider_row(
    conn: &Connection,
    app_type: &str,
    provider_id: &str,
) -> Result<Option<LocalProviderRow>, AppError> {
    let row = conn
        .query_row(
            "SELECT id, name, settings_config, website_url, category, created_at, sort_index,
                    notes, icon, icon_color, meta, is_current, in_failover_queue
             FROM providers WHERE app_type = ?1 AND id = ?2",
            params![app_type, provider_id],
            |row| {
                let settings_config: String = row.get(2)?;
                let meta: String = row.get(10)?;
                let sort_index: Option<i64> = row.get(6)?;
                Ok(LocalProviderRow {
                    provider: Provider {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        settings_config: serde_json::from_str(&settings_config)
                            .unwrap_or(Value::Null),
                        website_url: row.get(3)?,
                        category: row.get(4)?,
                        created_at: row.get(5)?,
                        sort_index: sort_index.and_then(|value| usize::try_from(value).ok()),
                        notes: row.get(7)?,
                        icon: row.get(8)?,
                        icon_color: row.get(9)?,
                        meta: Some(
                            serde_json::from_str(&meta).unwrap_or_else(|_| ProviderMeta::default()),
                        ),
                        in_failover_queue: row.get(12)?,
                    },
                    endpoints: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut row) = row else {
        return Ok(None);
    };
    row.endpoints = load_endpoints(conn, app_type, provider_id)?;
    Ok(Some(row))
}

fn load_endpoints(
    conn: &Connection,
    app_type: &str,
    provider_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut statement = conn.prepare(
        "SELECT url FROM provider_endpoints
         WHERE app_type = ?1 AND provider_id = ?2
         ORDER BY COALESCE(added_at, 0) ASC, url ASC",
    )?;
    let rows = statement.query_map(params![app_type, provider_id], |row| row.get(0))?;
    let mut result = Vec::new();
    for row in rows {
        let url: String = row?;
        if !url.trim().is_empty() && !result.contains(&url) {
            result.push(url);
        }
    }
    Ok(result)
}

fn overwrite_provider(
    transaction: &Transaction<'_>,
    app_type: &str,
    provider: &Provider,
) -> Result<(), AppError> {
    let settings_config = serde_json::to_string(&provider.settings_config)
        .map_err(|error| AppError::Config(format!("序列化供应商配置失败: {error}")))?;
    let meta = serialize_meta(provider)?;
    transaction.execute(
        "UPDATE providers SET
            name = ?1, settings_config = ?2, website_url = ?3, category = ?4,
            created_at = ?5, notes = ?6, icon = ?7,
            icon_color = ?8, meta = ?9
         WHERE app_type = ?10 AND id = ?11",
        params![
            provider.name,
            settings_config,
            provider.website_url,
            provider.category,
            provider.created_at,
            provider.notes,
            provider.icon,
            provider.icon_color,
            meta,
            app_type,
            provider.id
        ],
    )?;
    Ok(())
}

fn insert_provider_at_end(
    transaction: &Transaction<'_>,
    app_type: &str,
    id: &str,
    name: &str,
    provider: &Provider,
    endpoints: &[String],
) -> Result<(), AppError> {
    let settings_config = serde_json::to_string(&provider.settings_config)
        .map_err(|error| AppError::Config(format!("序列化供应商配置失败: {error}")))?;
    let meta = serialize_meta(provider)?;
    let sort_index = next_sort_index(transaction, app_type)?;
    let created_at = provider.created_at.unwrap_or_else(now_millis);
    transaction.execute(
        "INSERT INTO providers (
            id, app_type, name, settings_config, website_url, category,
            created_at, sort_index, notes, icon, icon_color, meta,
            is_current, in_failover_queue
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0)",
        params![
            id,
            app_type,
            name,
            settings_config,
            provider.website_url,
            provider.category,
            created_at,
            sort_index,
            provider.notes,
            provider.icon,
            provider.icon_color,
            meta
        ],
    )?;
    replace_endpoints(transaction, app_type, id, endpoints)?;
    Ok(())
}

fn normalized_endpoints(endpoints: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    endpoints
        .iter()
        .filter_map(|url| {
            let url = url.trim();
            if url.is_empty() || !seen.insert(url.to_string()) {
                None
            } else {
                Some(url.to_string())
            }
        })
        .collect()
}

fn replace_endpoints(
    transaction: &Transaction<'_>,
    app_type: &str,
    provider_id: &str,
    endpoints: &[String],
) -> Result<(), AppError> {
    transaction.execute(
        "DELETE FROM provider_endpoints WHERE app_type = ?1 AND provider_id = ?2",
        params![app_type, provider_id],
    )?;
    let now = now_millis();
    for url in normalized_endpoints(endpoints) {
        transaction.execute(
            "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![provider_id, app_type, url, now],
        )?;
    }
    Ok(())
}

fn serialize_meta(provider: &Provider) -> Result<String, AppError> {
    let mut meta = provider.meta.clone().unwrap_or_default();
    meta.custom_endpoints.clear();
    serde_json::to_string(&meta)
        .map_err(|error| AppError::Config(format!("序列化供应商元数据失败: {error}")))
}

fn normalized_meta(meta: &Option<ProviderMeta>) -> Option<Value> {
    meta.as_ref().and_then(|meta| {
        let mut meta = meta.clone();
        // provider_endpoints 是独立字段；比较时排除 DAO 注入的端点，其余 meta 保持原样。
        meta.custom_endpoints.clear();
        serde_json::to_value(meta).ok()
    })
}

fn normalized_endpoint_set(endpoints: &[String]) -> BTreeSet<String> {
    endpoints
        .iter()
        .map(|endpoint| endpoint.trim().to_string())
        .filter(|endpoint| !endpoint.is_empty())
        .collect()
}

fn provider_content_equal(
    local: &LocalProviderRow,
    incoming: &Provider,
    incoming_endpoints: &[String],
) -> bool {
    let local_meta = normalized_meta(&local.provider.meta);
    let incoming_meta = normalized_meta(&incoming.meta);
    local.provider.name == incoming.name
        && local.provider.settings_config == incoming.settings_config
        && local.provider.website_url == incoming.website_url
        && local.provider.category == incoming.category
        && local.provider.notes == incoming.notes
        && local.provider.icon == incoming.icon
        && local.provider.icon_color == incoming.icon_color
        && local_meta == incoming_meta
        && normalized_endpoint_set(&local.endpoints) == normalized_endpoint_set(incoming_endpoints)
}

fn next_sort_index(conn: &Connection, app_type: &str) -> Result<i64, AppError> {
    let maximum: Option<i64> = conn.query_row(
        "SELECT MAX(COALESCE(sort_index, 999999)) FROM providers WHERE app_type = ?1",
        params![app_type],
        |row| row.get(0),
    )?;
    Ok(maximum.map_or(0, |value| value.saturating_add(1)))
}

fn first_available_provider_id(
    keys: &HashSet<(String, String)>,
    app_type: &str,
    base_id: &str,
) -> String {
    if !keys.contains(&(app_type.to_string(), base_id.to_string())) {
        return base_id.to_string();
    }
    let mut suffix = 2usize;
    loop {
        let candidate = format!("{base_id}-{suffix}");
        if !keys.contains(&(app_type.to_string(), candidate.clone())) {
            return candidate;
        }
        suffix += 1;
    }
}

fn load_model_pricing(db: &Database) -> Result<Vec<ModelPricingInfo>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn.prepare(
        "SELECT model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
         FROM model_pricing ORDER BY model_id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ModelPricingInfo {
            model_id: row.get(0)?,
            display_name: row.get(1)?,
            input_cost_per_million: row.get(2)?,
            output_cost_per_million: row.get(3)?,
            cache_read_cost_per_million: row.get(4)?,
            cache_creation_cost_per_million: row.get(5)?,
        })
    })?;
    rows.map(|row| row.map_err(AppError::from)).collect()
}

struct PricingImportPlan {
    counts: Counts,
    writes: Vec<(bool, ModelPricingInfo)>,
}

/// Decide which pricing rows to write before the database transaction starts.
/// Append mode only records entries whose model IDs are absent locally so the
/// local override file never receives skipped entries.
fn plan_pricing_import(
    conn: &Connection,
    document: &SelectiveExportFile,
    selected: &HashSet<String>,
    mode: SelectiveImportMode,
) -> Result<PricingImportPlan, AppError> {
    let mut counts = Counts::default();
    let mut writes = Vec::new();
    for entry in document
        .model_pricing
        .iter()
        .filter(|entry| selected.contains(&entry.model_id))
    {
        let exists = pricing_exists(conn, &entry.model_id)?;
        match (mode, exists) {
            (SelectiveImportMode::Append, true) => counts.skipped += 1,
            (SelectiveImportMode::Append, false) => {
                writes.push((false, entry.clone()));
                counts.added += 1;
            }
            (SelectiveImportMode::Overwrite, true) => {
                writes.push((true, entry.clone()));
                counts.overwritten += 1;
            }
            (SelectiveImportMode::Overwrite, false) => {
                writes.push((false, entry.clone()));
                counts.added += 1;
            }
        }
    }
    Ok(PricingImportPlan { counts, writes })
}

fn restore_pricing_snapshot_after_failure(
    file_guard: Option<&crate::services::model_pricing::LocalPricingFileGuard>,
    snapshot: Option<crate::services::model_pricing::LocalPricingFileSnapshot>,
    error: AppError,
) -> AppError {
    let Some(snapshot) = snapshot else {
        return error;
    };
    // A snapshot only exists when the merge ran, which requires the guard.
    let Some(file_guard) = file_guard else {
        return AppError::Config(format!(
            "模型定价导入失败，且无法恢复原定价文件（未持有文件锁）: {error}"
        ));
    };
    match crate::services::model_pricing::restore_local_pricing_file(file_guard, snapshot) {
        Ok(()) => error,
        Err(restore_error) => AppError::Config(format!(
            "模型定价导入失败，且恢复原定价文件失败: {error}；恢复错误: {restore_error}"
        )),
    }
}

fn pricing_exists(conn: &Connection, model_id: &str) -> Result<bool, AppError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM model_pricing WHERE model_id = ?1",
        params![model_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn insert_pricing(conn: &Connection, entry: &ModelPricingInfo) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO model_pricing (
            model_id, display_name, input_cost_per_million, output_cost_per_million,
            cache_read_cost_per_million, cache_creation_cost_per_million
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            entry.model_id,
            entry.display_name,
            entry.input_cost_per_million,
            entry.output_cost_per_million,
            entry.cache_read_cost_per_million,
            entry.cache_creation_cost_per_million
        ],
    )?;
    Ok(())
}

fn upsert_pricing(conn: &Connection, entry: &ModelPricingInfo) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO model_pricing (
            model_id, display_name, input_cost_per_million, output_cost_per_million,
            cache_read_cost_per_million, cache_creation_cost_per_million
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(model_id) DO UPDATE SET
            display_name = excluded.display_name,
            input_cost_per_million = excluded.input_cost_per_million,
            output_cost_per_million = excluded.output_cost_per_million,
            cache_read_cost_per_million = excluded.cache_read_cost_per_million,
            cache_creation_cost_per_million = excluded.cache_creation_cost_per_million",
        params![
            entry.model_id,
            entry.display_name,
            entry.input_cost_per_million,
            entry.output_cost_per_million,
            entry.cache_read_cost_per_million,
            entry.cache_creation_cost_per_million
        ],
    )?;
    Ok(())
}

fn load_custom_app(conn: &Connection, id: &str) -> Result<Option<CustomApp>, AppError> {
    conn.query_row(
        "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
         FROM custom_apps WHERE id = ?1",
        params![id],
        custom_app_from_row,
    )
    .optional()
    .map_err(AppError::from)
}

fn custom_app_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomApp> {
    Ok(CustomApp {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        icon_color: row.get(3)?,
        api_key: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn merge_model_presets(
    current: &[ModelPreset],
    imported: &[ModelPreset],
    mode: SelectiveImportMode,
) -> (Vec<ModelPreset>, Counts) {
    let mut result = current.to_vec();
    let mut counts = Counts::default();
    let mut used_ids: HashSet<String> = current.iter().map(|preset| preset.id.clone()).collect();
    for incoming in imported {
        let existing_index = result.iter().position(|preset| preset.id == incoming.id);
        match (mode, existing_index) {
            (SelectiveImportMode::Overwrite, Some(index)) => {
                result[index] = incoming.clone();
                counts.overwritten += 1;
            }
            (SelectiveImportMode::Overwrite, None) => {
                used_ids.insert(incoming.id.clone());
                result.push(incoming.clone());
                counts.added += 1;
            }
            (SelectiveImportMode::Append, Some(index)) => {
                if presets_equal_except_id(&result[index], incoming) {
                    counts.skipped += 1;
                } else {
                    let new_id = first_available_preset_id(&used_ids, &incoming.id);
                    used_ids.insert(new_id.clone());
                    let mut renamed = incoming.clone();
                    renamed.id = new_id;
                    renamed.name = format!("{}（导入）", incoming.name);
                    result.push(renamed);
                    counts.renamed += 1;
                }
            }
            (SelectiveImportMode::Append, None) => {
                used_ids.insert(incoming.id.clone());
                result.push(incoming.clone());
                counts.added += 1;
            }
        }
    }
    (result, counts)
}

fn plan_model_preset_merge(
    current: &ModelPresetSettings,
    imported_presets: &[ModelPreset],
    imported_generic: Option<&ModelPresetParams>,
    mode: SelectiveImportMode,
    wants_presets: bool,
    wants_generic: bool,
) -> (ModelPresetSettings, Counts, Option<Counts>, bool) {
    let (presets, preset_counts) = if wants_presets {
        merge_model_presets(&current.presets, imported_presets, mode)
    } else {
        (current.presets.clone(), Counts::default())
    };
    let presets_changed = presets != current.presets;

    let generic = if wants_generic && mode == SelectiveImportMode::Overwrite {
        imported_generic
            .cloned()
            .unwrap_or_else(|| current.generic.clone())
    } else {
        // 追加模式只新增模型预设，不得用导入文件中的通用模板覆盖本机模板。
        current.generic.clone()
    };
    let generic_changed = wants_generic && generic != current.generic;
    let generic_counts = wants_generic.then(|| match mode {
        SelectiveImportMode::Overwrite => Counts {
            overwritten: 1,
            ..Counts::default()
        },
        SelectiveImportMode::Append => Counts {
            skipped: 1,
            ..Counts::default()
        },
    });

    (
        ModelPresetSettings { presets, generic },
        preset_counts,
        generic_counts,
        presets_changed || generic_changed,
    )
}

fn presets_equal_except_id(left: &ModelPreset, right: &ModelPreset) -> bool {
    left.name == right.name && left.model_id == right.model_id && left.params == right.params
}

fn first_available_preset_id(used: &HashSet<String>, base: &str) -> String {
    let mut suffix = 2usize;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !used.contains(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn sort_local_rows(rows: &mut [LocalProviderRow]) {
    rows.sort_by(|left, right| {
        left.provider
            .sort_index
            .unwrap_or(usize::MAX)
            .cmp(&right.provider.sort_index.unwrap_or(usize::MAX))
            .then_with(|| left.provider.created_at.cmp(&right.provider.created_at))
            .then_with(|| left.provider.id.cmp(&right.provider.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    // 生产宏会把锁错误转换为 AppError；测试函数允许直接 panic，保持断言简洁。
    macro_rules! lock_conn {
        ($conn:expr) => {
            $conn.lock().expect("test database mutex poisoned")
        };
    }

    fn database() -> Database {
        Database::memory().unwrap()
    }

    fn with_isolated_test_home(test: impl FnOnce(&std::path::Path)) {
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let temp = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| test(temp.path())));

        match previous {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        if let Err(payload) = outcome {
            std::panic::resume_unwind(payload);
        }
    }

    fn provider(id: &str, name: &str) -> Provider {
        Provider {
            id: id.to_string(),
            name: name.to_string(),
            settings_config: json!({"baseURL": "https://example.test"}),
            website_url: Some("https://example.test".to_string()),
            category: Some("custom".to_string()),
            created_at: Some(100),
            sort_index: Some(0),
            notes: None,
            icon: Some("openai".to_string()),
            icon_color: None,
            meta: Some(ProviderMeta::default()),
            in_failover_queue: false,
        }
    }

    fn insert_local_provider(
        db: &Database,
        app_type: &str,
        provider: &Provider,
        is_current: bool,
        in_failover_queue: bool,
        sort_index: i64,
        endpoints: &[&str],
    ) {
        let conn = lock_conn!(db.conn);
        conn.execute(
            "INSERT INTO providers (
                id, app_type, name, settings_config, website_url, category, created_at,
                sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, ?13)",
            params![
                provider.id,
                app_type,
                provider.name,
                serde_json::to_string(&provider.settings_config).unwrap(),
                provider.website_url,
                provider.category,
                provider.created_at,
                sort_index,
                provider.icon,
                provider.icon_color,
                serde_json::to_string(&provider.meta).unwrap(),
                is_current,
                in_failover_queue
            ],
        )
        .unwrap();
        for url in endpoints {
            conn.execute(
                "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at)
                 VALUES (?1, ?2, ?3, 1)",
                params![provider.id, app_type, url],
            )
            .unwrap();
        }
    }

    fn document(providers: Vec<ExportedProviderItem>) -> SelectiveExportFile {
        SelectiveExportFile {
            format: SELECTIVE_EXPORT_FORMAT.to_string(),
            schema_version: SELECTIVE_EXPORT_SCHEMA_VERSION,
            app_version: "test".to_string(),
            exported_at: "2026-01-01T00:00:00+00:00".to_string(),
            providers,
            custom_apps: Vec::new(),
            model_pricing: Vec::new(),
            model_presets: Vec::new(),
            generic_preset: None,
        }
    }

    fn selection_for_provider(app_type: &str, id: &str) -> SelectiveSelection {
        let mut selection = SelectiveSelection::default();
        selection
            .providers
            .insert(app_type.to_string(), vec![id.to_string()]);
        selection
    }

    fn rich_provider_value() -> Value {
        json!({
            "id": "rich-provider",
            "name": "Rich Provider",
            "settingsConfig": {
                "env": {
                    "ANTHROPIC_BASE_URL": "https://rich.test",
                    "ANTHROPIC_AUTH_TOKEN": "secret-token"
                }
            },
            "websiteUrl": "https://rich.test/docs",
            "category": "custom",
            "createdAt": 123456789,
            "sortIndex": 7,
            "notes": "rich round-trip fixture",
            "icon": "anthropic",
            "iconColor": "#123456",
            "meta": {
                "commonConfigEnabled": true,
                "endpointAutoSelect": true,
                "isPartner": true,
                "limitDailyUsd": "12.50",
                "apiFormat": "openai_chat",
                "apiKeyField": "ANTHROPIC_API_KEY",
                "isFullUrl": false,
                "usage_script": {
                    "enabled": true,
                    "language": "javascript",
                    "code": "return 42;",
                    "timeout": 15,
                    "apiKey": "usage-key",
                    "baseUrl": "https://usage.test",
                    "templateType": "general",
                    "autoQueryInterval": 60,
                    "codingPlanProvider": "kimi"
                },
                "claudeDesktopModelRoutes": {
                    "claude-safe-model": {
                        "model": "upstream-model",
                        "labelOverride": "Safe Model",
                        "supports1m": true
                    }
                }
            },
            "inFailoverQueue": true
        })
    }

    fn assert_export_document_round_trip(
        provider_value: Value,
        endpoints: Vec<String>,
    ) -> SelectiveExportFile {
        let provider: Provider =
            serde_json::from_value(provider_value).expect("provider fixture must deserialize");
        let expected_provider = serde_json::to_value(&provider).unwrap();
        let doc = document(vec![ExportedProviderItem {
            app_type: "claude".to_string(),
            provider,
            endpoints: endpoints.clone(),
        }]);
        let mut bytes = serde_json::to_vec_pretty(&doc).expect("serialize export document");
        bytes.push(b'\n');

        let validated =
            validate_import_file_bytes(&bytes).expect("byte validator must accept export");
        assert_eq!(
            serde_json::to_value(&validated.providers[0].provider).unwrap(),
            expected_provider
        );
        assert_eq!(validated.providers[0].endpoints, endpoints);

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("selective-export.json");
        std::fs::write(&path, &bytes).unwrap();
        let from_file = read_and_validate_import_file(&path.display().to_string())
            .expect("file validator must accept export");
        assert_eq!(
            serde_json::to_value(&from_file.providers[0].provider).unwrap(),
            expected_provider
        );
        assert_eq!(from_file.providers[0].endpoints, endpoints);
        from_file
    }

    #[test]
    fn minimal_provider_round_trips_through_export_and_both_validators() {
        let value = json!({
            "id": "minimal",
            "name": "Minimal",
            "settingsConfig": {
                "env": {
                    "ANTHROPIC_BASE_URL": "https://minimal.test"
                }
            }
        });
        assert_export_document_round_trip(value, Vec::new());
    }

    #[test]
    fn rich_provider_round_trips_through_export_and_both_validators() {
        assert_export_document_round_trip(
            rich_provider_value(),
            vec![
                "https://endpoint-one.test".to_string(),
                "https://endpoint-two.test".to_string(),
            ],
        );
    }

    #[test]
    fn export_preview_and_import_round_trip_real_provider() {
        let source = database();
        let provider: Provider = serde_json::from_value(rich_provider_value()).unwrap();
        source.save_provider("claude", &provider).unwrap();

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rich-provider-export.json");
        let selection = selection_for_provider("claude", &provider.id);
        export_selective_config(&source, &path.display().to_string(), &selection).unwrap();

        let target = database();
        let preview = read_selective_import_file(&target, &path.display().to_string()).unwrap();
        let claude = preview
            .catalog
            .providers
            .iter()
            .find(|group| group.app_type == "claude")
            .unwrap();
        assert!(claude.items.iter().any(|item| item.id == "rich-provider"));

        let document = read_and_validate_import_file(&path.display().to_string()).unwrap();
        let summary = import_document(
            &target,
            document,
            &selection,
            SelectiveImportMode::Overwrite,
            false,
        )
        .unwrap();
        assert_eq!(summary.sections[0].added, 1);

        let conn = lock_conn!(target.conn);
        let imported = load_provider_row(&conn, "claude", "rich-provider")
            .unwrap()
            .expect("imported provider must exist");
        assert_eq!(imported.provider.name, "Rich Provider");
        assert_eq!(imported.provider.settings_config, provider.settings_config);
        let meta = imported.provider.meta.unwrap();
        assert_eq!(meta.api_format.as_deref(), Some("openai_chat"));
        assert_eq!(meta.limit_daily_usd.as_deref(), Some("12.50"));
        assert_eq!(
            meta.usage_script.as_ref().unwrap().api_key.as_deref(),
            Some("usage-key")
        );
        assert_eq!(
            meta.claude_desktop_model_routes["claude-safe-model"].model,
            "upstream-model"
        );
    }

    #[test]
    fn catalog_item_serializes_missing_detail_as_null() {
        let item = CatalogItem {
            id: "model".to_string(),
            name: "Model".to_string(),
            detail: None,
            exists: None,
        };
        let value = serde_json::to_value(item).unwrap();
        assert_eq!(value["detail"], Value::Null);
        assert!(value.get("exists").is_none());
    }

    #[test]
    fn catalog_lists_builtin_provider_and_custom_app() {
        let db = database();
        let builtin = provider("p1", "Provider One");
        insert_local_provider(
            &db,
            "claude",
            &builtin,
            true,
            false,
            0,
            &["https://one.test"],
        );
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO custom_apps (id, name, icon, icon_color, api_key, created_at, updated_at)
                 VALUES ('custom-demo', 'Demo', 'openai', '#fff', 'key-demo', 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO providers (
                    id, app_type, name, settings_config, meta
                 ) VALUES ('cp1', 'custom:custom-demo', 'Custom Provider', '{}', '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO model_pricing VALUES ('demo-model', 'Demo Model', '1', '2', '0', '0')",
                [],
            )
            .unwrap();
        }

        let catalog = get_selective_export_catalog(&db).unwrap();
        let claude = catalog
            .providers
            .iter()
            .find(|group| group.app_type == "claude")
            .unwrap();
        assert_eq!(claude.items[0].id, "p1");
        assert_eq!(claude.items[0].detail.as_deref(), Some("https://one.test"));
        assert_eq!(catalog.custom_apps[0].id, "custom-demo");
        assert_eq!(catalog.custom_apps[0].providers[0].id, "cp1");
        let demo_pricing = catalog
            .model_pricing
            .iter()
            .find(|item| item.id == "demo-model")
            .unwrap();
        assert!(demo_pricing.detail.is_none());
        assert!(catalog.has_generic_preset);
    }

    #[test]
    fn overwrite_preserves_current_failover_and_sort_index() {
        let db = database();
        let mut local = provider("p1", "Old Name");
        local.sort_index = Some(5);
        insert_local_provider(&db, "claude", &local, true, true, 5, &["https://old.test"]);
        let mut incoming = provider("p1", "New Name");
        incoming.created_at = Some(200);
        let doc = document(vec![ExportedProviderItem {
            app_type: "claude".to_string(),
            provider: incoming,
            endpoints: vec!["https://new.test".to_string()],
        }]);

        let summary = import_document(
            &db,
            doc,
            &selection_for_provider("claude", "p1"),
            SelectiveImportMode::Overwrite,
            false,
        )
        .unwrap();

        assert_eq!(summary.sections[0].overwritten, 1);
        let conn = lock_conn!(db.conn);
        let row: (String, i64, bool, bool, i64) = conn
            .query_row(
                "SELECT name, sort_index, is_current, in_failover_queue, created_at
                 FROM providers WHERE id = 'p1' AND app_type = 'claude'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, ("New Name".to_string(), 5, true, true, 200));
        let endpoint: String = conn
            .query_row(
                "SELECT url FROM provider_endpoints WHERE provider_id = 'p1' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://new.test");
    }

    #[test]
    fn append_skips_equal_and_renames_different_provider() {
        let db = database();
        let same = provider("p1", "Same");
        insert_local_provider(
            &db,
            "claude",
            &same,
            false,
            false,
            0,
            &["https://same.test"],
        );
        let different_local = provider("p2", "Local Two");
        insert_local_provider(&db, "claude", &different_local, false, false, 1, &[]);
        let endpoint_local = provider("p3", "Endpoint Local");
        insert_local_provider(
            &db,
            "claude",
            &endpoint_local,
            false,
            false,
            2,
            &["https://old-endpoint.test"],
        );

        let doc = document(vec![
            ExportedProviderItem {
                app_type: "claude".to_string(),
                provider: same,
                endpoints: vec!["https://same.test".to_string()],
            },
            ExportedProviderItem {
                app_type: "claude".to_string(),
                provider: provider("p2", "Imported Two"),
                endpoints: vec![],
            },
            ExportedProviderItem {
                app_type: "claude".to_string(),
                provider: endpoint_local,
                endpoints: vec!["https://new-endpoint.test".to_string()],
            },
        ]);
        let mut selection = SelectiveSelection::default();
        selection.providers.insert(
            "claude".to_string(),
            vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
        );

        let summary =
            import_document(&db, doc, &selection, SelectiveImportMode::Append, false).unwrap();
        assert_eq!(summary.sections[0].skipped, 1);
        assert_eq!(summary.sections[0].renamed, 2);

        let conn = lock_conn!(db.conn);
        let name: String = conn
            .query_row(
                "SELECT name FROM providers WHERE id = 'p2-2' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Imported Two（导入）");
        let endpoint: String = conn
            .query_row(
                "SELECT url FROM provider_endpoints
                 WHERE provider_id = 'p3' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://old-endpoint.test");
        let renamed_p3_endpoint: String = conn
            .query_row(
                "SELECT url FROM provider_endpoints
                 WHERE provider_id = 'p3-2' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(renamed_p3_endpoint, "https://new-endpoint.test");
        let renamed_p3_name: String = conn
            .query_row(
                "SELECT name FROM providers WHERE id = 'p3-2' AND app_type = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(renamed_p3_name, "Endpoint Local（导入）");
    }

    #[test]
    fn exported_custom_app_provider_omits_app_type_and_stale_meta_endpoints() {
        let mut item_provider = provider("cp1", "Custom One");
        item_provider
            .meta
            .as_mut()
            .unwrap()
            .custom_endpoints
            .insert(
                "https://legacy.test".to_string(),
                crate::settings::CustomEndpoint {
                    url: "https://legacy.test".to_string(),
                    added_at: 1,
                    last_used: None,
                },
            );
        let item = exported_provider_item(
            String::new(),
            LocalProviderRow {
                provider: item_provider,
                endpoints: vec!["https://current.test".to_string()],
            },
        );
        let value = serde_json::to_value(item).unwrap();
        assert!(value.get("appType").is_none());
        assert_eq!(value["endpoints"], json!(["https://current.test"]));
        assert!(value["provider"]["meta"].get("customEndpoints").is_none());
    }

    fn pricing_entry(model_id: &str, display_name: &str, input: &str) -> ModelPricingInfo {
        ModelPricingInfo {
            model_id: model_id.to_string(),
            display_name: display_name.to_string(),
            input_cost_per_million: input.to_string(),
            output_cost_per_million: "10".to_string(),
            cache_read_cost_per_million: "0".to_string(),
            cache_creation_cost_per_million: "1".to_string(),
        }
    }

    #[test]
    #[serial_test::serial]
    fn overwrite_pricing_merges_override_file_and_survives_local_sync() {
        with_isolated_test_home(|_| {
            let db = Database::init().unwrap();
            {
                let conn = lock_conn!(db.conn);
                conn.execute(
                    "INSERT INTO model_pricing
                     (model_id, display_name, input_cost_per_million, output_cost_per_million,
                      cache_read_cost_per_million, cache_creation_cost_per_million)
                     VALUES ('model-a', 'Database A', '2', '10', '0', '1')",
                    [],
                )
                .unwrap();
            }
            let config_dir = crate::config::get_app_config_dir();
            std::fs::create_dir_all(&config_dir).unwrap();
            let pricing_path = crate::services::model_pricing::model_pricing_file_path();
            std::fs::write(
                &pricing_path,
                serde_json::to_vec_pretty(&json!({
                    "version": 1,
                    "models": [
                        pricing_entry("model-a", "Old A", "1"),
                    ],
                    "deletedModelIds": ["model-b"],
                }))
                .unwrap(),
            )
            .unwrap();

            let mut doc = document(Vec::new());
            doc.model_pricing = vec![
                pricing_entry("model-a", "New A", "20"),
                pricing_entry("model-b", "New B", "30"),
            ];
            let mut selection = SelectiveSelection::default();
            selection.model_pricing = vec!["model-a".to_string(), "model-b".to_string()];

            let summary =
                import_document(&db, doc, &selection, SelectiveImportMode::Overwrite, true)
                    .unwrap();
            let section = summary
                .sections
                .iter()
                .find(|section| section.section == "modelPricing")
                .unwrap();
            assert_eq!(section.overwritten, 1);
            assert_eq!(section.added, 1);

            let file: Value =
                serde_json::from_slice(&std::fs::read(&pricing_path).unwrap()).unwrap();
            let models = file["models"].as_array().unwrap();
            let model_a = models
                .iter()
                .find(|entry| entry["modelId"] == "model-a")
                .unwrap();
            assert_eq!(model_a["inputCostPerMillion"], "20");
            assert!(models.iter().any(|entry| entry["modelId"] == "model-b"));
            assert!(!file["deletedModelIds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|id| id == "model-b"));

            {
                let conn = lock_conn!(db.conn);
                let input_before: String = conn
                    .query_row(
                        "SELECT input_cost_per_million FROM model_pricing WHERE model_id = 'model-a'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(input_before, "20");
            }

            crate::services::model_pricing::sync_local_model_pricing(&db).unwrap();
            let conn = lock_conn!(db.conn);
            let input_after: String = conn
                .query_row(
                    "SELECT input_cost_per_million FROM model_pricing WHERE model_id = 'model-a'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let display_after: String = conn
                .query_row(
                    "SELECT display_name FROM model_pricing WHERE model_id = 'model-b'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(input_after, "20");
            assert_eq!(display_after, "New B");
        });
    }

    #[test]
    #[serial_test::serial]
    fn failed_import_restores_local_pricing_file_exactly() {
        with_isolated_test_home(|_| {
            let db = Database::init().unwrap();
            {
                let conn = lock_conn!(db.conn);
                conn.execute(
                    "INSERT INTO model_pricing
                     (model_id, display_name, input_cost_per_million, output_cost_per_million,
                      cache_read_cost_per_million, cache_creation_cost_per_million)
                     VALUES ('model-a', 'Database A', '2', '10', '0', '1')",
                    [],
                )
                .unwrap();
                conn.execute(
                    "CREATE TRIGGER fail_selective_provider_insert
                     BEFORE INSERT ON providers
                     WHEN NEW.id = 'trigger-failure'
                     BEGIN
                         SELECT RAISE(ABORT, 'forced provider failure');
                     END",
                    [],
                )
                .unwrap();
            }

            let config_dir = crate::config::get_app_config_dir();
            std::fs::create_dir_all(&config_dir).unwrap();
            let pricing_path = crate::services::model_pricing::model_pricing_file_path();
            let original_file = br#"{
  "version": 1,
  "models": [{"modelId": "model-a", "displayName": "Old A", "inputCostPerMillion": "1", "outputCostPerMillion": "2", "cacheReadCostPerMillion": "0", "cacheCreationCostPerMillion": "0"}],
  "deletedModelIds": ["model-b"]
}
"#
            .to_vec();
            std::fs::write(&pricing_path, &original_file).unwrap();

            let mut doc = document(vec![ExportedProviderItem {
                app_type: "claude".to_string(),
                provider: provider("trigger-failure", "Trigger Failure"),
                endpoints: vec!["https://trigger.test".to_string()],
            }]);
            doc.model_pricing = vec![pricing_entry("model-a", "New A", "20")];
            let mut selection = selection_for_provider("claude", "trigger-failure");
            selection.model_pricing = vec!["model-a".to_string()];

            let error = import_document(&db, doc, &selection, SelectiveImportMode::Overwrite, true)
                .unwrap_err();
            assert!(
                error.to_string().contains("forced provider failure"),
                "unexpected import error: {error}"
            );
            assert_eq!(std::fs::read(&pricing_path).unwrap(), original_file);

            let conn = lock_conn!(db.conn);
            let input_after: String = conn
                .query_row(
                    "SELECT input_cost_per_million FROM model_pricing WHERE model_id = 'model-a'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let provider_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM providers WHERE id = 'trigger-failure'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(input_after, "2");
            assert_eq!(provider_count, 0);
        });
    }

    #[test]
    #[serial_test::serial]
    fn missing_database_backup_aborts_import_before_any_write() {
        with_isolated_test_home(|_| {
            let db = database();
            let local = provider("p1", "Local");
            insert_local_provider(&db, "claude", &local, false, false, 0, &[]);
            let doc = document(vec![ExportedProviderItem {
                app_type: "claude".to_string(),
                provider: provider("p1", "Imported"),
                endpoints: vec!["https://imported.test".to_string()],
            }]);

            let result = import_document(
                &db,
                doc,
                &selection_for_provider("claude", "p1"),
                SelectiveImportMode::Overwrite,
                true,
            );
            match result {
                Err(AppError::Config(message)) => assert_eq!(
                    message,
                    "导入前备份数据库失败：未找到数据库文件，已取消导入"
                ),
                other => panic!("expected backup error, got {other:?}"),
            }

            let conn = lock_conn!(db.conn);
            let name: String = conn
                .query_row(
                    "SELECT name FROM providers WHERE id = 'p1' AND app_type = 'claude'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let endpoint_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM provider_endpoints
                     WHERE provider_id = 'p1' AND app_type = 'claude'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(name, "Local");
            assert_eq!(endpoint_count, 0);
        });
    }

    #[test]
    fn append_skips_existing_pricing_and_adds_new_pricing() {
        let db = database();
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO model_pricing VALUES ('same-model', 'Old', '1', '2', '0', '0')",
                [],
            )
            .unwrap();
        }
        let mut doc = document(Vec::new());
        doc.model_pricing = vec![
            ModelPricingInfo {
                model_id: "same-model".to_string(),
                display_name: "New".to_string(),
                input_cost_per_million: "9".to_string(),
                output_cost_per_million: "10".to_string(),
                cache_read_cost_per_million: "0".to_string(),
                cache_creation_cost_per_million: "0".to_string(),
            },
            ModelPricingInfo {
                model_id: "new-model".to_string(),
                display_name: "New Model".to_string(),
                input_cost_per_million: "3".to_string(),
                output_cost_per_million: "4".to_string(),
                cache_read_cost_per_million: "0".to_string(),
                cache_creation_cost_per_million: "0".to_string(),
            },
        ];
        let mut selection = SelectiveSelection::default();
        selection.model_pricing = vec!["same-model".to_string(), "new-model".to_string()];

        let summary =
            import_document(&db, doc, &selection, SelectiveImportMode::Append, false).unwrap();
        let section = summary
            .sections
            .iter()
            .find(|section| section.section == "modelPricing")
            .unwrap();
        assert_eq!(section.skipped, 1);
        assert_eq!(section.added, 1);

        let conn = lock_conn!(db.conn);
        let display: String = conn
            .query_row(
                "SELECT display_name FROM model_pricing WHERE model_id = 'same-model'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(display, "Old");
    }

    #[test]
    fn custom_app_overwrite_keeps_api_key_and_create_generates_key() {
        let db = database();
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO custom_apps (id, name, icon, icon_color, api_key, created_at, updated_at)
                 VALUES ('custom-existing', 'Before', 'openai', NULL, 'keep-me', 1, 1)",
                [],
            )
            .unwrap();
        }
        let mut doc = document(Vec::new());
        doc.custom_apps = vec![
            ExportedCustomApp {
                app: ExportedCustomAppInfo {
                    id: "custom-existing".to_string(),
                    name: "After".to_string(),
                    icon: "claude".to_string(),
                    icon_color: Some("#123".to_string()),
                },
                providers: Vec::new(),
            },
            ExportedCustomApp {
                app: ExportedCustomAppInfo {
                    id: "custom-new".to_string(),
                    name: "New App".to_string(),
                    icon: "openai".to_string(),
                    icon_color: None,
                },
                providers: Vec::new(),
            },
        ];
        let mut selection = SelectiveSelection::default();
        selection.custom_apps = vec!["custom-existing".to_string(), "custom-new".to_string()];

        import_document(&db, doc, &selection, SelectiveImportMode::Overwrite, false).unwrap();

        let conn = lock_conn!(db.conn);
        let existing: (String, String) = conn
            .query_row(
                "SELECT name, api_key FROM custom_apps WHERE id = 'custom-existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(existing, ("After".to_string(), "keep-me".to_string()));
        let created_key: String = conn
            .query_row(
                "SELECT api_key FROM custom_apps WHERE id = 'custom-new'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!created_key.is_empty());
        assert_ne!(created_key, "keep-me");
    }

    #[test]
    fn provider_explicit_null_optional_fields_remain_readable() {
        let value = json!({
            "id": "null-provider",
            "name": "Null Provider",
            "settingsConfig": {},
            "websiteUrl": null,
            "category": null,
            "createdAt": null,
            "sortIndex": null,
            "notes": null,
            "meta": null,
            "icon": null,
            "iconColor": null,
            "inFailoverQueue": false
        });
        let provider: Provider =
            serde_json::from_value(value).expect("null option fields are valid");
        assert!(provider.website_url.is_none());
        assert!(provider.created_at.is_none());
        assert!(provider.sort_index.is_none());
        assert!(provider.notes.is_none());
        assert!(provider.meta.is_none());
        assert!(provider.icon.is_none());
        assert!(provider.icon_color.is_none());
        assert!(!provider.in_failover_queue);
    }

    #[test]
    fn validation_rejects_wrong_format_schema_and_app_type() {
        let valid = serde_json::to_vec(&document(Vec::new())).unwrap();
        let mut value: Value = serde_json::from_slice(&valid).unwrap();
        value["format"] = json!("wrong");
        let error = validate_import_file_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.to_string().contains("格式"));

        let mut value: Value = serde_json::from_slice(&valid).unwrap();
        value["schemaVersion"] = json!(2);
        let error = validate_import_file_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.to_string().contains("版本"));

        let mut value: Value = serde_json::from_slice(&valid).unwrap();
        value["providers"] = json!([{
            "appType": "unknown-app",
            "provider": {
                "id": "p1",
                "name": "P1",
                "settingsConfig": {}
            },
            "endpoints": []
        }]);
        let error = validate_import_file_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.to_string().contains("应用类型"));
    }

    fn preset(id: &str, name: &str, model: &str) -> ModelPreset {
        ModelPreset {
            id: id.to_string(),
            name: name.to_string(),
            model_id: model.to_string(),
            params: ModelPresetParams {
                temperature: Some(0.2),
                extra_params: BTreeMap::new(),
                ..ModelPresetParams::default()
            },
        }
    }

    fn preset_params(marker: &str) -> ModelPresetParams {
        ModelPresetParams {
            extra_params: BTreeMap::from([(
                "marker".to_string(),
                Value::String(marker.to_string()),
            )]),
            ..ModelPresetParams::default()
        }
    }

    #[test]
    fn append_adds_preset_without_touching_local_generic_template() {
        let local_generic = preset_params("local");
        let imported_generic = preset_params("imported");
        let current = ModelPresetSettings {
            presets: Vec::new(),
            generic: local_generic.clone(),
        };
        let imported = vec![preset("new", "New", "model-new")];

        let (planned, preset_counts, generic_counts, changed) = plan_model_preset_merge(
            &current,
            &imported,
            Some(&imported_generic),
            SelectiveImportMode::Append,
            true,
            true,
        );

        assert_eq!(planned.presets, imported);
        assert_eq!(planned.generic, local_generic);
        assert_eq!(preset_counts.added, 1);
        assert_eq!(
            generic_counts,
            Some(Counts {
                skipped: 1,
                ..Counts::default()
            })
        );
        assert!(changed);
    }

    #[test]
    fn append_generic_preset_alone_reports_skipped_and_unchanged() {
        let local_generic = preset_params("local");
        let imported_generic = preset_params("imported");
        let current = ModelPresetSettings {
            presets: vec![preset("existing", "Existing", "model-existing")],
            generic: local_generic.clone(),
        };

        let (planned, preset_counts, generic_counts, changed) = plan_model_preset_merge(
            &current,
            &[],
            Some(&imported_generic),
            SelectiveImportMode::Append,
            false,
            true,
        );

        assert_eq!(planned, current);
        assert_eq!(preset_counts, Counts::default());
        assert_eq!(
            generic_counts,
            Some(Counts {
                skipped: 1,
                ..Counts::default()
            })
        );
        assert!(!changed);
    }

    #[test]
    fn overwrite_generic_preset_uses_imported_template() {
        let local_generic = preset_params("local");
        let imported_generic = preset_params("imported");
        let current = ModelPresetSettings {
            presets: Vec::new(),
            generic: local_generic,
        };

        let (planned, _, generic_counts, changed) = plan_model_preset_merge(
            &current,
            &[],
            Some(&imported_generic),
            SelectiveImportMode::Overwrite,
            false,
            true,
        );

        assert_eq!(planned.generic, imported_generic);
        assert_eq!(
            generic_counts,
            Some(Counts {
                overwritten: 1,
                ..Counts::default()
            })
        );
        assert!(changed);
    }

    #[test]
    fn preset_merge_overwrite_append_skip_and_rename() {
        let current = vec![preset("a", "A", "model-a")];
        let imported = vec![
            preset("a", "A", "model-a"),
            preset("a", "A Renamed", "model-a-2"),
        ];

        let (overwritten, counts) =
            merge_model_presets(&current, &imported[..1], SelectiveImportMode::Overwrite);
        assert_eq!(overwritten.len(), 1);
        assert_eq!(overwritten[0].name, "A");
        assert_eq!(counts.overwritten, 1);

        let (merged, counts) =
            merge_model_presets(&current, &imported, SelectiveImportMode::Append);
        assert_eq!(merged.len(), 2);
        assert_eq!(counts.skipped, 1);
        assert_eq!(counts.renamed, 1);
        assert_eq!(merged[1].id, "a-2");
        assert_eq!(merged[1].name, "A Renamed（导入）");
    }
}
