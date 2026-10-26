//! 自定义应用服务层。
//!
//! 自定义应用只保存名称、图标和本地 API Key；每个应用在 providers 表中
//! 使用 `custom:<app_id>` 作为 app_type 维护自己的供应商。自定义供应商
//! 不写任何 live 配置，也不参与固定应用的 current provider / failover。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::Provider;
use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const CUSTOM_APP_TYPE_PREFIX: &str = "custom:";

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

/// 聚合模型。id 是对外模型 id（`<upstreamModel>-<providerId>`）。
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CustomProviderModel {
    id: String,
    name: String,
    /// Preserve DSH model fields such as contextWindow / reasoningEfforts.
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
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

pub(crate) fn custom_app_type_for_id(id: &str) -> String {
    format!("{CUSTOM_APP_TYPE_PREFIX}{id}")
}

fn ensure_custom_app(db: &Database, id: &str) -> Result<CustomApp, AppError> {
    db.get_custom_app_by_id(id)?
        .ok_or_else(|| AppError::InvalidInput("自定义应用不存在".to_string()))
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

fn normalize_custom_provider_id(id: &str) -> Result<String, AppError> {
    let id = id.trim();
    let valid = !id.is_empty()
        && id
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(AppError::InvalidInput(
            "供应商 ID 只能包含小写字母、数字和连字符，且必须以小写字母或数字开头".to_string(),
        ));
    }
    Ok(id.to_string())
}

fn normalize_custom_provider_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("供应商名称不能为空".to_string()));
    }
    Ok(name.to_string())
}

fn normalize_custom_base_url(base_url: &str) -> Result<String, AppError> {
    let base_url = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base_url)
        .map_err(|_| AppError::InvalidInput("Base URL 必须是有效的 http/https 地址".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::InvalidInput(
            "Base URL 必须是有效的 http/https 地址".to_string(),
        ));
    }
    Ok(base_url.to_string())
}

fn normalize_custom_api_key(api_key: &str) -> Result<String, AppError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::InvalidInput("API Key 不能为空".to_string()));
    }
    Ok(api_key.to_string())
}

fn custom_model_from_value(value: &Value) -> Result<CustomProviderModel, AppError> {
    if let Some(id) = value.as_str() {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::InvalidInput("模型 ID 不能为空".to_string()));
        }
        return Ok(CustomProviderModel {
            id: id.to_string(),
            name: id.to_string(),
            extra: serde_json::Map::new(),
        });
    }

    let object = value
        .as_object()
        .ok_or_else(|| AppError::InvalidInput("模型必须是 ID 字符串或对象".to_string()))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AppError::InvalidInput("模型 ID 不能为空".to_string()))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);

    let mut extra = object.clone();
    extra.remove("id");
    extra.remove("name");
    extra.remove("rowKey");
    Ok(CustomProviderModel {
        id: id.to_string(),
        name: name.to_string(),
        extra,
    })
}

fn normalize_custom_models(value: Option<&Value>) -> Result<Vec<CustomProviderModel>, AppError> {
    let Some(value) = value else {
        return Err(AppError::InvalidInput("至少需要一个模型".to_string()));
    };

    let raw_models: Vec<Value> = match value {
        Value::Array(items) => items.clone(),
        // 兼容旧数据里的对象形态；保存时统一转换为 [{ id, name }]。
        Value::Object(object) => object
            .iter()
            .map(|(id, config)| {
                let mut model = config.as_object().cloned().unwrap_or_default();
                model.insert("id".to_string(), Value::String(id.clone()));
                if model.get("name").and_then(Value::as_str).is_none() {
                    model.insert("name".to_string(), Value::String(id.clone()));
                }
                Value::Object(model)
            })
            .collect(),
        _ => {
            return Err(AppError::InvalidInput("models 必须是非空数组".to_string()));
        }
    };

    let mut models = Vec::new();
    for value in raw_models {
        let model = custom_model_from_value(&value)?;
        if models
            .iter()
            .any(|existing: &CustomProviderModel| existing.id == model.id)
        {
            continue;
        }
        models.push(model);
    }

    if models.is_empty() {
        return Err(AppError::InvalidInput("至少需要一个模型".to_string()));
    }
    Ok(models)
}

fn canonical_custom_provider_settings(settings: &Value) -> Result<Value, AppError> {
    let object = settings
        .as_object()
        .ok_or_else(|| AppError::InvalidInput("供应商 settingsConfig 必须是对象".to_string()))?;
    let base_url = object
        .get("baseURL")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("Base URL 不能为空".to_string()))?;
    let api_key = object
        .get("apiKey")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("API Key 不能为空".to_string()))?;
    let models = normalize_custom_models(object.get("models"))?;

    let mut canonical = object.clone();
    canonical.insert(
        "baseURL".to_string(),
        Value::String(normalize_custom_base_url(base_url)?),
    );
    canonical.insert(
        "apiKey".to_string(),
        Value::String(normalize_custom_api_key(api_key)?),
    );
    canonical.insert(
        "models".to_string(),
        serde_json::to_value(models)
            .map_err(|error| AppError::InvalidInput(format!("模型配置序列化失败: {error}")))?,
    );
    Ok(Value::Object(canonical))
}

/// 自定义供应商的 credentials 直接取自其固定 settings 结构。
pub(crate) fn custom_provider_credentials(settings: &Value) -> Result<(String, String), AppError> {
    let base_url = settings
        .get("baseURL")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("Base URL 不能为空".to_string()))?;
    let api_key = settings
        .get("apiKey")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("API Key 不能为空".to_string()))?;
    Ok((
        normalize_custom_base_url(base_url)?,
        normalize_custom_api_key(api_key)?,
    ))
}

fn add_model_id(models: &mut Vec<String>, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        let value = value.trim();
        if !value.is_empty() && !models.iter().any(|model| model == value) {
            models.push(value.to_string());
        }
    }
}

fn add_model_object(models: &mut Vec<String>, value: &Value) {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        if !value.is_empty() && !models.iter().any(|model| model == value) {
            models.push(value.to_string());
        }
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["id", "model", "slug"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                if !models.iter().any(|model| model == value) {
                    models.push(value.to_string());
                }
                return;
            }
        }
    }
}

/// 读取自定义供应商的模型 id。正常保存的数据是 `models: [{ id, name }]`，
/// 同时兼容字符串数组、对象 map 以及旧数据常用的 model/defaultModel/modelId。
fn extract_custom_provider_model_ids(settings: &Value) -> Vec<String> {
    let mut models = Vec::new();
    match settings.get("models") {
        Some(Value::Array(items)) => {
            for item in items {
                add_model_object(&mut models, item);
            }
        }
        Some(Value::Object(object)) => {
            for id in object.keys() {
                let id = id.trim();
                if !id.is_empty() && !models.iter().any(|model| model == id) {
                    models.push(id.to_string());
                }
            }
        }
        _ => {}
    }
    for key in ["model", "defaultModel", "modelId"] {
        add_model_id(&mut models, settings.get(key));
    }
    models
}

fn aggregate_custom_provider_models(
    app_id: &str,
    providers: &IndexMap<String, Provider>,
) -> Vec<CustomAppModel> {
    let app_type = custom_app_type_for_id(app_id);
    // None 表示该外部 id 在多个 provider 之间冲突；宁可不暴露，也不猜路由。
    let mut by_external_id: BTreeMap<String, Option<CustomAppModel>> = BTreeMap::new();

    for provider in providers.values() {
        if normalize_custom_provider_id(&provider.id).is_err() {
            log::warn!(
                "[custom-apps] 跳过 app '{}' 中 slug 非法的 provider '{}'",
                app_id,
                provider.id
            );
            continue;
        }
        if custom_provider_credentials(&provider.settings_config).is_err() {
            log::warn!(
                "[custom-apps] 跳过 app '{}' 中凭据不完整的 provider '{}'",
                app_id,
                provider.id
            );
            continue;
        }

        for upstream_model in extract_custom_provider_model_ids(&provider.settings_config) {
            let id = format!("{upstream_model}-{}", provider.id);
            let candidate = CustomAppModel {
                id: id.clone(),
                upstream_model,
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                app_type: app_type.clone(),
            };

            if let Some(existing) = by_external_id.get(&id) {
                let same_route = existing.as_ref().is_some_and(|existing| {
                    existing.provider_id == candidate.provider_id
                        && existing.upstream_model == candidate.upstream_model
                });
                if !same_route {
                    log::warn!(
                        "[custom-apps] app '{}' 的外部模型 id '{}' 存在路由歧义，已忽略",
                        app_id,
                        id
                    );
                    by_external_id.insert(id, None);
                }
                continue;
            }
            by_external_id.insert(id, Some(candidate));
        }
    }

    by_external_id.into_values().flatten().collect()
}

/// 只按对外模型 id 精确匹配该自定义应用自己的 provider 路由。
pub(crate) fn resolve_model_route(
    models: &[CustomAppModel],
    requested_id: &str,
) -> Option<CustomModelRoute> {
    models
        .iter()
        .find(|model| model.id == requested_id)
        .map(|model| CustomModelRoute {
            upstream_model: model.upstream_model.clone(),
            model: model.clone(),
        })
}

pub(crate) fn list_custom_app_providers(
    db: &Database,
    id: &str,
) -> Result<IndexMap<String, Provider>, AppError> {
    ensure_custom_app(db, id)?;
    db.get_custom_app_providers(&custom_app_type_for_id(id))
}

pub(crate) fn save_custom_app_provider(
    db: &Database,
    id: &str,
    provider: &Provider,
) -> Result<bool, AppError> {
    ensure_custom_app(db, id)?;
    let provider = Provider::with_id(
        normalize_custom_provider_id(&provider.id)?,
        normalize_custom_provider_name(&provider.name)?,
        canonical_custom_provider_settings(&provider.settings_config)?,
        None,
    );
    db.save_custom_app_provider(&custom_app_type_for_id(id), &provider)?;
    Ok(true)
}

pub(crate) fn delete_custom_app_provider(
    db: &Database,
    id: &str,
    provider_id: &str,
) -> Result<bool, AppError> {
    ensure_custom_app(db, id)?;
    let provider_id = normalize_custom_provider_id(provider_id)?;
    db.delete_custom_app_provider(&custom_app_type_for_id(id), &provider_id)
}

pub(crate) fn list_custom_app_models(
    db: &Database,
    id: &str,
) -> Result<Vec<CustomAppModel>, AppError> {
    let providers = list_custom_app_providers(db, id)?;
    Ok(aggregate_custom_provider_models(id, &providers))
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
        let app_type = custom_app_type_for_id(id);
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM providers WHERE app_type = ?1",
            params![app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        let affected = tx
            .execute("DELETE FROM custom_apps WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
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

    fn provider(id: &str, name: &str, settings: Value) -> Provider {
        Provider::with_id(id.to_string(), name.to_string(), settings, None)
    }

    fn custom_settings(base_url: &str, api_key: &str, models: Value) -> Value {
        json!({
            "baseURL": base_url,
            "apiKey": api_key,
            "models": models,
        })
    }

    #[test]
    fn save_custom_provider_is_canonical_and_never_touches_fixed_apps() {
        let db = Database::memory().unwrap();
        let app = db.create_custom_app("My App", "openai", None).unwrap();
        let incoming = provider(
            "my-provider",
            "  My Provider  ",
            json!({
                "baseURL": " https://api.example.com/v1/ ",
                "apiKey": " sk-secret ",
                "api": "openai-completions",
                "apiKeyEnv": "CUSTOM_KEY",
                "maxTokens": "8192",
                "defaultModel": "gpt-7",
                "models": [
                    "gpt-6",
                    {"id": "gpt-7", "name": " GPT-7 ", "contextWindow": 128000, "reasoningEfforts": {"low": "low"}},
                    {"id": "o3", "name": ""},
                ],
            }),
        );

        assert!(save_custom_app_provider(&db, &app.id, &incoming).unwrap());
        let providers = list_custom_app_providers(&db, &app.id).unwrap();
        let stored = providers.get("my-provider").unwrap();
        assert_eq!(stored.name, "My Provider");
        assert_eq!(
            stored.settings_config,
            json!({
                "baseURL": "https://api.example.com/v1",
                "apiKey": "sk-secret",
                "api": "openai-completions",
                "apiKeyEnv": "CUSTOM_KEY",
                "maxTokens": "8192",
                "defaultModel": "gpt-7",
                "models": [
                    {"id": "gpt-6", "name": "gpt-6"},
                    {"id": "gpt-7", "name": "GPT-7", "contextWindow": 128000, "reasoningEfforts": {"low": "low"}},
                    {"id": "o3", "name": "o3"},
                ],
            })
        );
        assert!(db.get_all_providers("opencode").unwrap().is_empty());
        assert!(db.get_all_providers_cross_app().unwrap().is_empty());
        assert!(db.get_current_provider("opencode").unwrap().is_none());
        let conn = db.conn.lock().expect("db lock");
        let flags: (bool, bool) = conn
            .query_row(
                "SELECT is_current, in_failover_queue FROM providers
                 WHERE id = 'my-provider' AND app_type = ?1",
                params![custom_app_type_for_id(&app.id)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(flags, (false, false));
    }

    #[test]
    fn custom_provider_validation_rejects_invalid_fields() {
        let db = Database::memory().unwrap();
        let app = db.create_custom_app("App", "openai", None).unwrap();

        let cases = [
            provider(
                "Bad_ID",
                "Name",
                custom_settings("https://api.example.com", "key", json!(["model"])),
            ),
            provider(
                "valid-id",
                "",
                custom_settings("https://api.example.com", "key", json!(["model"])),
            ),
            provider(
                "valid-id",
                "Name",
                custom_settings("ftp://api.example.com", "key", json!(["model"])),
            ),
            provider(
                "valid-id",
                "Name",
                custom_settings("https://api.example.com", "", json!(["model"])),
            ),
            provider(
                "valid-id",
                "Name",
                custom_settings("https://api.example.com", "key", json!([])),
            ),
            provider(
                "valid-id",
                "Name",
                custom_settings("https://api.example.com", "key", json!([{"id": " "}])),
            ),
        ];

        for invalid in cases {
            assert!(
                save_custom_app_provider(&db, &app.id, &invalid).is_err(),
                "provider should be rejected: {invalid:?}"
            );
        }
        assert!(list_custom_app_providers(&db, &app.id).unwrap().is_empty());
        assert!(save_custom_app_provider(
            &db,
            "missing-app",
            &provider(
                "valid-id",
                "Name",
                custom_settings("https://api.example.com", "key", json!(["model"]))
            )
        )
        .is_err());
    }

    #[test]
    fn custom_app_models_are_isolated_from_other_and_fixed_apps() {
        let db = Database::memory().unwrap();
        let first = db.create_custom_app("First", "openai", None).unwrap();
        let second = db.create_custom_app("Second", "openai", None).unwrap();
        save_custom_app_provider(
            &db,
            &first.id,
            &provider(
                "shared-id",
                "First Provider",
                custom_settings(
                    "https://first.example.com/v1",
                    "first-key",
                    json!([{"id": "first-model", "name": "First"}]),
                ),
            ),
        )
        .unwrap();
        save_custom_app_provider(
            &db,
            &second.id,
            &provider(
                "shared-id",
                "Second Provider",
                custom_settings(
                    "https://second.example.com/v1",
                    "second-key",
                    json!([{"id": "second-model", "name": "Second"}]),
                ),
            ),
        )
        .unwrap();

        let fixed = provider(
            "fixed-provider",
            "Fixed Provider",
            json!({
                "npm": "@ai-sdk/openai-compatible",
                "models": {"fixed-model": {}},
            }),
        );
        db.save_provider("opencode", &fixed).unwrap();

        let first_models = list_custom_app_models(&db, &first.id).unwrap();
        assert_eq!(first_models.len(), 1);
        assert_eq!(first_models[0].id, "first-model-shared-id");
        assert_eq!(first_models[0].provider_name, "First Provider");
        assert_eq!(first_models[0].app_type, custom_app_type_for_id(&first.id));

        let second_models = list_custom_app_models(&db, &second.id).unwrap();
        assert_eq!(second_models.len(), 1);
        assert_eq!(second_models[0].id, "second-model-shared-id");
        assert!(!second_models.iter().any(|model| model.id.contains("fixed")));
    }

    #[test]
    fn model_extraction_supports_models_shapes_and_compat_fields() {
        let settings = json!({
            "baseURL": "https://api.example.com",
            "apiKey": "key",
            "models": [
                "string-model",
                {"id": "object-id"},
                {"model": "object-model"},
                {"slug": "object-slug"},
                {"name": "not-a-model-id"},
            ],
            "model": "top-model",
            "defaultModel": "default-model",
            "modelId": "model-id",
        });
        assert_eq!(
            extract_custom_provider_model_ids(&settings),
            vec![
                "string-model",
                "object-id",
                "object-model",
                "object-slug",
                "top-model",
                "default-model",
                "model-id",
            ]
        );

        let object_models = json!({
            "models": {
                "key-a": {"name": "Key A"},
                "key-b": {}
            }
        });
        assert_eq!(
            extract_custom_provider_model_ids(&object_models),
            vec!["key-a", "key-b"]
        );
    }

    #[test]
    fn ambiguous_external_model_ids_are_not_exposed() {
        let providers = [
            (
                "b-c".to_string(),
                provider(
                    "b-c",
                    "First",
                    custom_settings("https://first.example.com/v1", "first-key", json!(["a"])),
                ),
            ),
            (
                "c".to_string(),
                provider(
                    "c",
                    "Second",
                    custom_settings(
                        "https://second.example.com/v1",
                        "second-key",
                        json!(["a-b"]),
                    ),
                ),
            ),
        ]
        .into_iter()
        .collect::<IndexMap<_, _>>();

        // "a" + "b-c" 与 "a-b" + "c" 会生成同一个外部 id，不能任意猜一家。
        assert!(aggregate_custom_provider_models("app", &providers).is_empty());
    }

    #[test]
    fn route_resolution_is_exact_only() {
        let models = vec![
            CustomAppModel {
                id: "gpt-6-p".to_string(),
                upstream_model: "gpt-6".to_string(),
                provider_id: "p".to_string(),
                provider_name: "P".to_string(),
                app_type: "custom:app".to_string(),
            },
            CustomAppModel {
                id: "gpt-7-provider-long".to_string(),
                upstream_model: "gpt-7".to_string(),
                provider_id: "provider-long".to_string(),
                provider_name: "Long".to_string(),
                app_type: "custom:app".to_string(),
            },
        ];
        let exact = resolve_model_route(&models, "gpt-6-p").unwrap();
        assert_eq!(exact.upstream_model, "gpt-6");
        assert_eq!(exact.model.provider_id, "p");
        assert!(resolve_model_route(&models, "new-model-p").is_none());
        assert!(resolve_model_route(&models, "missing").is_none());
    }

    #[test]
    fn delete_custom_provider_and_app_cleanup_are_scoped() {
        let db = Database::memory().unwrap();
        let first = db.create_custom_app("First", "openai", None).unwrap();
        let second = db.create_custom_app("Second", "openai", None).unwrap();
        for app in [&first, &second] {
            save_custom_app_provider(
                &db,
                &app.id,
                &provider(
                    "provider-id",
                    "Provider",
                    custom_settings(
                        "https://api.example.com/v1",
                        "key",
                        json!([{"id": "model", "name": "Model"}]),
                    ),
                ),
            )
            .unwrap();
        }

        assert!(delete_custom_app_provider(&db, &first.id, "provider-id").unwrap());
        assert!(!delete_custom_app_provider(&db, &first.id, "provider-id").unwrap());
        assert!(list_custom_app_models(&db, &first.id).unwrap().is_empty());
        assert_eq!(list_custom_app_models(&db, &second.id).unwrap().len(), 1);

        save_custom_app_provider(
            &db,
            &first.id,
            &provider(
                "provider-id",
                "Provider",
                custom_settings(
                    "https://api.example.com/v1",
                    "key",
                    json!([{"id": "model", "name": "Model"}]),
                ),
            ),
        )
        .unwrap();
        assert!(db.delete_custom_app(&first.id).unwrap());
        assert!(list_custom_app_providers(&db, &first.id).is_err());
        assert_eq!(
            db.get_custom_app_providers(&custom_app_type_for_id(&first.id))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            db.get_custom_app_providers(&custom_app_type_for_id(&second.id))
                .unwrap()
                .len(),
            1
        );
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
