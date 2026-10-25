//! 自定义应用（聚合路由）服务层。
//!
//! 自定义应用只保存名称、图标和本地 API Key；供应商与模型始终来自 providers 表。

use crate::app_config::AppType;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::Provider;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// 自定义应用。API 地址由前端根据当前代理端口拼接，数据库不保存端口/地址。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomApp {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub icon_color: Option<String>,
    pub api_key: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 聚合模型。id 是对外模型 id（<upstreamModel>-<providerId>）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomAppModel {
    pub id: String,
    pub upstream_model: String,
    pub provider_id: String,
    pub provider_name: String,
    pub app_type: String,
}

/// 一次已解析的模型路由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomModelRoute {
    pub model: CustomAppModel,
    pub upstream_model: String,
}

fn custom_app_from_row(row: &Row<'_>) -> rusqlite::Result<CustomApp> {
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

fn normalize_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("自定义应用名称不能为空".to_string()));
    }
    Ok(name.to_string())
}

fn normalize_icon(icon: &str) -> String {
    let icon = icon.trim();
    if icon.is_empty() {
        "openai".to_string()
    } else {
        icon.to_string()
    }
}

fn normalize_icon_color(icon_color: Option<String>) -> Option<String> {
    icon_color
        .map(|color| color.trim().to_string())
        .filter(|color| !color.is_empty())
}

pub(crate) fn generate_custom_app_id() -> String {
    format!("custom-{}", uuid::Uuid::new_v4())
}

/// ccs_ + 48 位随机十六进制（一个 UUID v4 全量 + 另一个 UUID 的前 16 位）。
pub(crate) fn generate_custom_app_api_key() -> String {
    let first = uuid::Uuid::new_v4().simple().to_string();
    let second = uuid::Uuid::new_v4().simple().to_string();
    assert_eq!(first.len(), 32);
    assert_eq!(second.len(), 32);
    format!("ccs_{}{}", first, &second[..16])
}

fn add_model_value(models: &mut BTreeSet<String>, value: Option<&serde_json::Value>) {
    if let Some(value) = value.and_then(serde_json::Value::as_str) {
        let value = value.trim();
        if !value.is_empty() {
            models.insert(value.to_string());
        }
    }
}

fn add_model_object(models: &mut BTreeSet<String>, value: &serde_json::Value, include_name: bool) {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        if !value.is_empty() {
            models.insert(value.to_string());
            return;
        }
    }
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["id", "model", "slug"] {
        if let Some(value) = object.get(key).and_then(serde_json::Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                models.insert(value.to_string());
                return;
            }
        }
    }
    if include_name {
        if let Some(value) = object.get("name").and_then(serde_json::Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                models.insert(value.to_string());
            }
        }
    }
}

fn add_model_container(
    models: &mut BTreeSet<String>,
    value: Option<&serde_json::Value>,
    include_name: bool,
) {
    let Some(value) = value else {
        return;
    };
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                add_model_object(models, item, include_name);
            }
        }
        serde_json::Value::Object(object) => {
            // models 对象形态按 keys 读取；modelCatalog.models 同样容错支持对象。
            for key in object.keys() {
                let key = key.trim();
                if !key.is_empty() {
                    models.insert(key.to_string());
                }
            }
        }
        _ => {}
    }
}

fn config_text(settings: &serde_json::Value) -> &str {
    settings
        .get("config")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

fn is_openai_chat_protocol(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    matches!(
        normalized.as_str(),
        "openai-completions"
            | "openai-compatible"
            | "openai-chat"
            | "chat-completions"
            | "@ai-sdk/openai-compatible"
    )
}

fn explicit_openai_chat_protocol<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> bool {
    let mut saw_protocol = false;
    for value in values.into_iter().flatten() {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        saw_protocol = true;
        if !is_openai_chat_protocol(value) {
            return false;
        }
    }
    saw_protocol
}

fn codex_uses_chat_wire_api(settings: &serde_json::Value) -> bool {
    let config = config_text(settings);
    let Ok(document) = config.parse::<toml::Value>() else {
        return false;
    };
    let Some(root) = document.as_table() else {
        return false;
    };
    let wire_api = match root
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
    {
        Some(provider) => root
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get(provider))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("wire_api"))
            .and_then(toml::Value::as_str),
        None => root.get("wire_api").and_then(toml::Value::as_str),
    };
    wire_api.is_some_and(|wire_api| wire_api.trim() == "chat")
}

fn grok_uses_chat_api_backend(settings: &serde_json::Value) -> bool {
    crate::grok_config::extract_model_config(config_text(settings))
        .is_some_and(|config| config.api_backend == "chat")
}

/// `/custom` 的 chat completions 入口只能接入确认实现 OpenAI Chat 协议的供应商。
fn provider_supports_openai_chat(app_type: &AppType, provider: &Provider) -> bool {
    let settings = &provider.settings_config;
    match app_type {
        AppType::Codex => codex_uses_chat_wire_api(settings),
        AppType::GrokBuild => grok_uses_chat_api_backend(settings),
        AppType::DeepSeekHarness => {
            settings.get("api").and_then(serde_json::Value::as_str) == Some("openai-completions")
        }
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::Pi | AppType::Mcode => {
            let mut values = vec![
                settings.get("api").and_then(serde_json::Value::as_str),
                settings
                    .get("apiFormat")
                    .and_then(serde_json::Value::as_str),
                settings
                    .get("api_format")
                    .and_then(serde_json::Value::as_str),
            ];
            match app_type {
                AppType::OpenCode => {
                    values.push(settings.get("npm").and_then(serde_json::Value::as_str))
                }
                AppType::Hermes => {
                    values.push(settings.get("api_mode").and_then(serde_json::Value::as_str))
                }
                _ => {}
            }
            values.push(
                provider
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.api_format.as_deref()),
            );
            explicit_openai_chat_protocol(values)
        }
        AppType::Claude | AppType::ClaudeDesktop | AppType::Gemini => false,
    }
}

/// 从单个 provider.settings_config 提取全部模型 id。
pub(crate) fn extract_provider_model_ids(
    settings: &serde_json::Value,
    app_type: &AppType,
) -> Vec<String> {
    let mut models = BTreeSet::new();

    add_model_container(
        &mut models,
        settings
            .get("modelCatalog")
            .and_then(|catalog| catalog.get("models")),
        false,
    );
    add_model_container(&mut models, settings.get("models"), true);

    for key in ["model", "defaultModel", "modelId"] {
        add_model_value(&mut models, settings.get(key));
    }

    if let Some(env) = settings.get("env").and_then(serde_json::Value::as_object) {
        for (key, value) in env {
            if key == "ANTHROPIC_MODEL"
                || key.starts_with("ANTHROPIC_DEFAULT_")
                || key == "OPENAI_MODEL"
                || key == "GEMINI_MODEL"
            {
                add_model_value(&mut models, Some(value));
            }
        }
    }

    let config = config_text(settings);
    match app_type {
        AppType::Codex => {
            models.extend(crate::codex_config::codex_published_models(
                settings, config,
            ));
        }
        AppType::GrokBuild => {
            models.extend(crate::grok_config::published_models(config));
        }
        _ => {}
    }

    models.into_iter().collect()
}

/// providers 表（全部固定应用）→ 对外模型列表。
pub(crate) fn aggregate_provider_models(providers: &[(AppType, Provider)]) -> Vec<CustomAppModel> {
    let mut by_external_id: BTreeMap<String, CustomAppModel> = BTreeMap::new();

    for (app_type, provider) in providers {
        if provider.id.trim().is_empty() {
            log::warn!("[custom-apps] 跳过空 provider id 的模型聚合行");
            continue;
        }
        if !provider_supports_openai_chat(app_type, provider) {
            continue;
        }
        for upstream_model in extract_provider_model_ids(&provider.settings_config, app_type) {
            let id = format!("{upstream_model}-{}", provider.id);
            let candidate = CustomAppModel {
                id: id.clone(),
                upstream_model,
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                app_type: app_type.as_str().to_string(),
            };
            match by_external_id.get(&id) {
                None => {
                    by_external_id.insert(id, candidate);
                }
                Some(existing) => {
                    let existing_key = (
                        existing.app_type.as_str(),
                        existing.provider_id.as_str(),
                        existing.upstream_model.as_str(),
                    );
                    let candidate_key = (
                        candidate.app_type.as_str(),
                        candidate.provider_id.as_str(),
                        candidate.upstream_model.as_str(),
                    );
                    if candidate_key < existing_key {
                        log::warn!(
                            "[custom-apps] 外部模型 id '{}' 冲突，保留 {} / {} / {}，替换 {} / {} / {}",
                            id,
                            candidate.app_type,
                            candidate.provider_id,
                            candidate.upstream_model,
                            existing.app_type,
                            existing.provider_id,
                            existing.upstream_model
                        );
                        by_external_id.insert(id, candidate);
                    } else {
                        log::warn!(
                            "[custom-apps] 外部模型 id '{}' 冲突，保留 {} / {} / {}，忽略 {} / {} / {}",
                            id,
                            existing.app_type,
                            existing.provider_id,
                            existing.upstream_model,
                            candidate.app_type,
                            candidate.provider_id,
                            candidate.upstream_model
                        );
                    }
                }
            }
        }
    }

    by_external_id.into_values().collect()
}

/// 先精确匹配外部 id，再按最长 provider id 后缀解析。
pub(crate) fn resolve_model_route(
    models: &[CustomAppModel],
    requested_id: &str,
) -> Option<CustomModelRoute> {
    if let Some(model) = models.iter().find(|model| model.id == requested_id) {
        return Some(CustomModelRoute {
            upstream_model: model.upstream_model.clone(),
            model: model.clone(),
        });
    }

    let mut routes: BTreeMap<(String, String), String> = BTreeMap::new();
    for model in models {
        routes
            .entry((model.app_type.clone(), model.provider_id.clone()))
            .or_insert_with(|| model.provider_name.clone());
    }

    let mut providers: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for ((app_type, provider_id), provider_name) in routes {
        providers
            .entry(provider_id)
            .or_default()
            .push((app_type, provider_name));
    }
    let mut providers: Vec<(String, Vec<(String, String)>)> = providers.into_iter().collect();
    providers.sort_by(|left, right| {
        right
            .0
            .len()
            .cmp(&left.0.len())
            .then_with(|| left.0.cmp(&right.0))
    });

    for (provider_id, mut routes) in providers {
        let suffix = format!("-{provider_id}");
        let Some(upstream_model) = requested_id.strip_suffix(&suffix) else {
            continue;
        };
        let upstream_model = upstream_model.trim();
        if upstream_model.is_empty() {
            continue;
        }

        routes.sort_by(|left, right| left.0.cmp(&right.0));
        let app_types: BTreeSet<&str> = routes
            .iter()
            .map(|(app_type, _)| app_type.as_str())
            .collect();
        if app_types.len() != 1 {
            return None;
        }
        let (app_type, provider_name) = routes.remove(0);
        return Some(CustomModelRoute {
            model: CustomAppModel {
                id: requested_id.to_string(),
                upstream_model: upstream_model.to_string(),
                provider_id,
                provider_name,
                app_type,
            },
            upstream_model: upstream_model.to_string(),
        });
    }
    None
}

pub(crate) fn list_custom_app_models(db: &Database) -> Result<Vec<CustomAppModel>, AppError> {
    let providers = db.get_all_providers_cross_app()?;
    Ok(aggregate_provider_models(&providers))
}

impl Database {
    pub(crate) fn list_custom_apps(&self) -> Result<Vec<CustomApp>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
                 FROM custom_apps ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], custom_app_from_row)
            .map_err(|e| AppError::Database(e.to_string()))?;
        rows.map(|row| row.map_err(|e| AppError::Database(e.to_string())))
            .collect()
    }

    pub(crate) fn get_custom_app_by_api_key(
        &self,
        api_key: &str,
    ) -> Result<Option<CustomApp>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
             FROM custom_apps WHERE api_key = ?1",
            params![api_key],
            custom_app_from_row,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn get_custom_app_by_id(&self, id: &str) -> Result<Option<CustomApp>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
             FROM custom_apps WHERE id = ?1",
            params![id],
            custom_app_from_row,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn create_custom_app(
        &self,
        name: &str,
        icon: &str,
        icon_color: Option<String>,
    ) -> Result<CustomApp, AppError> {
        let name = normalize_name(name)?;
        let icon = normalize_icon(icon);
        let icon_color = normalize_icon_color(icon_color);
        let id = generate_custom_app_id();
        let api_key = generate_custom_app_api_key();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO custom_apps
             (id, name, icon, icon_color, api_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, icon, icon_color, api_key, now],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        conn.query_row(
            "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
             FROM custom_apps WHERE id = ?1",
            params![id],
            custom_app_from_row,
        )
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn update_custom_app(
        &self,
        id: &str,
        name: &str,
        icon: &str,
        icon_color: Option<String>,
    ) -> Result<CustomApp, AppError> {
        let name = normalize_name(name)?;
        let icon = normalize_icon(icon);
        let icon_color = normalize_icon_color(icon_color);
        let now = chrono::Utc::now().timestamp_millis();
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute(
                "UPDATE custom_apps
                 SET name = ?2, icon = ?3, icon_color = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![id, name, icon, icon_color, now],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if affected == 0 {
            return Err(AppError::InvalidInput("自定义应用不存在".to_string()));
        }
        conn.query_row(
            "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
             FROM custom_apps WHERE id = ?1",
            params![id],
            custom_app_from_row,
        )
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn delete_custom_app(&self, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute("DELETE FROM custom_apps WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }

    pub(crate) fn regenerate_custom_app_key(&self, id: &str) -> Result<CustomApp, AppError> {
        let api_key = generate_custom_app_api_key();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute(
                "UPDATE custom_apps SET api_key = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, api_key, now],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if affected == 0 {
            return Err(AppError::InvalidInput("自定义应用不存在".to_string()));
        }
        conn.query_row(
            "SELECT id, name, icon, icon_color, api_key, created_at, updated_at
             FROM custom_apps WHERE id = ?1",
            params![id],
            custom_app_from_row,
        )
        .map_err(|e| AppError::Database(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(id: &str, name: &str, settings: serde_json::Value) -> Provider {
        let mut provider = Provider::with_id(id.to_string(), name.to_string(), settings, None);
        provider.meta = None;
        provider
    }

    fn codex_settings(model: &str, wire_api: &str) -> serde_json::Value {
        json!({
            "config": format!(
                "model_provider = \"custom\"\nmodel = \"{model}\"\n\n[model_providers.custom]\nbase_url = \"https://example.com/v1\"\nwire_api = \"{wire_api}\"\n"
            )
        })
    }

    fn grok_settings(profile: &str, api_backend: &str) -> serde_json::Value {
        json!({
            "config": format!(
                "[models]\ndefault = \"{profile}\"\n\n[model.\"{profile}\"]\nmodel = \"{profile}\"\nname = \"{profile}\"\nbase_url = \"https://example.com/v1\"\napi_key = \"key\"\napi_backend = \"{api_backend}\"\ncontext_window = 500000\n"
            )
        })
    }

    #[test]
    fn extracts_models_from_supported_shapes() {
        let settings = json!({
            "modelCatalog": {
                "models": [
                    {"id": "catalog-id"},
                    {"model": "catalog-model"},
                    {"slug": "catalog-slug"}
                ]
            },
            "models": [
                "string-model",
                {"id": "array-id"},
                {"model": "array-model"},
                {"slug": "array-slug"},
                {"name": "array-name"}
            ],
            "model": "top-model",
            "defaultModel": "default-model",
            "modelId": "model-id",
            "env": {
                "ANTHROPIC_MODEL": "anthropic-model",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic-sonnet",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic-opus",
                "OPENAI_MODEL": "openai-model",
                "GEMINI_MODEL": "gemini-model",
                "IGNORED": "ignored"
            }
        });
        assert_eq!(
            extract_provider_model_ids(&settings, &AppType::OpenClaw),
            vec![
                "anthropic-model",
                "anthropic-opus",
                "anthropic-sonnet",
                "array-id",
                "array-model",
                "array-name",
                "array-slug",
                "catalog-id",
                "catalog-model",
                "catalog-slug",
                "default-model",
                "gemini-model",
                "model-id",
                "openai-model",
                "string-model",
                "top-model",
            ]
        );
    }

    #[test]
    fn models_object_uses_keys_and_empty_values_are_ignored() {
        let settings = json!({
            "models": {
                "key-a": {"id": "nested-not-used"},
                "key-b": {}
            },
            "model": "   ",
            "env": {"OPENAI_MODEL": ""}
        });
        assert_eq!(
            extract_provider_model_ids(&settings, &AppType::OpenClaw),
            vec!["key-a".to_string(), "key-b".to_string()]
        );
    }

    #[test]
    fn extracts_codex_and_grok_models_from_config_text() {
        let codex = codex_settings("codex-config-model", "chat");
        assert_eq!(
            extract_provider_model_ids(&codex, &AppType::Codex),
            vec!["codex-config-model"]
        );

        let grok = json!({
            "config": r#"[models]
default = "grok-fast"

[model."grok-fast"]
model = "grok-fast"

[model."grok-pro"]
model = "grok-pro"
"#
        });
        assert_eq!(
            extract_provider_model_ids(&grok, &AppType::GrokBuild),
            vec!["grok-fast", "grok-pro"]
        );
    }

    #[test]
    fn aggregate_suffixes_and_deduplicates_with_deterministic_conflict_winner() {
        let providers = vec![
            (
                AppType::Codex,
                provider("z", "Z", codex_settings("same", "chat")),
            ),
            (
                AppType::OpenClaw,
                provider(
                    "a",
                    "A",
                    json!({"api": "openai-completions", "model": "same"}),
                ),
            ),
        ];
        let models = aggregate_provider_models(&providers);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "same-a");
        assert_eq!(models[0].app_type, "openclaw");
        assert_eq!(models[1].id, "same-z");
        assert_eq!(models[1].app_type, "codex");
    }

    #[test]
    fn aggregate_conflict_keeps_lexicographically_smallest_route() {
        let providers = vec![
            (
                AppType::Codex,
                provider("p", "P1", codex_settings("x-p", "chat")),
            ),
            (
                AppType::OpenClaw,
                provider(
                    "p-p",
                    "P2",
                    json!({"api": "openai-completions", "model": "x"}),
                ),
            ),
        ];
        // 两者都生成 x-p-p；按 (appType, providerId, model) 保留 codex / p / x-p。
        let models = aggregate_provider_models(&providers);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "x-p-p");
        assert_eq!(models[0].app_type, "codex");
        assert_eq!(models[0].provider_id, "p");
        assert_eq!(models[0].upstream_model, "x-p");
    }

    #[test]
    fn aggregate_only_includes_openai_chat_compatible_providers() {
        let providers = vec![
            (
                AppType::Codex,
                provider("codex-ok", "Codex OK", codex_settings("codex-ok", "chat")),
            ),
            (
                AppType::Codex,
                provider(
                    "codex-no",
                    "Codex Responses",
                    codex_settings("codex-no", "responses"),
                ),
            ),
            (
                AppType::GrokBuild,
                provider("grok-ok", "Grok OK", grok_settings("grok-ok", "chat")),
            ),
            (
                AppType::GrokBuild,
                provider(
                    "grok-no",
                    "Grok Responses",
                    grok_settings("grok-no", "responses"),
                ),
            ),
            (
                AppType::DeepSeekHarness,
                provider(
                    "dsh-ok",
                    "DSH OK",
                    json!({"api": "openai-completions", "model": "dsh-ok"}),
                ),
            ),
            (
                AppType::DeepSeekHarness,
                provider(
                    "dsh-no",
                    "DSH Responses",
                    json!({"api": "openai-responses", "model": "dsh-no"}),
                ),
            ),
            (
                AppType::OpenCode,
                provider(
                    "opencode-ok",
                    "OpenCode OK",
                    json!({
                        "npm": "@ai-sdk/openai-compatible",
                        "models": {"opencode-ok": {}}
                    }),
                ),
            ),
            (
                AppType::OpenCode,
                provider(
                    "opencode-no",
                    "OpenCode Responses",
                    json!({"npm": "@ai-sdk/openai", "models": {"opencode-no": {}}}),
                ),
            ),
            (
                AppType::OpenClaw,
                provider(
                    "openclaw-ok",
                    "OpenClaw OK",
                    json!({"api": "openai-completions", "model": "openclaw-ok"}),
                ),
            ),
            (
                AppType::OpenClaw,
                provider(
                    "openclaw-no",
                    "OpenClaw Responses",
                    json!({"api": "openai-responses", "model": "openclaw-no"}),
                ),
            ),
            (
                AppType::Hermes,
                provider(
                    "hermes-ok",
                    "Hermes OK",
                    json!({"api_mode": "chat_completions", "model": "hermes-ok"}),
                ),
            ),
            (
                AppType::Hermes,
                provider(
                    "hermes-no",
                    "Hermes Responses",
                    json!({"api_mode": "codex_responses", "model": "hermes-no"}),
                ),
            ),
            (
                AppType::Pi,
                provider(
                    "pi-ok",
                    "Pi OK",
                    json!({"api": "openai-completions", "model": "pi-ok"}),
                ),
            ),
            (
                AppType::Pi,
                provider(
                    "pi-no",
                    "Pi Anthropic",
                    json!({"api": "anthropic-messages", "model": "pi-no"}),
                ),
            ),
            (
                AppType::Mcode,
                provider(
                    "mcode-ok",
                    "Mcode OK",
                    json!({"api": "openai-completions", "model": "mcode-ok"}),
                ),
            ),
            (
                AppType::Mcode,
                provider(
                    "mcode-no",
                    "Mcode Responses",
                    json!({"api": "openai-responses", "model": "mcode-no"}),
                ),
            ),
            (
                AppType::Claude,
                provider(
                    "claude-no",
                    "Claude",
                    json!({"api": "openai-completions", "model": "claude-no"}),
                ),
            ),
            (
                AppType::ClaudeDesktop,
                provider(
                    "desktop-no",
                    "Claude Desktop",
                    json!({"api": "openai-completions", "model": "desktop-no"}),
                ),
            ),
            (
                AppType::Gemini,
                provider(
                    "gemini-no",
                    "Gemini",
                    json!({"api": "openai-completions", "model": "gemini-no"}),
                ),
            ),
        ];

        let models = aggregate_provider_models(&providers);
        let mut provider_ids: Vec<&str> = models
            .iter()
            .map(|model| model.provider_id.as_str())
            .collect();
        provider_ids.sort_unstable();
        assert_eq!(
            provider_ids,
            vec![
                "codex-ok",
                "dsh-ok",
                "grok-ok",
                "hermes-ok",
                "mcode-ok",
                "openclaw-ok",
                "opencode-ok",
                "pi-ok",
            ]
        );
        assert!(!models.iter().any(|model| matches!(
            model.provider_id.as_str(),
            "codex-no"
                | "grok-no"
                | "dsh-no"
                | "opencode-no"
                | "openclaw-no"
                | "hermes-no"
                | "pi-no"
                | "mcode-no"
                | "claude-no"
                | "desktop-no"
                | "gemini-no"
        )));
    }

    #[test]
    fn route_resolves_exact_then_longest_provider_suffix() {
        let models = vec![
            CustomAppModel {
                id: "gpt-6-p".to_string(),
                upstream_model: "gpt-6".to_string(),
                provider_id: "p".to_string(),
                provider_name: "P".to_string(),
                app_type: "codex".to_string(),
            },
            CustomAppModel {
                id: "gpt-7-provider-long".to_string(),
                upstream_model: "gpt-7".to_string(),
                provider_id: "provider-long".to_string(),
                provider_name: "Long".to_string(),
                app_type: "claude".to_string(),
            },
        ];
        let exact = resolve_model_route(&models, "gpt-6-p").unwrap();
        assert_eq!(exact.upstream_model, "gpt-6");
        assert_eq!(exact.model.provider_id, "p");

        let suffix = resolve_model_route(&models, "new-model-provider-long").unwrap();
        assert_eq!(suffix.upstream_model, "new-model");
        assert_eq!(suffix.model.provider_id, "provider-long");
        assert_eq!(suffix.model.app_type, "claude");

        assert!(resolve_model_route(&models, "missing").is_none());
    }

    #[test]
    fn route_rejects_ambiguous_suffix_but_keeps_exact_and_longest_overlap() {
        let models = vec![
            CustomAppModel {
                id: "exact-p".to_string(),
                upstream_model: "exact".to_string(),
                provider_id: "p".to_string(),
                provider_name: "Codex P".to_string(),
                app_type: "codex".to_string(),
            },
            CustomAppModel {
                id: "other-p".to_string(),
                upstream_model: "other".to_string(),
                provider_id: "p".to_string(),
                provider_name: "Claude P".to_string(),
                app_type: "claude".to_string(),
            },
            CustomAppModel {
                id: "gpt-long-p".to_string(),
                upstream_model: "gpt".to_string(),
                provider_id: "long-p".to_string(),
                provider_name: "Long P".to_string(),
                app_type: "openclaw".to_string(),
            },
        ];

        let exact = resolve_model_route(&models, "exact-p").unwrap();
        assert_eq!(exact.upstream_model, "exact");
        assert_eq!(exact.model.app_type, "codex");

        assert!(
            resolve_model_route(&models, "new-model-p").is_none(),
            "same provider id in multiple app types must not guess a route"
        );

        let overlap = resolve_model_route(&models, "new-model-long-p").unwrap();
        assert_eq!(overlap.upstream_model, "new-model");
        assert_eq!(overlap.model.provider_id, "long-p");
        assert_eq!(overlap.model.app_type, "openclaw");
    }

    #[test]
    fn crud_and_api_key_lookup_work() {
        let db = Database::memory().unwrap();
        let app = db
            .create_custom_app(" My App ", "", Some("  ".to_string()))
            .unwrap();
        assert!(app.id.starts_with("custom-"));
        assert_eq!(app.name, "My App");
        assert_eq!(app.icon, "openai");
        assert_eq!(app.icon_color, None);
        assert!(app.api_key.starts_with("ccs_"));
        assert_eq!(app.api_key.len(), 4 + 48);
        assert_eq!(
            db.get_custom_app_by_api_key(&app.api_key)
                .unwrap()
                .unwrap()
                .id,
            app.id
        );

        let updated = db
            .update_custom_app(&app.id, "Renamed", "claude", Some(" #fff ".to_string()))
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.icon, "claude");
        assert_eq!(updated.icon_color.as_deref(), Some("#fff"));

        let old_key = updated.api_key.clone();
        let regenerated = db.regenerate_custom_app_key(&app.id).unwrap();
        assert_ne!(regenerated.api_key, old_key);
        assert!(db.get_custom_app_by_api_key(&old_key).unwrap().is_none());

        assert_eq!(db.list_custom_apps().unwrap().len(), 1);
        assert!(db.delete_custom_app(&app.id).unwrap());
        assert!(db.list_custom_apps().unwrap().is_empty());
    }
}
