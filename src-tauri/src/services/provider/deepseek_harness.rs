use super::{ProviderService, SwitchResult};
use crate::error::AppError;
use crate::provider::{Provider, ProviderMeta};
use crate::store::AppState;
use indexmap::IndexMap;
use serde_json::Value;

const APP: &str = "deepseek-harness";

pub(super) fn list(state: &AppState) -> Result<IndexMap<String, Provider>, AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    if let Ok(native) = crate::deepseek_harness_config::read_native_state() {
        if let Err(error) = sync_native_locked(state, &native) {
            log::warn!("Failed to sync DeepSeek Harness providers: {error}");
        }
    }
    state.db.get_all_providers(APP)
}

pub(super) fn import_from_live(state: &AppState) -> Result<usize, AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let native = crate::deepseek_harness_config::read_native_state()?;
    sync_native_locked(state, &native)
}

pub(super) fn add(
    state: &AppState,
    provider: Provider,
    add_to_live: bool,
) -> Result<bool, AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    if state.db.get_provider_by_id(&provider.id, APP)?.is_some() {
        return Err(AppError::InvalidInput(format!(
            "DeepSeek Harness provider '{}' already exists",
            provider.id
        )));
    }
    ProviderService::validate_provider_settings(
        &crate::app_config::AppType::DeepSeekHarness,
        &provider,
    )?;
    // The official route is a singleton keyed by id; a copy carrying its
    // provider_type would be routed to the same id-blind llm-deepseek
    // adapter, so a delete of the copy would wipe the real official route.
    if provider.id != crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID
        && provider
            .meta
            .as_ref()
            .and_then(|meta| meta.provider_type.as_deref())
            == Some("dsh_deepseek")
    {
        return Err(AppError::InvalidInput(
            "Only the native official route may use the dsh_deepseek provider type".to_string(),
        ));
    }
    // Validate the model catalog before any write so a model-less provider
    // cannot be half-committed to the native file and the database.
    let first_model = first_model_id(&provider.settings_config)?;
    if add_to_live {
        write_native_provider(&provider)?;
    }
    state.db.save_provider(APP, &provider)?;
    if state.db.get_current_provider(APP)?.is_none() && add_to_live {
        crate::deepseek_harness_config::set_current_model(&provider.id, &first_model)?;
        state.db.set_current_provider(APP, &provider.id)?;
        crate::settings::set_current_provider(
            &crate::app_config::AppType::DeepSeekHarness,
            Some(&provider.id),
        )?;
    }
    Ok(true)
}

pub(super) fn update(
    state: &AppState,
    original_id: Option<&str>,
    provider: Provider,
) -> Result<bool, AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let original_id = original_id.unwrap_or(&provider.id);
    if original_id != provider.id {
        return Err(AppError::InvalidInput(
            "DeepSeek Harness provider ids cannot be renamed".to_string(),
        ));
    }
    state
        .db
        .get_provider_by_id(original_id, APP)?
        .ok_or_else(|| AppError::InvalidInput(format!("Provider '{original_id}' not found")))?;
    ProviderService::validate_provider_settings(
        &crate::app_config::AppType::DeepSeekHarness,
        &provider,
    )?;
    let native = crate::deepseek_harness_config::read_native_state()?;
    // DB-only providers (e.g. duplicates created with addToLive = false) must
    // stay out of settings.yaml: an edit only updates the database row until
    // the user explicitly adds the route to the live configuration.
    let in_native = native.providers.contains_key(provider.id.as_str());
    // The edit form's default-model field only takes effect on the route that
    // is currently selected in DSH; applying it unconditionally would let an
    // edit of a background provider silently steal the native selection.
    let desired_model =
        if in_native && native.current_provider.as_deref() == Some(provider.id.as_str()) {
            provider
                .meta
                .as_ref()
                .and_then(|meta| meta.dsh_current_model.as_deref())
                .filter(|model| !model.trim().is_empty())
        } else {
            None
        };
    // Validate before any write so an unknown model cannot half-commit the
    // native file and the database row that the writes below already made.
    if let Some(model) = desired_model {
        if !provider_has_model(&provider.settings_config, model) {
            return Err(AppError::InvalidInput(format!(
                "Model '{model}' is not configured for DSH provider '{}'",
                provider.id
            )));
        }
    }
    if in_native {
        write_native_provider(&provider)?;
    }
    state.db.save_provider(APP, &provider)?;
    if let Some(model) = desired_model {
        if native.current_model.as_deref() != Some(model) {
            crate::deepseek_harness_config::set_current_model(&provider.id, model)?;
            let native = crate::deepseek_harness_config::read_native_state()?;
            sync_native_locked(state, &native)?;
        }
    }
    Ok(true)
}

pub(super) fn delete(state: &AppState, id: &str) -> Result<(), AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let Some(provider) = state.db.get_provider_by_id(id, APP)? else {
        return Ok(());
    };
    remove_native_provider(&provider)?;
    crate::deepseek_harness_config::clear_current_model_if_provider(id)?;
    state.db.delete_provider(APP, id)
}

pub(super) fn enable(state: &AppState, id: &str) -> Result<SwitchResult, AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let provider = state
        .db
        .get_provider_by_id(id, APP)?
        .ok_or_else(|| AppError::InvalidInput(format!("Provider '{id}' not found")))?;
    write_native_provider(&provider)?;
    let native = crate::deepseek_harness_config::read_native_state()?;
    let model = if native.current_provider.as_deref() == Some(id) {
        native
            .current_model
            .filter(|model| provider_has_model(&provider.settings_config, model))
            .unwrap_or(first_model_id(&provider.settings_config)?)
    } else {
        first_model_id(&provider.settings_config)?
    };
    crate::deepseek_harness_config::set_current_model(id, &model)?;
    let native = crate::deepseek_harness_config::read_native_state()?;
    sync_native_locked(state, &native)?;
    Ok(SwitchResult::default())
}

pub(super) fn set_current_model(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
) -> Result<(), AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let native = crate::deepseek_harness_config::read_native_state()?;
    let provider = native
        .providers
        .get(provider_id)
        .ok_or_else(|| AppError::InvalidInput(format!("Provider '{provider_id}' not found")))?;
    if let Some(models) = provider.config.get("models").and_then(Value::as_array) {
        let known = models
            .iter()
            .any(|model| model_id_of(model) == Some(model_id));
        if !known {
            return Err(AppError::InvalidInput(format!(
                "Model '{model_id}' is not configured for DSH provider '{provider_id}'"
            )));
        }
    }
    crate::deepseek_harness_config::set_current_model(provider_id, model_id)?;
    let native = crate::deepseek_harness_config::read_native_state()?;
    sync_native_locked(state, &native)?;
    Ok(())
}

fn sync_native_locked(
    state: &AppState,
    native: &crate::deepseek_harness_config::NativeState,
) -> Result<usize, AppError> {
    let saved = state.db.get_all_providers(APP)?;
    let mut changed = 0;
    for (id, route) in &native.providers {
        let provider_name = match route.source {
            crate::deepseek_harness_config::NativeProviderSource::DeepSeek => route.name.clone(),
            crate::deepseek_harness_config::NativeProviderSource::PiAi => route
                .config
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(route.name.as_str())
                .to_string(),
        };
        let mut provider = saved.get(id).cloned().unwrap_or_else(|| {
            let mut provider = Provider::with_id(
                id.clone(),
                provider_name.clone(),
                route.config.clone(),
                None,
            );
            provider.category = Some(
                if route.source == crate::deepseek_harness_config::NativeProviderSource::DeepSeek {
                    "official"
                } else {
                    "custom"
                }
                .to_string(),
            );
            provider.icon = Some("deepseek".to_string());
            provider
        });
        let previous_name = provider.name.clone();
        let previous_config = provider.settings_config.clone();
        let previous_source = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.provider_type.clone());
        let previous_current_model = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.dsh_current_model.clone());
        provider.name = provider_name;
        provider.settings_config = route.config.clone();
        // 接管期间 DSH 里存的是本机中转地址，不能让它回流进数据库：否则取消接管后数据库
        // 里留着一个死端口，用户下次编辑又会把它写回 DSH。
        let native_base_url = route.config.get("baseURL").and_then(Value::as_str);
        if native_base_url.is_some_and(crate::services::dsh_relay::is_relay_url) {
            let original = previous_config
                .get("baseURL")
                .and_then(Value::as_str)
                .filter(|value| !crate::services::dsh_relay::is_relay_url(value))
                .map(ToOwned::to_owned)
                .or_else(|| crate::services::dsh_relay::recorded_original(id));
            if let (Some(original), Value::Object(map)) = (original, &mut provider.settings_config)
            {
                map.insert("baseURL".to_string(), Value::String(original));
            }
        }
        let meta = provider.meta.get_or_insert_with(ProviderMeta::default);
        meta.provider_type = Some(
            match route.source {
                crate::deepseek_harness_config::NativeProviderSource::DeepSeek => "dsh_deepseek",
                crate::deepseek_harness_config::NativeProviderSource::PiAi => "dsh_pi_ai",
            }
            .to_string(),
        );
        meta.dsh_current_model = if native.current_provider.as_deref() == Some(id) {
            native.current_model.clone()
        } else {
            None
        };
        if !saved.contains_key(id)
            || previous_name != provider.name
            || previous_config != provider.settings_config
            || previous_source != meta.provider_type
            || previous_current_model != meta.dsh_current_model
        {
            state.db.save_provider(APP, &provider)?;
            changed += 1;
        }
    }
    if let Some(current) = native
        .current_provider
        .as_deref()
        .filter(|id| native.providers.contains_key(*id))
    {
        state.db.set_current_provider(APP, current)?;
        crate::settings::set_current_provider(
            &crate::app_config::AppType::DeepSeekHarness,
            Some(current),
        )?;
    }
    Ok(changed)
}

pub(super) fn remove_from_live(state: &AppState, id: &str) -> Result<(), AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app(APP));
    let provider = state
        .db
        .get_provider_by_id(id, APP)?
        .ok_or_else(|| AppError::InvalidInput(format!("Provider '{id}' not found")))?;
    remove_native_provider(&provider)?;
    crate::deepseek_harness_config::clear_current_model_if_provider(id)?;
    Ok(())
}

fn write_native_provider(provider: &Provider) -> Result<(), AppError> {
    // 接管期间用户改供应商地址：真正写进 DSH 的必须是本机中转地址，用户填的那个由
    // `dsh_relay` 记进账本、退出或关掉开关时再换回去。
    let mut settings = provider.settings_config.clone();
    let desired_base_url = settings
        .get("baseURL")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(relay_base_url) = crate::services::dsh_relay::redirect_base_url(
        &provider.id,
        &provider.name,
        desired_base_url,
    ) {
        if let Value::Object(map) = &mut settings {
            map.insert("baseURL".to_string(), Value::String(relay_base_url));
        }
    }
    if provider.id == crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID
        || provider
            .meta
            .as_ref()
            .and_then(|meta| meta.provider_type.as_deref())
            == Some("dsh_deepseek")
    {
        let config = serde_json::from_value::<
            crate::deepseek_harness_config::DeepSeekHarnessProviderConfig,
        >(settings)
        .map_err(|error| AppError::Config(format!("Invalid DSH provider: {error}")))?;
        crate::deepseek_harness_config::set_provider(&provider.id, &config)
    } else {
        crate::deepseek_harness_config::set_pi_ai_provider(&provider.id, &settings)
    }
}

pub(super) fn remove_native_provider(provider: &Provider) -> Result<(), AppError> {
    if provider.id == crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID
        || provider
            .meta
            .as_ref()
            .and_then(|meta| meta.provider_type.as_deref())
            == Some("dsh_deepseek")
    {
        crate::deepseek_harness_config::remove_provider()
    } else {
        crate::deepseek_harness_config::remove_pi_ai_provider(&provider.id)
    }
}

/// A DSH model entry is either a bare id string or an `{id}` object; blank ids
/// never count as a usable model.
fn model_id_of(model: &Value) -> Option<&str> {
    match model {
        Value::String(id) => Some(id.as_str()),
        Value::Object(_) => model.get("id").and_then(Value::as_str),
        _ => None,
    }
    .filter(|id| !id.trim().is_empty())
}

fn first_model_id(config: &Value) -> Result<String, AppError> {
    config
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.iter().find_map(model_id_of))
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::InvalidInput("DeepSeek Harness provider has no model".to_string()))
}

fn provider_has_model(config: &Value, model_id: &str) -> bool {
    config
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models
                .iter()
                .any(|model| model_id_of(model) == Some(model_id))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serde_json::json;
    use serial_test::serial;
    use std::sync::Arc;

    struct DshHome {
        _dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl DshHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let previous = std::env::var_os("DSH_HOME");
            std::env::set_var("DSH_HOME", dir.path());
            std::env::set_var("DSH_PROFILE", "desktop");
            // The live surface is the loader patch layer: a top-level array of
            // `- id / name / config` entries applied after every bundle layer.
            let profile = dir.path().join("profiles/desktop");
            std::fs::create_dir_all(&profile).unwrap();
            std::fs::write(
                profile.join("cordis.patch.yml"),
                "\
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    baseURL: https://api.deepseek.com
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-v4-pro
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      company:
        displayName: Company
        api: openai-completions
        baseURL: https://gateway.example/v1
        apiKeyEnv: COMPANY_API_KEY
        models:
          - id: glm-5.3
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: company
    model: glm-5.3
",
            )
            .unwrap();
            std::fs::write(
                dir.path().join(".credentials.yaml"),
                "version: 1\nrefs:\n  DEEPSEEK_API_KEY: deepseek-key\n  COMPANY_API_KEY: company-key\n",
            )
            .unwrap();
            Self {
                _dir: dir,
                previous,
            }
        }

        /// 当前活动的 loader patch 层文件（DSH 的 live 配置真身）。
        fn patch(&self) -> std::path::PathBuf {
            self._dir.path().join("profiles/desktop/cordis.patch.yml")
        }

        fn read(&self) -> String {
            std::fs::read_to_string(self.patch()).unwrap()
        }

        fn seed(&self, text: &str) {
            std::fs::write(self.patch(), text).unwrap();
        }
    }

    impl Drop for DshHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("DSH_HOME", value),
                None => std::env::remove_var("DSH_HOME"),
            }
        }
    }

    fn state() -> AppState {
        AppState::new(Arc::new(Database::memory().unwrap()))
    }

    #[test]
    #[serial]
    fn imports_native_routes_and_current_provider() {
        let _home = DshHome::new();
        let state = state();
        assert_eq!(import_from_live(&state).unwrap(), 2);

        let providers = state.db.get_all_providers(APP).unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers["company"].name, "Company");
        assert_eq!(
            providers["company"].settings_config["apiKey"],
            "company-key"
        );
        assert_eq!(
            state.db.get_current_provider(APP).unwrap().as_deref(),
            Some("company")
        );
        assert_eq!(
            providers["company"]
                .meta
                .as_ref()
                .and_then(|meta| meta.dsh_current_model.as_deref()),
            Some("glm-5.3")
        );
    }

    #[test]
    #[serial]
    fn sync_uses_custom_display_name_for_provider_name() {
        let state = state();
        let native = crate::deepseek_harness_config::NativeState {
            providers: indexmap::indexmap! {
                "custom".to_string() => crate::deepseek_harness_config::NativeProvider {
                    name: "stale route name".to_string(),
                    source: crate::deepseek_harness_config::NativeProviderSource::PiAi,
                    config: json!({
                        "displayName": "Editable route name",
                        "models": [{"id": "model-a"}]
                    }),
                },
            },
            ..Default::default()
        };

        assert_eq!(sync_native_locked(&state, &native).unwrap(), 1);
        let provider = state
            .db
            .get_provider_by_id("custom", APP)
            .unwrap()
            .expect("custom route imported");
        assert_eq!(provider.name, "Editable route name");
        assert_eq!(
            provider.settings_config["displayName"],
            "Editable route name"
        );
    }

    #[test]
    #[serial]
    fn switching_provider_updates_native_default_model() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        enable(&state, crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID).unwrap();
        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert_eq!(
            native.current_provider.as_deref(),
            Some(crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID)
        );
        assert_eq!(native.current_model.as_deref(), Some("deepseek-v4-pro"));
    }

    #[test]
    #[serial]
    fn adds_and_deletes_custom_native_provider() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut provider = Provider::with_id(
            "new-route".to_string(),
            "New Route".to_string(),
            json!({
                "displayName": "New Route",
                "api": "openai-completions",
                "baseURL": "https://new.example/v1",
                "apiKeyEnv": "NEW_ROUTE_API_KEY",
                "apiKey": "new-secret",
                "models": [{"id": "model-a"}]
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("dsh_pi_ai".to_string()),
            ..Default::default()
        });

        add(&state, provider, true).unwrap();
        assert!(crate::deepseek_harness_config::read_native_state()
            .unwrap()
            .providers
            .contains_key("new-route"));
        delete(&state, "new-route").unwrap();
        assert!(!crate::deepseek_harness_config::read_native_state()
            .unwrap()
            .providers
            .contains_key("new-route"));
    }

    #[test]
    #[serial]
    fn set_current_model_validates_membership_and_updates_state() {
        let home = DshHome::new();
        std::fs::write(
            home.patch(),
            "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      k3:\n        displayName: K3\n        baseURL: https://k3.example.com\n        models:\n          - id: k3\n          - id: k3-turbo\n",
        )
        .unwrap();
        let state = state();

        set_current_model(&state, "k3", "k3-turbo").unwrap();
        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert_eq!(native.current_provider.as_deref(), Some("k3"));
        assert_eq!(native.current_model.as_deref(), Some("k3-turbo"));
        assert_eq!(
            state.db.get_current_provider(APP).unwrap().as_deref(),
            Some("k3")
        );

        assert!(set_current_model(&state, "k3", "no-such-model").is_err());
        assert!(set_current_model(&state, "ghost", "k3").is_err());
    }

    #[test]
    #[serial]
    fn remove_from_live_only_clears_the_targeted_route() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut provider = Provider::with_id(
            "k3".to_string(),
            "K3".to_string(),
            json!({
                "displayName": "K3",
                "api": "openai-completions",
                "baseURL": "https://k3.example.com",
                "apiKeyEnv": "K3_API_KEY",
                "apiKey": "k3-secret",
                "models": [{"id": "k3-model"}]
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("dsh_pi_ai".to_string()),
            ..Default::default()
        });
        add(&state, provider, true).unwrap();

        remove_from_live(&state, "k3").unwrap();

        let settings = home.read();
        assert!(settings.contains("llm-deepseek"));
        assert!(settings.contains("company"));
        assert!(!settings.contains("k3"));
    }

    #[test]
    #[serial]
    fn remove_from_live_official_route_keeps_pi_ai_providers() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();

        remove_from_live(&state, crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID).unwrap();

        let settings = home.read();
        assert!(!settings.contains("llm-deepseek"));
        assert!(settings.contains("llm-pi-ai"));
        assert!(settings.contains("company"));
        // The removed route was not the current one: the default-model pointer
        // must survive untouched.
        assert!(settings.contains("agent-default-model"));
    }

    #[test]
    #[serial]
    fn remove_keeps_credentials_still_referenced_by_sibling_routes() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        // Make both pi-ai routes share one credential ref.
        home.seed(
            "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      route-a:\n        displayName: A\n        baseURL: https://a.example/v1\n        apiKeyEnv: COMPANY_API_KEY\n        models:\n          - id: m-a\n      route-b:\n        displayName: B\n        baseURL: https://b.example/v1\n        apiKeyEnv: COMPANY_API_KEY\n        models:\n          - id: m-b\n",
        );
        import_from_live(&state).unwrap();

        delete(&state, "route-a").unwrap();
        let credentials =
            std::fs::read_to_string(home._dir.path().join(".credentials.yaml")).unwrap();
        assert!(
            credentials.contains("COMPANY_API_KEY"),
            "shared ref must survive while route-b still uses it"
        );

        delete(&state, "route-b").unwrap();
        let credentials =
            std::fs::read_to_string(home._dir.path().join(".credentials.yaml")).unwrap();
        assert!(
            !credentials.contains("COMPANY_API_KEY"),
            "unreferenced credentials are cleaned up"
        );
    }

    #[test]
    #[serial]
    fn remove_official_route_keeps_shared_deepseek_credential() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        // The custom route shares DEEPSEEK_API_KEY with the official route.
        home.seed(
            "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    baseURL: https://api.deepseek.com\n    apiKeyEnv: DEEPSEEK_API_KEY\n    models:\n      - id: deepseek-v4-pro\n- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      company:\n        displayName: Company\n        baseURL: https://gateway.example/v1\n        apiKeyEnv: DEEPSEEK_API_KEY\n        models:\n          - id: glm-5.3\n",
        );
        import_from_live(&state).unwrap();

        remove_from_live(&state, crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID).unwrap();

        let credentials =
            std::fs::read_to_string(home._dir.path().join(".credentials.yaml")).unwrap();
        assert!(
            credentials.contains("DEEPSEEK_API_KEY"),
            "the official route must not clear a shared credential"
        );
    }

    #[test]
    #[serial]
    fn update_keeps_db_only_providers_out_of_native_config() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut copy = Provider::with_id(
            "company-copy".to_string(),
            "Company Copy".to_string(),
            json!({
                "displayName": "Company Copy",
                "api": "openai-completions",
                "baseURL": "https://copy.example/v1",
                "apiKeyEnv": "COMPANY_API_KEY",
                "apiKey": "secret",
                "models": [{"id": "m-1"}]
            }),
            None,
        );
        copy.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("dsh_pi_ai".to_string()),
            ..Default::default()
        });
        add(&state, copy, false).unwrap();
        let settings_before = home.read();

        let mut edited = state
            .db
            .get_provider_by_id("company-copy", APP)
            .unwrap()
            .unwrap();
        edited.name = "Renamed Copy".to_string();
        update(&state, None, edited).unwrap();

        let settings_after = home.read();
        assert_eq!(
            settings_before, settings_after,
            "editing a DB-only provider must not touch the native file"
        );
        assert!(!crate::deepseek_harness_config::read_native_state()
            .unwrap()
            .providers
            .contains_key("company-copy"));
    }

    #[test]
    #[serial]
    fn deleting_the_current_provider_clears_the_native_default_model() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();

        delete(&state, "company").unwrap();

        let settings = home.read();
        assert!(!settings.contains("agent-default-model"));
        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert!(native.current_provider.is_none());
        assert!(native.current_model.is_none());
    }

    #[test]
    #[serial]
    fn remove_from_live_of_the_current_provider_clears_the_default_model() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        enable(&state, "company").unwrap();

        remove_from_live(&state, "company").unwrap();

        let settings = home.read();
        assert!(!settings.contains("company"));
        assert!(!settings.contains("agent-default-model"));
    }

    #[test]
    #[serial]
    fn update_applies_the_default_model_for_the_current_provider() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut provider = state
            .db
            .get_provider_by_id("company", APP)
            .unwrap()
            .unwrap();
        provider.meta.as_mut().unwrap().dsh_current_model = Some("new-model".to_string());

        // The model is not in the catalog yet: the edit must be rejected.
        assert!(update(&state, None, provider.clone()).is_err());

        provider.settings_config["models"] = json!([{ "id": "glm-5.3" }, { "id": "new-model" }]);
        update(&state, None, provider).unwrap();

        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert_eq!(native.current_provider.as_deref(), Some("company"));
        assert_eq!(native.current_model.as_deref(), Some("new-model"));
    }

    #[test]
    #[serial]
    fn update_ignores_the_default_model_for_background_providers() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut official = state
            .db
            .get_provider_by_id(crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID, APP)
            .unwrap()
            .unwrap();
        official.meta.as_mut().unwrap().dsh_current_model = Some("deepseek-v4-pro".to_string());

        update(&state, None, official).unwrap();

        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert_eq!(native.current_provider.as_deref(), Some("company"));
        assert_eq!(native.current_model.as_deref(), Some("glm-5.3"));
    }

    #[test]
    #[serial]
    fn update_rejects_unknown_default_model_without_writing() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut provider = state
            .db
            .get_provider_by_id("company", APP)
            .unwrap()
            .unwrap();
        provider.meta.as_mut().unwrap().dsh_current_model = Some("no-such-model".to_string());

        assert!(update(&state, None, provider).is_err());

        // The rejected edit must not reach the database row: the native file
        // may rewrite byte-identically, but the meta must keep the old model.
        let saved = state
            .db
            .get_provider_by_id("company", APP)
            .unwrap()
            .unwrap();
        assert_ne!(
            saved.meta.as_ref().unwrap().dsh_current_model.as_deref(),
            Some("no-such-model")
        );
    }

    #[test]
    #[serial]
    fn add_rejects_dsh_deepseek_meta_on_a_copy() {
        let home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let before = home.read();

        let mut provider = Provider::with_id(
            "official-copy".to_string(),
            "DeepSeek copy".to_string(),
            json!({
                "displayName": "DeepSeek copy",
                "baseURL": "https://api.deepseek.com",
                "apiKey": "secret",
                "models": [{ "id": "deepseek-v4-pro" }]
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("dsh_deepseek".to_string()),
            ..Default::default()
        });

        assert!(add(&state, provider, true).is_err());

        let after = home.read();
        assert_eq!(before, after);
        assert!(state
            .db
            .get_provider_by_id("official-copy", APP)
            .unwrap()
            .is_none());
    }

    #[test]
    #[serial]
    fn add_rejects_model_less_providers_without_partial_writes() {
        let _home = DshHome::new();
        let state = state();
        import_from_live(&state).unwrap();
        let mut provider = Provider::with_id(
            "no-models".to_string(),
            "No Models".to_string(),
            json!({
                "displayName": "No Models",
                "api": "openai-completions",
                "baseURL": "https://x.example/v1",
                "apiKeyEnv": "NO_MODELS_API_KEY",
                "apiKey": "secret",
                "models": []
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("dsh_pi_ai".to_string()),
            ..Default::default()
        });

        assert!(add(&state, provider, true).is_err());
        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert!(!native.providers.contains_key("no-models"));
        assert!(state
            .db
            .get_provider_by_id("no-models", APP)
            .unwrap()
            .is_none());
    }

    #[test]
    #[serial]
    fn enable_supports_string_form_model_catalogs_and_skips_blank_ids() {
        let home = DshHome::new();
        home.seed(
            "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      strings:\n        displayName: Strings\n        baseURL: https://s.example\n        models:\n          - \"\"\n          - str-model\n",
        );
        let state = state();
        import_from_live(&state).unwrap();

        enable(&state, "strings").unwrap();

        let native = crate::deepseek_harness_config::read_native_state().unwrap();
        assert_eq!(native.current_provider.as_deref(), Some("strings"));
        assert_eq!(native.current_model.as_deref(), Some("str-model"));
    }

    /// 隔离开 `dsh_relay_state.json` 所在的配置目录（`CC_SWITCH_TEST_HOME`）。
    struct ConfigHome {
        _dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl ConfigHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            Self {
                _dir: dir,
                previous,
            }
        }
    }

    impl Drop for ConfigHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    /// 回归：接管期间编辑供应商，DSH 里必须继续走中转地址，原始地址只记进账本。
    ///
    /// 否则用户一保存，DSH 就直连了——CC Switch 退出后能不能用的问题倒是没了，
    /// 但「退出前走中转」这个前提也没了。
    #[test]
    #[serial]
    fn update_while_relay_attached_keeps_dsh_on_the_relay_url() {
        let home = DshHome::new();
        let _config = ConfigHome::new();
        let state = state();
        import_from_live(&state).unwrap();

        let relay_base_url = "http://127.0.0.1:15721/dsh/deepseek-official";
        let ledger = crate::services::dsh_relay::state_path();
        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(
            &ledger,
            json!({
                "attached": true,
                "baseUrl": "http://127.0.0.1:15721",
                "providers": [{
                    "providerId": crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID,
                    "name": "DeepSeek",
                    "originalBaseUrl": "https://api.deepseek.com",
                    "relayBaseUrl": relay_base_url,
                    "relayed": true
                }]
            })
            .to_string(),
        )
        .unwrap();

        let mut provider = state
            .db
            .get_provider_by_id(crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID, APP)
            .unwrap()
            .unwrap();
        provider.settings_config["baseURL"] = json!("https://api.deepseek.com/anthropic");

        update(&state, None, provider).unwrap();

        // 原生配置仍指向中转地址
        let patch = home.read();
        assert!(
            patch.contains(relay_base_url),
            "DSH 应该继续走中转地址: {patch}"
        );
        assert!(
            !patch.contains("api.deepseek.com/anthropic"),
            "用户填的地址不应该写进 DSH: {patch}"
        );

        // 账本记下的是用户填的原始地址
        let snapshot = crate::services::dsh_relay::read_snapshot();
        let entry = snapshot
            .providers
            .iter()
            .find(|entry| entry.provider_id == crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID)
            .expect("账本里应该有这个供应商");
        assert_eq!(
            entry.original_base_url.as_deref(),
            Some("https://api.deepseek.com/anthropic")
        );
        assert_eq!(entry.relay_base_url.as_deref(), Some(relay_base_url));

        // 反过来同步原生配置时，中转地址也不能回流进数据库
        import_from_live(&state).unwrap();
        let saved = state
            .db
            .get_provider_by_id(crate::deepseek_harness_config::OFFICIAL_PROVIDER_ID, APP)
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.settings_config["baseURL"],
            json!("https://api.deepseek.com/anthropic")
        );
    }
}
