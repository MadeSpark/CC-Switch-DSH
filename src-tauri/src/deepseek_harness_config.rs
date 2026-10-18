use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use yaml_rust::yaml::{Hash as YamlHash, Yaml};
use yaml_rust::{YamlEmitter, YamlLoader};

use crate::config::{atomic_write_private, get_home_dir};
use crate::deepseek_harness_patch as patch;
use crate::error::AppError;

pub const OFFICIAL_PROVIDER_ID: &str = "deepseek-official";
pub const DEFAULT_PROFILE_NAME: &str = "default";
pub const DESKTOP_PROFILE_NAME: &str = "desktop";
const API_KEY_FIELD: &str = "apiKey";
const SETTINGS_NAMESPACE: &str = patch::OFFICIAL_ENTRY_ID;
const PI_AI_NAMESPACE: &str = patch::PI_AI_ENTRY_ID;
const DEFAULT_MODEL_NAMESPACE: &str = patch::DEFAULT_MODEL_ENTRY_ID;
const OFFICIAL_ENTRY_NAME: &str = patch::OFFICIAL_ENTRY_NAME;
const PI_AI_ENTRY_NAME: &str = patch::PI_AI_ENTRY_NAME;
const DEFAULT_MODEL_ENTRY_NAME: &str = patch::DEFAULT_MODEL_ENTRY_NAME;
const API_KEY_REF: &str = "DEEPSEEK_API_KEY";
const PROFILE_PATCH_TEMPLATE: &str = "\
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
";
const PROFILE_PNPM_WORKSPACE: &str = "\
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
";

/// A DeepSeek Harness provider profile stored by CC Switch.
///
/// `apiKey` is intentionally excluded from live settings: official Harness keeps secrets in
/// `$DSH_HOME/.credentials.yaml`, not in `settings.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DeepSeekHarnessProviderConfig {
    #[serde(rename = "apiKey", default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "baseURL", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(
        rename = "reasoningEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort: Option<String>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeProviderSource {
    DeepSeek,
    PiAi,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeProvider {
    pub name: String,
    pub source: NativeProviderSource,
    pub config: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NativeState {
    pub providers: indexmap::IndexMap<String, NativeProvider>,
    pub current_provider: Option<String>,
    pub current_model: Option<String>,
}

pub fn get_dsh_home() -> PathBuf {
    resolve_dsh_home(
        settings_override(),
        std::env::var_os("DSH_HOME"),
        get_home_dir().join(".dsh"),
    )
}

#[cfg(not(test))]
fn settings_override() -> Option<PathBuf> {
    crate::settings::get_dsh_override_dir()
}

#[cfg(test)]
fn settings_override() -> Option<PathBuf> {
    None
}

fn resolve_dsh_home(
    settings_override: Option<PathBuf>,
    env_override: Option<std::ffi::OsString>,
    default_path: PathBuf,
) -> PathBuf {
    if let Some(path) = settings_override {
        return path;
    }
    env_override
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_path)
}

/// Profile CC Switch manages when a caller does not name one.
///
/// The desktop application runs an Electron-managed `desktop` profile and exports
/// `DSH_PROFILE` to its own child processes; outside that environment we prefer an
/// existing `desktop` profile over the generic `default` one so that writes land in
/// the same patch layer the running Harness actually reads.
pub fn resolve_active_profile() -> String {
    if let Ok(name) = std::env::var("DSH_PROFILE") {
        let trimmed = name.trim();
        if !trimmed.is_empty() && normalize_profile_name(Some(trimmed)).is_ok() {
            return trimmed.to_string();
        }
    }
    let profiles = get_dsh_home().join("profiles");
    if profiles.join(DESKTOP_PROFILE_NAME).is_dir() {
        return DESKTOP_PROFILE_NAME.to_string();
    }
    if profiles.join(DEFAULT_PROFILE_NAME).is_dir() {
        return DEFAULT_PROFILE_NAME.to_string();
    }
    DESKTOP_PROFILE_NAME.to_string()
}

/// Live patch layer (`profiles/<profile>/cordis.patch.yml`) for the active profile.
///
/// This is the only configuration surface the Harness re-reads; `$DSH_HOME/settings.yaml`
/// is imported once at startup and renamed, so writing there was silently discarded.
pub fn get_patch_path() -> PathBuf {
    patch_path_for_profile(Some(&resolve_active_profile()))
}

pub fn patch_path_for_profile(profile: Option<&str>) -> PathBuf {
    match get_profile_dir(profile) {
        Ok(dir) => patch::patch_path(&dir),
        Err(_) => patch::patch_path(&get_dsh_home().join("profiles").join(DEFAULT_PROFILE_NAME)),
    }
}

/// Kept for callers that only need "the live DeepSeek Harness config file".
pub fn get_settings_path() -> PathBuf {
    get_patch_path()
}

pub fn get_credentials_path() -> PathBuf {
    get_dsh_home().join(".credentials.yaml")
}

pub fn get_profile_dir(profile: Option<&str>) -> Result<PathBuf, AppError> {
    let name = normalize_profile_name(profile)?;
    Ok(get_dsh_home().join("profiles").join(name))
}

fn normalize_profile_name(profile: Option<&str>) -> Result<String, AppError> {
    let name = profile.unwrap_or(DEFAULT_PROFILE_NAME).trim();
    if name.is_empty() {
        return Ok(DEFAULT_PROFILE_NAME.to_string());
    }
    if name == "." || name == ".." || name == "node_modules" || name.contains(['/', '\\']) {
        return Err(AppError::InvalidInput(format!(
            "Invalid DeepSeek Harness profile name: {name}"
        )));
    }
    Ok(name.to_string())
}

/// Write one provider to both official Harness surfaces.
///
/// Unrelated YAML sections and extra credentials survive, while the managed Harness section is
/// serialized canonically because CC Switch owns that complete schema namespace.
pub fn set_provider(
    provider_id: &str,
    config: &DeepSeekHarnessProviderConfig,
) -> Result<(), AppError> {
    let mut config = config.clone();
    if config
        .profile
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        config.profile = Some(DESKTOP_PROFILE_NAME.to_string());
    }
    if config
        .base_url
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        config.base_url = None;
    }
    let config_value = serde_json::to_value(&config)
        .map_err(|error| AppError::Config(format!("Serialize DeepSeek Harness config: {error}")))?;
    let object = config_value.as_object().ok_or_else(|| {
        AppError::Config("DeepSeek Harness configuration must be an object".to_string())
    })?;

    ensure_profile(config.profile.as_deref())?;

    {
        let mut section = serde_json::Map::new();
        for (key, value) in object {
            if key == API_KEY_FIELD {
                continue;
            }
            section.insert(key.clone(), value.clone());
        }
        section.insert(
            "apiKeyEnv".to_string(),
            Value::String(API_KEY_REF.to_string()),
        );
        let path = patch_path_for_profile(config.profile.as_deref());
        patch::write_entry_config(
            &path,
            SETTINGS_NAMESPACE,
            OFFICIAL_ENTRY_NAME,
            &Value::Object(section),
        )?;
    }

    update_credential_reference(API_KEY_REF, config.api_key.as_deref())?;

    log::debug!("DeepSeek Harness provider '{provider_id}' written to live config");
    Ok(())
}

/// Remove a provider's CC Switch-managed settings and credential.
///
/// DeepSeek Harness has one official provider route, so deletion clears that route rather than
/// attempting a dictionary removal that the official schema cannot represent.
pub fn remove_provider() -> Result<(), AppError> {
    let path = get_patch_path();
    patch::remove_entry(&path, SETTINGS_NAMESPACE)?;

    // Custom routes may legally share DEEPSEEK_API_KEY; keep the credential
    // alive when a surviving route still points at it.
    let still_referenced = read_native_state()?.providers.values().any(|provider| {
        provider.config.get("apiKeyEnv").and_then(Value::as_str) == Some(API_KEY_REF)
    });
    if !still_referenced {
        update_credential_reference(API_KEY_REF, None)?;
    }
    Ok(())
}

pub fn provider_exists_in_live_config() -> Result<bool, AppError> {
    patch::has_entry(&get_patch_path(), SETTINGS_NAMESPACE)
}

pub fn read_native_state() -> Result<NativeState, AppError> {
    let entries = patch::read_entries(&get_patch_path())?;
    let credentials = read_credential_references()?;
    let mut state = NativeState::default();

    if let Some(Value::Object(section)) = entries.get(SETTINGS_NAMESPACE) {
        let config = with_resolved_api_key(Value::Object(section.clone()), &credentials);
        state.providers.insert(
            OFFICIAL_PROVIDER_ID.to_string(),
            NativeProvider {
                name: "DeepSeek".to_string(),
                source: NativeProviderSource::DeepSeek,
                config,
            },
        );
    }

    if let Some(providers) = entries
        .get(PI_AI_NAMESPACE)
        .and_then(|config| config.get("providers"))
        .and_then(Value::as_object)
    {
        for (id, config) in providers {
            let Some(config_hash) = config.as_object() else {
                continue;
            };
            let config = with_resolved_api_key(Value::Object(config_hash.clone()), &credentials);
            let name = config
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(id)
                .to_string();
            state.providers.insert(
                id.to_string(),
                NativeProvider {
                    name,
                    source: NativeProviderSource::PiAi,
                    config,
                },
            );
        }
    }

    if let Some(default_model) = entries
        .get(DEFAULT_MODEL_NAMESPACE)
        .and_then(Value::as_object)
    {
        state.current_provider = default_model
            .get("provider")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        state.current_model = default_model
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    Ok(state)
}

pub fn set_pi_ai_provider(provider_id: &str, config: &Value) -> Result<(), AppError> {
    validate_route_id(provider_id)?;
    let mut config = config.as_object().cloned().ok_or_else(|| {
        AppError::InvalidInput("DeepSeek Harness provider must be an object".to_string())
    })?;
    let api_key = config
        .remove(API_KEY_FIELD)
        .and_then(|value| value.as_str().map(ToOwned::to_owned));
    let credential_ref = config
        .get("apiKeyEnv")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned);
    if let Some(reference) = credential_ref.as_deref() {
        validate_credential_ref(reference)?;
        update_credential_reference(reference, api_key.as_deref())?;
    }
    ensure_profile(Some(&resolve_active_profile()))?;
    let route_config = Value::Object(config);
    update_patch_entry_config(
        &get_patch_path(),
        PI_AI_NAMESPACE,
        PI_AI_ENTRY_NAME,
        move |entry| {
            let providers = entry
                .entry("providers".to_string())
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            let providers = providers.as_object_mut().ok_or_else(|| {
                AppError::Config(format!(
                    "DeepSeek Harness patch entry {PI_AI_NAMESPACE} has a non-mapping `providers` value"
                ))
            })?;
            providers.insert(provider_id.to_string(), route_config.clone());
            Ok(())
        },
    )
}

pub fn remove_pi_ai_provider(provider_id: &str) -> Result<(), AppError> {
    validate_route_id(provider_id)?;
    let path = get_patch_path();
    if !path.exists() {
        return Ok(());
    }
    let credential_ref = read_native_state()?
        .providers
        .get(provider_id)
        .and_then(|provider| provider.config.get("apiKeyEnv"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    update_patch_entry_config(&path, PI_AI_NAMESPACE, PI_AI_ENTRY_NAME, |entry| {
        if let Some(Value::Object(providers)) = entry.get_mut("providers") {
            providers.remove(provider_id);
        }
        Ok(())
    })?;
    if let Some(reference) = credential_ref {
        // Custom routes may share one credential ref (including DEEPSEEK_API_KEY):
        // only clear it when no surviving route still points at it.
        let still_referenced = read_native_state()?.providers.values().any(|provider| {
            provider.config.get("apiKeyEnv").and_then(Value::as_str) == Some(reference.as_str())
        });
        if !still_referenced {
            update_credential_reference(&reference, None)?;
        }
    }
    Ok(())
}

pub fn set_current_model(provider_id: &str, model_id: &str) -> Result<(), AppError> {
    validate_route_id(provider_id)?;
    if model_id.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "DeepSeek Harness model id cannot be empty".to_string(),
        ));
    }
    ensure_profile(Some(&resolve_active_profile()))?;
    update_patch_entry_config(
        &get_patch_path(),
        DEFAULT_MODEL_NAMESPACE,
        DEFAULT_MODEL_ENTRY_NAME,
        |entry| {
            entry.insert(
                "provider".to_string(),
                Value::String(provider_id.to_string()),
            );
            entry.insert("model".to_string(), Value::String(model_id.to_string()));
            Ok(())
        },
    )
}

/// Drop `agent-default-model` when it still points at `provider_id`.
///
/// The provider/model pair is coupled in DSH: keeping the namespace after the
/// referenced route is deleted would leave the Harness runtime targeting a
/// provider that no longer exists. Returns whether the pointer was cleared.
pub fn clear_current_model_if_provider(provider_id: &str) -> Result<bool, AppError> {
    let path = get_patch_path();
    if !path.exists() {
        return Ok(false);
    }
    let points_at_provider = patch::read_entry_config(&path, DEFAULT_MODEL_NAMESPACE)?
        .and_then(|config| {
            config
                .get("provider")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .is_some_and(|provider| provider == provider_id);
    if !points_at_provider {
        return Ok(false);
    }
    patch::remove_entry(&path, DEFAULT_MODEL_NAMESPACE)?;
    Ok(true)
}

/// Read → mutate → write one patch entry's `config:` mapping.
///
/// The Harness rewrites `cordis.patch.yml` itself (its settings UI persists into the
/// same file), so every write re-reads the current file and only replaces the subtree
/// CC Switch owns.
fn update_patch_entry_config(
    path: &Path,
    entry_id: &str,
    entry_name: &str,
    mutate: impl FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut config = match patch::read_entry_config(path, entry_id)? {
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(AppError::Config(format!(
                "DeepSeek Harness patch entry `{entry_id}` must hold a YAML mapping"
            )))
        }
        None => serde_json::Map::new(),
    };
    mutate(&mut config)?;
    patch::write_entry_config(path, entry_id, entry_name, &Value::Object(config))
}

fn with_resolved_api_key(mut config: Value, credentials: &HashMap<String, String>) -> Value {
    let reference = config
        .get("apiKeyEnv")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if let (Some(reference), Some(object)) = (reference, config.as_object_mut()) {
        if let Some(api_key) = credentials.get(&reference) {
            object.insert(API_KEY_FIELD.to_string(), Value::String(api_key.clone()));
        }
    }
    config
}

fn read_credential_references() -> Result<HashMap<String, String>, AppError> {
    let path = get_credentials_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let document = parse_yaml_document(&path)?;
    let Some(root) = document.as_hash() else {
        return Ok(HashMap::new());
    };
    let refs = if root.get(&mapping_key("version")).is_some() {
        root.get(&mapping_key("refs")).and_then(Yaml::as_hash)
    } else {
        Some(root)
    };
    Ok(refs
        .into_iter()
        .flat_map(|refs| refs.iter())
        .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value.as_str()?.to_string())))
        .collect())
}

fn update_credential_reference(reference: &str, value: Option<&str>) -> Result<(), AppError> {
    validate_credential_ref(reference)?;
    let path = get_credentials_path();
    if value.map(str::trim).unwrap_or("").is_empty() && !path.exists() {
        return Ok(());
    }
    update_yaml_document(&path, |document| {
        let root = ensure_hash(document);
        if !root.contains_key(&mapping_key("version")) {
            let legacy = root.clone();
            root.clear();
            root.insert(mapping_key("version"), Yaml::Integer(1));
            root.insert(mapping_key("refs"), Yaml::Hash(legacy));
        }
        let refs = ensure_child_hash(root, "refs");
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => {
                refs.insert(mapping_key(reference), Yaml::String(value.to_string()));
            }
            None => {
                refs.remove(&mapping_key(reference));
            }
        }
        Ok(())
    })
}

fn ensure_hash(document: &mut Yaml) -> &mut YamlHash {
    if !matches!(document, Yaml::Hash(_)) {
        *document = Yaml::Hash(YamlHash::new());
    }
    let Yaml::Hash(hash) = document else {
        unreachable!("document was normalized")
    };
    hash
}

fn ensure_child_hash<'a>(parent: &'a mut YamlHash, key: &str) -> &'a mut YamlHash {
    let key = mapping_key(key);
    if !matches!(parent.get(&key), Some(Yaml::Hash(_))) {
        parent.insert(key.clone(), Yaml::Hash(YamlHash::new()));
    }
    let Some(Yaml::Hash(hash)) = parent.get_mut(&key) else {
        unreachable!("child was normalized")
    };
    hash
}

fn validate_route_id(value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::InvalidInput(format!(
            "Invalid DeepSeek Harness provider id: {value}"
        )));
    }
    Ok(())
}

fn validate_credential_ref(value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_uppercase() || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err(AppError::InvalidInput(format!(
            "Invalid DeepSeek Harness credential reference: {value}"
        )));
    }
    Ok(())
}

fn ensure_profile(profile: Option<&str>) -> Result<(), AppError> {
    let profile_dir = get_profile_dir(profile)?;
    fs::create_dir_all(&profile_dir).map_err(|error| AppError::io(&profile_dir, error))?;

    let manifest_path = profile_dir.join("package.json");
    if !manifest_path.exists() {
        let profile_name = normalize_profile_name(profile)?;
        let manifest = serde_json::json!({
            "name": format!("dsh-profile-{profile_name}"),
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@deepseek-ai/dsh-plugin-desktop",
            ] } }
        });
        crate::config::write_json_file(&manifest_path, &manifest)?;
    }

    initialize_if_missing(
        &profile_dir.join("cordis.patch.yml"),
        PROFILE_PATCH_TEMPLATE,
    )?;
    initialize_if_missing(
        &profile_dir.join("pnpm-workspace.yaml"),
        PROFILE_PNPM_WORKSPACE,
    )?;
    Ok(())
}

fn parse_yaml_document(path: &Path) -> Result<Yaml, AppError> {
    if !path.exists() {
        return Ok(Yaml::Hash(YamlHash::new()));
    }
    let contents = fs::read_to_string(path).map_err(|error| AppError::io(path, error))?;
    let mut documents = YamlLoader::load_from_str(&contents)
        .map_err(|error| AppError::Config(format!("Parse {}: {error}", path.display())))?;
    match documents.len() {
        0 => Ok(Yaml::Hash(YamlHash::new())),
        1 => Ok(documents.remove(0)),
        _ => Err(AppError::Config(format!(
            "{} must contain exactly one YAML document",
            path.display()
        ))),
    }
}

fn update_yaml_document(
    path: &Path,
    update: impl FnOnce(&mut Yaml) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut document = parse_yaml_document(path)?;
    update(&mut document)?;
    let mut output = String::new();
    let mut emitter = YamlEmitter::new(&mut output);
    emitter
        .dump(&document)
        .map_err(|error| AppError::Config(format!("Serialize {}: {error:?}", path.display())))?;
    output.push('\n');
    if path.file_name().and_then(|name| name.to_str()) == Some(".credentials.yaml") {
        atomic_write_private(path, output.as_bytes())
    } else {
        crate::config::write_text_file(path, &output)
    }
}

fn mapping_key(name: &str) -> Yaml {
    Yaml::String(name.to_string())
}

fn initialize_if_missing(path: &Path, contents: &str) -> Result<(), AppError> {
    if !path.exists() {
        crate::config::write_text_file(path, contents)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    const DESKTOP_PATCH: &str = "profiles/desktop/cordis.patch.yml";

    fn with_temp_home(test: impl FnOnce(&Path)) {
        let directory = tempfile::tempdir().unwrap();
        let previous_home = std::env::var_os("DSH_HOME");
        let previous_profile = std::env::var_os("DSH_PROFILE");
        std::env::set_var("DSH_HOME", directory.path());
        std::env::set_var("DSH_PROFILE", DESKTOP_PROFILE_NAME);
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| test(directory.path())));
        match previous_home {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
        match previous_profile {
            Some(value) => std::env::set_var("DSH_PROFILE", value),
            None => std::env::remove_var("DSH_PROFILE"),
        }
        result.unwrap();
    }

    fn desktop_patch_path(home: &Path) -> PathBuf {
        home.join(DESKTOP_PATCH)
    }

    /// Seed the live patch layer the way the Harness stores it (top-level array).
    fn seed_patch(home: &Path, contents: &str) -> PathBuf {
        let path = desktop_patch_path(home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn read_patch(home: &Path) -> String {
        std::fs::read_to_string(desktop_patch_path(home)).unwrap()
    }

    #[test]
    fn dsh_home_prefers_settings_override_then_env_then_default() {
        let override_dir = PathBuf::from("/tmp/dsh-override");
        let env_dir = PathBuf::from("/tmp/dsh-env");
        let default_dir = PathBuf::from("/tmp/dsh-default");
        assert_eq!(
            resolve_dsh_home(
                Some(override_dir.clone()),
                Some(env_dir.clone().into_os_string()),
                default_dir.clone()
            ),
            override_dir
        );
        assert_eq!(
            resolve_dsh_home(
                None,
                Some(env_dir.clone().into_os_string()),
                default_dir.clone()
            ),
            env_dir
        );
        assert_eq!(
            resolve_dsh_home(None, Some("".into()), default_dir.clone()),
            default_dir
        );
        assert_eq!(
            resolve_dsh_home(None, None, default_dir.clone()),
            default_dir
        );
    }

    #[test]
    #[serial]
    fn writes_official_settings_credentials_and_desktop_profile() {
        with_temp_home(|home| {
            seed_patch(
                home,
                "# preserved\n- id: other-plugin\n  name: other-plugin\n  config:\n    enabled: true\n",
            );

            let config = DeepSeekHarnessProviderConfig {
                api_key: Some("sk-test".to_string()),
                base_url: Some("https://example.com".to_string()),
                profile: None,
                models: Some(serde_json::json!([
                    { "id": "deepseek-v4-flash", "name": "Flash" }
                ])),
                ..Default::default()
            };
            set_provider("official", &config).unwrap();

            let settings = read_patch(home);
            assert!(settings.starts_with("# preserved"));
            assert!(settings.contains("- id: other-plugin"));
            assert!(settings.contains("- id: llm-deepseek"));
            assert!(settings.contains("name: '@deepseek-ai/dsh-llm-deepseek'"));
            assert!(settings.contains("baseURL: https://example.com"));
            assert!(settings.contains("apiKeyEnv: DEEPSEEK_API_KEY"));
            assert!(!settings.contains("sk-test"));

            let credentials = std::fs::read_to_string(home.join(".credentials.yaml")).unwrap();
            assert!(credentials.contains("version: 1"));
            assert!(credentials.contains("refs:"));
            assert!(credentials.contains("DEEPSEEK_API_KEY: \"sk-test\""));
            assert!(home.join("profiles/desktop/package.json").exists());
            assert!(home.join("profiles/desktop/cordis.patch.yml").exists());
            assert!(home.join("profiles/desktop/pnpm-workspace.yaml").exists());
            // The dead legacy surface must never be written again.
            assert!(!home.join("settings.yaml").exists());
        });
    }

    #[test]
    #[serial]
    fn preserves_sibling_credentials_and_rejects_profile_traversal() {
        with_temp_home(|home| {
            std::fs::write(home.join(".credentials.yaml"), "OTHER_KEY: keep\n").unwrap();
            set_provider(
                "official",
                &DeepSeekHarnessProviderConfig {
                    api_key: Some("rotated".to_string()),
                    base_url: Some("https://api.deepseek.com/v1".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            let credentials = std::fs::read_to_string(home.join(".credentials.yaml")).unwrap();
            assert!(credentials.contains("OTHER_KEY: keep"));
            assert!(credentials.contains("DEEPSEEK_API_KEY: rotated"));

            let error = get_profile_dir(Some("../outside")).unwrap_err();
            assert!(error
                .to_string()
                .contains("Invalid DeepSeek Harness profile"));
        });
    }

    #[test]
    #[serial]
    fn clears_stale_credentials_when_api_key_is_removed() {
        with_temp_home(|home| {
            std::fs::write(
                home.join(".credentials.yaml"),
                "DEEPSEEK_API_KEY: secret\nOTHER_KEY: keep\n",
            )
            .unwrap();

            set_provider(
                "official",
                &DeepSeekHarnessProviderConfig {
                    api_key: None,
                    base_url: Some("https://api.deepseek.com".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

            let credentials = std::fs::read_to_string(home.join(".credentials.yaml")).unwrap();
            assert!(!credentials.contains("DEEPSEEK_API_KEY"));
            assert!(credentials.contains("OTHER_KEY: keep"));
        });
    }

    #[test]
    #[serial]
    fn preserves_custom_providers_when_switching_managed_route() {
        with_temp_home(|home| {
            seed_patch(
                home,
                "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      k3:\n        displayName: K3\n- id: other-plugin\n  name: other-plugin\n  config:\n    enabled: true\n",
            );
            std::fs::write(home.join(".credentials.yaml"), "K3_API_KEY: keep\n").unwrap();

            set_provider(
                "official",
                &DeepSeekHarnessProviderConfig {
                    api_key: Some("sk-test".to_string()),
                    base_url: Some("https://api.deepseek.com".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

            let settings = read_patch(home);
            assert!(settings.contains("- id: llm-pi-ai"));
            assert!(settings.contains("displayName: K3"));
            assert!(settings.contains("- id: llm-deepseek"));
            let credentials = std::fs::read_to_string(home.join(".credentials.yaml")).unwrap();
            assert!(credentials.contains("K3_API_KEY: keep"));

            remove_provider().unwrap();

            let settings = read_patch(home);
            assert!(!settings.contains("llm-deepseek"));
            assert!(settings.contains("displayName: K3"));
            assert!(settings.contains("- id: other-plugin"));
        });
    }

    #[test]
    #[serial]
    fn accepts_missing_base_url_for_official_runtime_fallback() {
        with_temp_home(|home| {
            for base_url in [None, Some(""), Some("   ")] {
                let base_url = base_url.map(ToOwned::to_owned);
                set_provider(
                    "official",
                    &DeepSeekHarnessProviderConfig {
                        api_key: Some("sk-test".to_string()),
                        base_url,
                        ..Default::default()
                    },
                )
                .unwrap();

                let settings = read_patch(home);
                assert!(settings.contains("llm-deepseek"));
                assert!(!settings.contains("baseURL"));
            }
        });
    }

    #[test]
    #[serial]
    fn removes_managed_configuration_only() {
        with_temp_home(|home| {
            seed_patch(
                home,
                "# preserved\n- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    baseURL: https://example.com\n- id: other-plugin\n  name: other-plugin\n  config:\n    enabled: true\n",
            );
            std::fs::write(
                home.join(".credentials.yaml"),
                "DEEPSEEK_API_KEY: secret\nOTHER_KEY: keep\n",
            )
            .unwrap();

            remove_provider().unwrap();

            let settings = read_patch(home);
            assert!(settings.starts_with("# preserved"));
            assert!(!settings.contains("llm-deepseek"));
            assert!(settings.contains("- id: other-plugin"));
            let credentials = std::fs::read_to_string(home.join(".credentials.yaml")).unwrap();
            assert!(!credentials.contains("DEEPSEEK_API_KEY"));
            assert!(credentials.contains("OTHER_KEY: keep"));
        });
    }

    #[test]
    #[serial]
    fn detects_managed_live_route() {
        with_temp_home(|home| {
            assert!(!provider_exists_in_live_config().unwrap());

            seed_patch(
                home,
                "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    baseURL: https://example.com\n",
            );
            assert!(provider_exists_in_live_config().unwrap());

            remove_provider().unwrap();
            assert!(!provider_exists_in_live_config().unwrap());
        });
    }

    #[test]
    #[serial]
    fn reads_official_and_pi_ai_native_providers_with_current_model() {
        with_temp_home(|home| {
            seed_patch(
                home,
                "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    baseURL: https://api.deepseek.com\n    apiKeyEnv: DEEPSEEK_API_KEY\n    models:\n      - id: deepseek-v4-pro\n        name: DeepSeek V4 Pro\n- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      company-gateway:\n        displayName: Company Gateway\n        api: openai-completions\n        baseURL: https://gateway.example/v1\n        apiKeyEnv: COMPANY_GATEWAY_API_KEY\n        models:\n          - id: example-model-1\n            name: Example Model\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: company-gateway\n    model: example-model-1\n",
            );
            std::fs::write(
                home.join(".credentials.yaml"),
                "version: 1\nrefs:\n  DEEPSEEK_API_KEY: deepseek-secret\n  COMPANY_GATEWAY_API_KEY: gateway-secret\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: keep\n",
            )
            .unwrap();

            let state = read_native_state().unwrap();
            assert_eq!(state.current_provider.as_deref(), Some("company-gateway"));
            assert_eq!(state.current_model.as_deref(), Some("example-model-1"));
            assert_eq!(state.providers.len(), 2);

            let official = state.providers.get(OFFICIAL_PROVIDER_ID).unwrap();
            assert_eq!(official.source, NativeProviderSource::DeepSeek);
            assert_eq!(official.config["apiKey"], "deepseek-secret");

            let gateway = state.providers.get("company-gateway").unwrap();
            assert_eq!(gateway.source, NativeProviderSource::PiAi);
            assert_eq!(gateway.name, "Company Gateway");
            assert_eq!(gateway.config["baseURL"], "https://gateway.example/v1");
            assert_eq!(gateway.config["apiKey"], "gateway-secret");
        });
    }

    #[test]
    #[serial]
    fn writes_versioned_credentials_and_preserves_records() {
        with_temp_home(|home| {
            std::fs::write(
                home.join(".credentials.yaml"),
                "version: 1\nrefs:\n  OTHER_KEY: keep\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: keep-record\n",
            )
            .unwrap();

            set_provider(
                OFFICIAL_PROVIDER_ID,
                &DeepSeekHarnessProviderConfig {
                    api_key: Some("rotated".to_string()),
                    base_url: Some("https://api.deepseek.com".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

            let credentials = parse_yaml_document(&home.join(".credentials.yaml")).unwrap();
            let root = credentials.as_hash().unwrap();
            assert_eq!(root[&mapping_key("version")].as_i64(), Some(1));
            let refs = root[&mapping_key("refs")].as_hash().unwrap();
            assert_eq!(
                refs[&mapping_key("DEEPSEEK_API_KEY")].as_str(),
                Some("rotated")
            );
            assert_eq!(refs[&mapping_key("OTHER_KEY")].as_str(), Some("keep"));
            assert!(root.contains_key(&mapping_key("records")));
        });
    }

    #[test]
    #[serial]
    fn writes_and_removes_pi_ai_provider_without_touching_siblings() {
        with_temp_home(|home| {
            seed_patch(
                home,
                "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      sibling:\n        displayName: Keep\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: sibling\n    model: keep-model\n",
            );
            std::fs::write(home.join(".credentials.yaml"), "version: 1\nrefs: {}\n").unwrap();

            let config = serde_json::json!({
                "displayName": "Company Gateway",
                "api": "openai-completions",
                "baseURL": "https://gateway.example/v1",
                "apiKeyEnv": "COMPANY_API_KEY",
                "apiKey": "secret",
                "models": [{ "id": "glm-5.3", "name": "GLM 5.3" }]
            });
            set_pi_ai_provider("company", &config).unwrap();
            set_current_model("company", "glm-5.3").unwrap();

            let state = read_native_state().unwrap();
            assert!(state.providers.contains_key("sibling"));
            assert!(state.providers.contains_key("company"));
            assert_eq!(state.current_provider.as_deref(), Some("company"));
            assert_eq!(state.current_model.as_deref(), Some("glm-5.3"));

            remove_pi_ai_provider("company").unwrap();
            let state = read_native_state().unwrap();
            assert!(state.providers.contains_key("sibling"));
            assert!(!state.providers.contains_key("company"));
            let credentials = parse_yaml_document(&home.join(".credentials.yaml")).unwrap();
            let refs = credentials
                .as_hash()
                .and_then(|root| root.get(&mapping_key("refs")))
                .and_then(Yaml::as_hash)
                .unwrap();
            assert!(!refs.contains_key(&mapping_key("COMPANY_API_KEY")));
        });
    }
}
