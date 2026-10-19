//! Read/write access to DeepSeek Harness' live user patch layer.
//!
//! The Harness desktop application treats
//! `$DSH_HOME/profiles/<profile>/cordis.patch.yml` as the only user-editable
//! configuration surface: a top-level YAML array of loader patch entries that
//! is applied after every bundle layer. The historical `$DSH_HOME/settings.yaml`
//! is imported once at startup, renamed to `settings.yaml.imported`, and never
//! read again — writing there has no effect on a running Harness.
//!
//! CC Switch therefore owns a small set of named entries inside the patch file
//! (`llm-deepseek`, `llm-pi-ai`, `agent-default-model`). Everything else in that
//! file belongs to the user or to other plugins, so writes are done as an
//! indentation-aware text splice: the entry's `config:` subtree is replaced,
//! while all other entries, keys, comments and unknown YAML tags stay
//! byte-identical.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use yaml_rust::yaml::Yaml;
use yaml_rust::YamlLoader;

use crate::error::AppError;

pub const OFFICIAL_ENTRY_ID: &str = "llm-deepseek";
pub const PI_AI_ENTRY_ID: &str = "llm-pi-ai";
pub const DEFAULT_MODEL_ENTRY_ID: &str = "agent-default-model";

pub const OFFICIAL_ENTRY_NAME: &str = "@deepseek-ai/dsh-llm-deepseek";
pub const PI_AI_ENTRY_NAME: &str = "@deepseek-ai/dsh-llm-pi-ai";
pub const DEFAULT_MODEL_ENTRY_NAME: &str = "@deepseek-ai/dsh-agent-default-model";

const INDENT_STEP: usize = 2;
const BACKUP_SUFFIX: &str = ".ccswitch.bak";

/// Absolute path of the live patch file for `profile`.
pub fn patch_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("cordis.patch.yml")
}

/// Parse the patch file into `id -> (name, config)`.
pub fn read_entries(path: &Path) -> Result<HashMap<String, Value>, AppError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let contents = fs::read_to_string(path).map_err(|error| AppError::io(path, error))?;
    parse_entries(path, &contents)
}

fn parse_entries(path: &Path, contents: &str) -> Result<HashMap<String, Value>, AppError> {
    let mut entries = HashMap::new();
    let documents = YamlLoader::load_from_str(contents).map_err(|error| {
        AppError::Config(format!(
            "Parse {} as patch layer: {error}; CC Switch will not rewrite a patch file it cannot read",
            path.display()
        ))
    })?;
    let Some(document) = documents.into_iter().next() else {
        return Ok(entries);
    };
    let Yaml::Array(items) = document else {
        return Err(AppError::Config(format!(
            "{} must contain a top-level YAML array of patch entries",
            path.display()
        )));
    };
    for item in items {
        let Yaml::Hash(hash) = item else { continue };
        let Some(id) = hash
            .get(&Yaml::String("id".to_string()))
            .and_then(Yaml::as_str)
        else {
            continue;
        };
        // Loader patch entries are either `- id: X, config: {...}` overrides or
        // `- insert: [...]` instructions; only the former carries a config.
        let config = hash
            .get(&Yaml::String("config".to_string()))
            .map(yaml_to_json)
            .transpose()?
            .unwrap_or(Value::Object(Map::new()));
        entries.insert(id.to_string(), config);
    }
    Ok(entries)
}

fn yaml_to_json(value: &Yaml) -> Result<Value, AppError> {
    Ok(match value {
        Yaml::Real(text) => text
            .parse::<f64>()
            .map(|number| Value::from(number))
            .map_err(|error| AppError::Config(format!("Invalid YAML float {text}: {error}")))?,
        Yaml::Integer(number) => Value::from(*number),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Boolean(flag) => Value::Bool(*flag),
        Yaml::Array(items) => {
            Value::Array(items.iter().map(yaml_to_json).collect::<Result<_, _>>()?)
        }
        Yaml::Hash(hash) => {
            let mut object = Map::new();
            for (key, item) in hash {
                let Yaml::String(key) = key else {
                    return Err(AppError::Config(
                        "Patch layer mapping keys must be strings".to_string(),
                    ));
                };
                object.insert(key.clone(), yaml_to_json(item)?);
            }
            Value::Object(object)
        }
        Yaml::Alias(_) => {
            return Err(AppError::Config(
                "YAML aliases are not supported in the DeepSeek Harness patch layer".to_string(),
            ))
        }
        Yaml::Null => Value::Null,
        Yaml::BadValue => {
            return Err(AppError::Config(
                "Unsupported YAML value in the DeepSeek Harness patch layer".to_string(),
            ))
        }
    })
}

/// Replace the `config:` subtree of one entry, creating the entry when absent.
pub fn write_entry_config(
    path: &Path,
    entry_id: &str,
    entry_name: &str,
    config: &Value,
) -> Result<(), AppError> {
    let text = read_text_or_template(path)?;
    let updated = splice_entry_config(&text, entry_id, entry_name, config)?;
    // Refuse to write anything the Harness loader would reject.
    YamlLoader::load_from_str(&updated).map_err(|error| {
        AppError::Config(format!(
            "Refusing to write invalid patch layer for {}: {error}",
            path.display()
        ))
    })?;
    if updated == text {
        return Ok(());
    }
    backup(path, &text);
    write_patch_text(path, &updated)
}

/// Same as [`crate::config::write_text_file`], but survives the Harness reading the file.
///
/// The Harness keeps a `chokidar` watcher on the patch layer: while it is inside its
/// `awaitWriteFinish` window it holds the file open, and on Windows `ReplaceFileW` then fails with
/// `ERROR_UNABLE_TO_REMOVE_REPLACED (1175)` / `ERROR_SHARING_VIOLATION (32)` /
/// `ERROR_ACCESS_DENIED (5)`. That is a race, not a permission problem, so retry with a short
/// backoff; if it still will not replace, fall back to rewriting the file in place, which never
/// conflicts with readers. Losing atomicity here is the lesser evil: the alternative is leaving a
/// provider pointed at a relay port that does not exist any more.
fn write_patch_text(path: &Path, text: &str) -> Result<(), AppError> {
    let mut last_error: Option<AppError> = None;
    for attempt in 0..8u64 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20 * attempt));
        }
        match crate::config::write_text_file(path, text) {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_share_violation(&error) => last_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    log::warn!(
        "DeepSeek Harness: replacing {} kept failing (the Harness is probably reading it), rewriting in place: {}",
        path.display(),
        last_error
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default()
    );
    write_in_place(path, text).map_err(|error| match &last_error {
        Some(previous) => {
            AppError::Config(format!("{previous}; in-place rewrite failed too: {error}"))
        }
        None => error,
    })
}

/// Truncate + write through an existing handle. Non-atomic on purpose: it only runs after the
/// atomic path proved unusable, and it is the only writer that always succeeds while the file is
/// merely being read.
fn write_in_place(path: &Path, text: &str) -> Result<(), AppError> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| AppError::io(path, error))?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| AppError::io(path, error))
}

/// Whether an atomic-replace failure is the "someone else has it open" kind.
fn is_transient_share_violation(error: &AppError) -> bool {
    let source = match error {
        AppError::Io { source, .. } | AppError::IoContext { source, .. } => source,
        _ => return false,
    };
    // 5 ACCESS_DENIED / 32 SHARING_VIOLATION / 33 LOCK_VIOLATION /
    // 1175 UNABLE_TO_REMOVE_REPLACED / 1176 UNABLE_TO_MOVE_REPLACEMENT / 1177 UNABLE_TO_MOVE_REPLACEMENT_2
    matches!(
        source.raw_os_error(),
        Some(5 | 32 | 33 | 1175 | 1176 | 1177)
    ) || source.kind() == std::io::ErrorKind::PermissionDenied
}

/// Read the `config:` object of one entry.
pub fn read_entry_config(path: &Path, entry_id: &str) -> Result<Option<Value>, AppError> {
    Ok(read_entries(path)?.remove(entry_id))
}

/// Whether the patch layer currently carries `entry_id`.
pub fn has_entry(path: &Path, entry_id: &str) -> Result<bool, AppError> {
    Ok(read_entries(path)?.contains_key(entry_id))
}

/// Drop one entry from the patch layer. Returns whether it existed.
pub fn remove_entry(path: &Path, entry_id: &str) -> Result<bool, AppError> {
    if !path.exists() {
        return Ok(false);
    }
    let text = read_text_or_template(path)?;
    let Some(updated) = splice_remove_entry(&text, entry_id)? else {
        return Ok(false);
    };
    YamlLoader::load_from_str(&updated).map_err(|error| {
        AppError::Config(format!(
            "Refusing to write invalid patch layer for {}: {error}",
            path.display()
        ))
    })?;
    backup(path, &text);
    write_patch_text(path, &updated)?;
    Ok(true)
}

/// Where [`backup`] keeps the previous version of `path`.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut backup = path.as_os_str().to_owned();
    backup.push(BACKUP_SUFFIX);
    PathBuf::from(backup)
}

fn read_text_or_template(path: &Path) -> Result<String, AppError> {
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|error| AppError::io(path, error))
}

fn backup(path: &Path, previous: &str) {
    if previous.trim().is_empty() {
        return;
    }
    let backup_path = backup_path(path);
    if fs::write(&backup_path, previous).is_err() {
        log::warn!(
            "DeepSeek Harness: could not back up {} to {}",
            path.display(),
            backup_path.display()
        );
    }
}

// ---------------------------------------------------------------------------
// Indentation-aware text splicing
// ---------------------------------------------------------------------------

fn indent_of(line: &str) -> Option<usize> {
    if line.trim().is_empty() {
        return None;
    }
    Some(line.len() - line.trim_start_matches(' ').len())
}

/// Parse `key: value` (no leading array dash). Returns the bare key.
fn mapping_key_of(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let colon = trimmed.find(':')?;
    let rest = &trimmed[colon + 1..];
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    let key = trimmed[..colon].trim();
    let key = key
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            key.strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
        .unwrap_or(key);
    Some(key)
}

/// Scalar text after `key:` on the same line, if any.
fn mapping_value_of(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let colon = trimmed.find(':')?;
    let rest = trimmed[colon + 1..].trim();
    if rest.is_empty() || rest.starts_with('#') {
        None
    } else {
        Some(rest)
    }
}

fn is_entry_start(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let trimmed = line.trim_end();
    trimmed == "-" || trimmed.starts_with("- ")
}

/// Byte range `[start, end)` of the entry that begins at `start`.
fn entry_extent(lines: &[String], start: usize) -> (usize, usize) {
    let mut end = lines.len();
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        if is_entry_start(line) {
            end = index;
            break;
        }
    }
    (start, end)
}

/// `- key: value` form of an entry header, where the first key sits on the
/// dash line (`- id: llm-pi-ai`) rather than on the following indented line.
fn dash_inline_mapping(line: &str) -> Option<(&str, &str)> {
    let rest = line.trim_start().strip_prefix('-')?;
    let rest = rest.strip_prefix(' ')?;
    let key = mapping_key_of(rest)?;
    let value = mapping_value_of(rest)?;
    Some((key, value))
}

fn find_entry(lines: &[String], entry_id: &str) -> Option<(usize, usize)> {
    let matches = |value: &str| value.trim_matches(|c| c == '\'' || c == '"') == entry_id;
    for (index, line) in lines.iter().enumerate() {
        if !is_entry_start(line) {
            continue;
        }
        let (start, end) = entry_extent(lines, index);
        let inline = dash_inline_mapping(line)
            .map(|(key, value)| key == "id" && matches(value))
            .unwrap_or(false);
        let indented = (start + 1..end).any(|cursor| {
            mapping_key_of(&lines[cursor]) == Some("id")
                && mapping_value_of(&lines[cursor])
                    .map(matches)
                    .unwrap_or(false)
        });
        if inline || indented {
            return Some((start, end));
        }
    }
    None
}

/// End of the block belonging to `key_line`.
fn block_end(lines: &[String], key_line: usize, limit: usize, indent: usize) -> usize {
    let mut end = key_line + 1;
    let mut cursor = key_line + 1;
    while cursor < limit {
        match indent_of(&lines[cursor]) {
            Some(value) if value > indent => {
                end = cursor + 1;
                cursor += 1;
            }
            Some(_) => break,
            None => {
                cursor += 1;
            }
        }
    }
    while end > key_line + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    end
}

fn find_child_key(
    lines: &[String],
    range: (usize, usize),
    parent_indent: usize,
    key: &str,
) -> Option<usize> {
    (range.0..range.1).find(|&cursor| {
        indent_of(&lines[cursor]) == Some(parent_indent + INDENT_STEP)
            && mapping_key_of(&lines[cursor]) == Some(key)
    })
}

fn load_lines(text: &str) -> Vec<String> {
    text.replace('\r', "")
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect()
}

fn join_lines(lines: &[String]) -> String {
    let mut output = lines.join("\n");
    if !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn splice_entry_config(
    text: &str,
    entry_id: &str,
    entry_name: &str,
    config: &Value,
) -> Result<String, AppError> {
    let mut lines = load_lines(text);
    match find_entry(&lines, entry_id) {
        Some(range) => {
            let config_line = find_child_key(&lines, range, 0, "config");
            match config_line {
                Some(config_line) => {
                    let indent = indent_of(&lines[config_line]).unwrap_or(INDENT_STEP);
                    let end = block_end(&lines, config_line, range.1, indent);
                    let mut block = vec![format!("{}config:", " ".repeat(indent))];
                    emit_yaml(config, indent + INDENT_STEP, &mut block)?;
                    if value_is_empty_container(config) {
                        block.truncate(1);
                        block[0].push_str(" {}");
                    }
                    lines.splice(config_line..end.max(config_line + 1), block);
                }
                None => {
                    let mut block = vec![format!("{}config:", " ".repeat(INDENT_STEP))];
                    emit_yaml(config, INDENT_STEP * 2, &mut block)?;
                    if value_is_empty_container(config) {
                        block.truncate(1);
                        block[0].push_str(" {}");
                    }
                    // Insert after the entry's last non-blank line.
                    let mut insert_at = range.1;
                    while insert_at > range.0 && lines[insert_at - 1].trim().is_empty() {
                        insert_at -= 1;
                    }
                    lines.splice(insert_at..insert_at, block);
                }
            }
        }
        None => {
            while lines
                .last()
                .map(|line| line.trim().is_empty())
                .unwrap_or(false)
            {
                lines.pop();
            }
            // An unedited template is a bare flow sequence (`[]`); drop it so the
            // new entry becomes the array content.
            if lines.len() == 1 && lines[0].trim() == "[]" {
                lines.clear();
            } else if lines
                .last()
                .map(|line| line.trim() == "[]")
                .unwrap_or(false)
            {
                lines.pop();
            }
            let mut block = vec![
                format!("- id: {entry_id}"),
                format!("  name: {}", yaml_string(entry_name)),
                String::from("  config:"),
            ];
            emit_yaml(config, INDENT_STEP * 2, &mut block)?;
            if value_is_empty_container(config) {
                block.truncate(3);
                block[2].push_str(" {}");
            }
            if !lines.is_empty()
                && !lines
                    .last()
                    .map(|line| line.trim().is_empty())
                    .unwrap_or(false)
            {
                lines.push(String::new());
            }
            lines.extend(block);
        }
    }
    Ok(join_lines(&lines))
}

fn splice_remove_entry(text: &str, entry_id: &str) -> Result<Option<String>, AppError> {
    let mut lines = load_lines(text);
    let Some((start, end)) = find_entry(&lines, entry_id) else {
        return Ok(None);
    };
    // Swallow the blank separator that followed the entry.
    let mut end = end;
    while end < lines.len() && lines[end].trim().is_empty() {
        end += 1;
    }
    lines.drain(start..end);
    while lines
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        lines.pop();
    }
    if lines.is_empty() {
        return Ok(Some(String::new()));
    }
    Ok(Some(join_lines(&lines)))
}

fn value_is_empty_container(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn emit_yaml(value: &Value, indent: usize, out: &mut Vec<String>) -> Result<(), AppError> {
    let pad = " ".repeat(indent);
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                let key = format!("{pad}{}:", yaml_key(key));
                match item {
                    Value::Object(nested) if !nested.is_empty() => {
                        out.push(key);
                        emit_yaml(item, indent + INDENT_STEP, out)?;
                    }
                    Value::Array(items) if !items.is_empty() => {
                        out.push(key);
                        emit_yaml(item, indent + INDENT_STEP, out)?;
                    }
                    _ => out.push(format!("{key} {}", yaml_scalar(item))),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::Object(map) if !map.is_empty() => {
                        let mut first = true;
                        for (key, nested) in map {
                            let prefix = if first {
                                format!("{pad}- {}:", yaml_key(key))
                            } else {
                                format!("{pad}  {}:", yaml_key(key))
                            };
                            first = false;
                            match nested {
                                Value::Object(inner) if !inner.is_empty() => {
                                    out.push(prefix);
                                    emit_yaml(nested, indent + INDENT_STEP * 2, out)?;
                                }
                                Value::Array(inner) if !inner.is_empty() => {
                                    out.push(prefix);
                                    emit_yaml(nested, indent + INDENT_STEP * 2, out)?;
                                }
                                _ => out.push(format!("{prefix} {}", yaml_scalar(nested))),
                            }
                        }
                    }
                    Value::Array(nested) if !nested.is_empty() => {
                        out.push(format!("{pad}-"));
                        emit_yaml(item, indent + INDENT_STEP, out)?;
                    }
                    _ => out.push(format!("{pad}- {}", yaml_scalar(item))),
                }
            }
        }
        _ => out.push(format!("{pad}{}", yaml_scalar(value))),
    }
    Ok(())
}

fn yaml_key(key: &str) -> String {
    if key.is_empty() || !is_plain_scalar(key) {
        double_quoted(key)
    } else {
        key.to_string()
    }
}

fn yaml_scalar(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => yaml_string(text),
        _ => double_quoted(&value.to_string()),
    }
}

fn yaml_string(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".to_string();
    }
    if is_plain_scalar(text) && !looks_like_scalar_literal(text) {
        text.to_string()
    } else if text.contains('\n') || text.contains('\t') || text.contains('\\') {
        double_quoted(text)
    } else {
        format!("'{}'", text.replace('\'', "''"))
    }
}

fn looks_like_scalar_literal(text: &str) -> bool {
    matches!(
        text.to_ascii_lowercase().as_str(),
        "null" | "~" | "true" | "false" | "yes" | "no" | "on" | "off"
    ) || text.parse::<f64>().is_ok()
}

fn is_plain_scalar(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text.trim() != text {
        return false;
    }
    let first = text.chars().next().unwrap();
    if "!&*|>%@`\"'#,[]{}?:- ".contains(first) {
        // A leading `-` is legal when followed by a non-space, e.g. `-1`.
        let allowed_leading_dash = first == '-' && !text.starts_with("- ");
        let allowed_leading_question = first == '?' && !text.starts_with("? ");
        if !(allowed_leading_dash || allowed_leading_question) {
            return false;
        }
    }
    !text
        .chars()
        .any(|c| c.is_control() || c == '\n' || c == '\t')
        && !text.contains(": ")
        && !text.contains(" #")
        && !text.contains("'")
        && !text.ends_with(':')
        && !text.starts_with(' ')
}

fn double_quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{}\"", text.replace('"', "\\\"")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = "\
# Your patch layer for this dsh profile.
- id: ui-chat
  name: '@deepseek-ai/dsh-ui-chat'
  config:
    transcriptView: detailed
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      alpha:
        displayName: Alpha
        api: openai-completions
        baseURL: http://127.0.0.1:9999/v1
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: alpha
    model: fast
";

    #[test]
    fn reads_entries_without_touching_neighbours() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-read.yml");
        fs::write(&path, SAMPLE).unwrap();
        let entries = read_entries(&path).unwrap();
        assert!(entries.contains_key("ui-chat"));
        assert!(entries.contains_key("llm-pi-ai"));
        assert_eq!(
            entries["llm-pi-ai"]["providers"]["alpha"]["displayName"],
            json!("Alpha")
        );
        assert_eq!(entries["agent-default-model"]["provider"], json!("alpha"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rewrites_only_the_owned_subtree() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-write.yml");
        fs::write(&path, SAMPLE).unwrap();
        write_entry_config(
            &path,
            PI_AI_ENTRY_ID,
            PI_AI_ENTRY_NAME,
            &json!({
                "providers": {
                    "alpha": {
                        "displayName": "Alpha",
                        "api": "openai-completions",
                        "baseURL": "http://127.0.0.1:15721/dsh/alpha",
                        "models": [{ "id": "fast", "name": "Fast" }]
                    }
                }
            }),
        )
        .unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.starts_with("# Your patch layer for this dsh profile."));
        assert!(updated.contains("transcriptView: detailed"));
        assert!(updated.contains("http://127.0.0.1:15721/dsh/alpha"));
        assert!(updated.contains("provider: alpha"));
        let entries = read_entries(&path).unwrap();
        assert_eq!(
            entries[PI_AI_ENTRY_ID]["providers"]["alpha"]["baseURL"],
            json!("http://127.0.0.1:15721/dsh/alpha")
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn appends_missing_entry_to_bare_flow_sequence() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-append.yml");
        fs::write(&path, "# header\n[]\n").unwrap();
        write_entry_config(
            &path,
            DEFAULT_MODEL_ENTRY_ID,
            DEFAULT_MODEL_ENTRY_NAME,
            &json!({ "provider": "alpha", "model": "fast" }),
        )
        .unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("- id: agent-default-model"));
        assert!(updated.contains("  name: '@deepseek-ai/dsh-agent-default-model'"));
        let entries = read_entries(&path).unwrap();
        assert_eq!(entries[DEFAULT_MODEL_ENTRY_ID]["model"], json!("fast"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn appends_missing_entry_after_existing_ones() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-append2.yml");
        fs::write(&path, SAMPLE).unwrap();
        write_entry_config(
            &path,
            OFFICIAL_ENTRY_ID,
            OFFICIAL_ENTRY_NAME,
            &json!({ "apiKeyEnv": "DEEPSEEK_API_KEY", "baseURL": "https://api.deepseek.com" }),
        )
        .unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("- id: llm-deepseek"));
        let entries = read_entries(&path).unwrap();
        assert_eq!(
            entries[OFFICIAL_ENTRY_ID]["baseURL"],
            json!("https://api.deepseek.com")
        );
        assert!(entries.contains_key("llm-pi-ai"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn removes_entry_and_keeps_the_rest() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-remove.yml");
        fs::write(&path, SAMPLE).unwrap();
        assert!(remove_entry(&path, DEFAULT_MODEL_ENTRY_ID).unwrap());
        let updated = fs::read_to_string(&path).unwrap();
        assert!(!updated.contains("agent-default-model"));
        assert!(updated.contains("llm-pi-ai"));
        assert!(!remove_entry(&path, "nope").unwrap());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn quotes_scalars_that_would_change_meaning() {
        assert_eq!(yaml_string("openai-completions"), "openai-completions");
        assert_eq!(yaml_string("https://x.test/v1"), "https://x.test/v1");
        assert_eq!(yaml_string("true"), "'true'");
        assert_eq!(yaml_string("123"), "'123'");
        assert_eq!(yaml_string("a: b"), "'a: b'");
        assert_eq!(yaml_string("it's"), "'it''s'");
    }

    #[test]
    fn nested_models_round_trip() {
        let path = std::env::temp_dir().join("ccs-dsh-patch-models.yml");
        let _ = fs::remove_file(&path);
        write_entry_config(
            &path,
            PI_AI_ENTRY_ID,
            PI_AI_ENTRY_NAME,
            &json!({
                "providers": {
                    "beta": {
                        "displayName": "Beta",
                        "api": "anthropic-messages",
                        "models": [
                            { "id": "m1", "name": "M1", "input": ["text", "image"],
                              "reasoningEfforts": { "off": "none", "low": "low" } }
                        ]
                    }
                }
            }),
        )
        .unwrap();
        let entries = read_entries(&path).unwrap();
        assert_eq!(
            entries[PI_AI_ENTRY_ID]["providers"]["beta"]["models"][0]["reasoningEfforts"]["off"],
            json!("none")
        );
        let _ = fs::remove_file(&path);
    }
}
