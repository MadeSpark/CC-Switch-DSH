//! Import DeepSeek Harness token usage from its session logs.
//!
//! DeepSeek Harness keeps one append-only log per session:
//!
//! ```text
//! $DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd
//! ```
//!
//! The file is not a single zstd stream: every flush appends an independent
//! frame, so a decoder has to walk all of them (the `zstd` crate's default
//! `Decoder` does exactly that, unlike `ZSTD_decompress` on a whole buffer).
//! Each decoded line is one `{type, seq, time, data}` record; token usage lives
//! in two record kinds:
//!
//! * `assistant/message` — `data.usage` plus `data.message.source.{provider,model}`
//! * `compaction/summary` — `data.usage` plus top-level `data.{provider,model}`
//!
//! `usage.inputTokens` counts only *fresh* prompt tokens (cache hits are
//! reported separately as `cacheReadTokens`), which matches the
//! [`INPUT_TOKEN_SEMANTICS_FRESH`] semantics used by the proxy path.
//!
//! ## 数据流
//! ```text
//! $DSH_HOME/sessions/**/session.v4.jsonl.zstd
//!   → 多帧 zstd 解码 → 逐行 JSON → usage 提取 → 去重 → 费用计算
//!   → proxy_request_logs 表 (app_type = 'dsh', data_source = 'dsh_session')
//! ```

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::params;
use rust_decimal::Decimal;
use serde_json::Value;

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::{calculator::CostCalculator, parser::TokenUsage};
use crate::services::session_usage::{
    load_sync_cursors, metadata_modified_nanos, update_sync_state_on_conn, SessionSyncResult,
};
use crate::services::sql_helpers::INPUT_TOKEN_SEMANTICS_FRESH;
use crate::services::usage_stats::find_model_pricing;

/// `app_type` of imported Harness usage rows.
const APP_TYPE: &str = "dsh";
/// `data_source` marker distinguishing imported rows from proxy rows.
const DATA_SOURCE: &str = "dsh_session";
/// Placeholder provider id; Harness routes do not have CC Switch provider rows.
const PROVIDER_PLACEHOLDER: &str = "_dsh_session";
/// Log file name inside each session directory.
const SESSION_FILE_NAME: &str = "session.v4.jsonl.zstd";
/// Session root relative to `$DSH_HOME`.
const SESSIONS_DIR_NAME: &str = "sessions";
/// Upper bound on how many log files one pass may read.
const MAX_FILES_PER_SYNC: usize = 512;

/// Sync DeepSeek Harness session logs into `proxy_request_logs`.
pub fn sync_dsh_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let root = crate::deepseek_harness_config::get_dsh_home().join(SESSIONS_DIR_NAME);
    sync_dsh_sessions(db, &root)
}

/// [`sync_dsh_usage`] rooted at an explicit sessions directory (test seam).
pub fn sync_dsh_sessions(
    db: &Database,
    sessions_root: &Path,
) -> Result<SessionSyncResult, AppError> {
    if !sessions_root.is_dir() {
        return Ok(SessionSyncResult::default());
    }
    let files = collect_session_files(sessions_root);
    if files.is_empty() {
        return Ok(SessionSyncResult::default());
    }
    let cursors = load_sync_cursors(db)?;
    sync_files(db, &files, &cursors)
}

fn collect_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file()
                && entry.file_name().to_string_lossy() == SESSION_FILE_NAME
            {
                files.push(entry.path());
            }
            if files.len() >= MAX_FILES_PER_SYNC {
                return files;
            }
        }
    }
    files.sort();
    files
}

/// One imported usage record, normalised across the two record kinds.
struct DshUsageRecord {
    record_id: String,
    session_id: String,
    provider: Option<String>,
    model: String,
    timestamp_ms: i64,
    usage: TokenUsage,
}

fn sync_files(
    db: &Database,
    files: &[PathBuf],
    cursors: &HashMap<String, crate::services::session_usage::SyncCursor>,
) -> Result<SessionSyncResult, AppError> {
    let mut result = SessionSyncResult::default();
    let mut conn = lock_conn!(db.conn);
    let tx = conn.transaction()?;

    for path in files {
        result.files_scanned = result.files_scanned.saturating_add(1);
        let Ok(metadata) = fs::metadata(path) else {
            result
                .errors
                .push(format!("无法读取会话文件元数据: {}", path.display()));
            continue;
        };
        let size = metadata.len().min(i64::MAX as u64) as i64;
        let modified = metadata_modified_nanos(&metadata);
        let key = path.to_string_lossy().to_string();
        if let Some(cursor) = cursors.get(&key) {
            // Append-only log: identical size and mtime means nothing new.
            if cursor.last_line_offset == size && cursor.last_modified == modified {
                result.skipped = result.skipped.saturating_add(1);
                continue;
            }
        }
        let session_id = session_id_of(path);
        let records = match read_records(path, &session_id) {
            Ok(records) => records,
            Err(error) => {
                result.errors.push(error);
                continue;
            }
        };
        for record in &records {
            if !record.usage.has_billable_tokens() {
                continue;
            }
            let changed = insert_record(&tx, record)?;
            if changed {
                result.imported = result.imported.saturating_add(1);
            } else {
                result.suspected_duplicates = result.suspected_duplicates.saturating_add(1);
            }
        }
        update_sync_state_on_conn(&tx, &key, modified, size)?;
    }

    tx.commit()?;
    Ok(result)
}

fn session_id_of(path: &Path) -> String {
    path.parent()
        .and_then(|dir| dir.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Decode every zstd frame of `path` and extract usage records.
fn read_records(path: &Path, session_id: &str) -> Result<Vec<DshUsageRecord>, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(bytes.as_slice())
        .map_err(|error| format!("{} 不是有效的 zstd 数据: {error}", path.display()))?;
    let mut decoded = Vec::new();
    decoder
        .read_to_end(&mut decoded)
        .map_err(|error| format!("解码 {} 失败: {error}", path.display()))?;
    let text = String::from_utf8_lossy(&decoded);
    let mut records = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(record) = parse_usage_record(&record, session_id) {
            records.push(record);
        }
    }
    Ok(records)
}

fn parse_usage_record(record: &Value, session_id: &str) -> Option<DshUsageRecord> {
    let kind = record.get("type")?.as_str()?;
    let data = record.get("data")?;
    let usage = parse_usage(data.get("usage")?)?;
    let timestamp_ms = record
        .get("time")
        .and_then(Value::as_i64)
        .or_else(|| data.get("time").and_then(Value::as_i64))
        .unwrap_or_default();

    let (record_id, provider, model) = match kind {
        "assistant/message" => {
            let message = data.get("message")?;
            let source = message.get("source");
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| record.get("seq").and_then(Value::as_i64).map(|_| "seq"))?;
            let id = match id {
                "seq" => format!(
                    "seq-{}",
                    record
                        .get("seq")
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                ),
                other => other.to_string(),
            };
            (
                id,
                source
                    .and_then(|source| source.get("provider"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source
                    .and_then(|source| source.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        }
        "compaction/summary" => {
            let id = data
                .get("compactionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    record
                        .get("seq")
                        .and_then(Value::as_i64)
                        .map(|seq| format!("seq-{seq}"))
                })?;
            (
                id,
                data.get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                data.get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        }
        _ => return None,
    };

    let provider = provider.filter(|value| !value.trim().is_empty())?;
    let model = model.filter(|value| !value.trim().is_empty())?;
    Some(DshUsageRecord {
        record_id: format!("dsh:{session_id}:{record_id}"),
        session_id: session_id.to_string(),
        provider: Some(provider),
        model,
        timestamp_ms,
        usage,
    })
}

fn parse_usage(usage: &Value) -> Option<TokenUsage> {
    let number = |key: &str| {
        usage
            .get(key)
            .and_then(Value::as_u64)
            .map(|value| value.min(u32::MAX as u64) as u32)
            .unwrap_or(0)
    };
    Some(TokenUsage {
        input_tokens: number("inputTokens"),
        output_tokens: number("outputTokens"),
        cache_read_tokens: number("cacheReadTokens"),
        cache_creation_tokens: number("cacheWriteTokens"),
        cache_creation_1h_tokens: 0,
        model: usage
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        message_id: None,
    })
}

/// Insert one usage row; returns `false` when the request id was already known.
fn insert_record(conn: &rusqlite::Connection, record: &DshUsageRecord) -> Result<bool, AppError> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM proxy_request_logs WHERE request_id = ?1 AND data_source = ?2",
            params![record.record_id, DATA_SOURCE],
            |_| Ok(()),
        )
        .is_ok();
    if exists {
        return Ok(false);
    }
    let pricing = find_model_pricing(conn, &record.model);
    let cost = pricing.as_ref().map(|pricing| {
        CostCalculator::calculate_for_app(APP_TYPE, &record.usage, pricing, Decimal::ONE)
    });
    let total_cost = cost
        .as_ref()
        .map(|cost| cost.total_cost.to_string())
        .unwrap_or_else(|| "0".into());
    let input_cost = cost
        .as_ref()
        .map(|cost| cost.input_cost.to_string())
        .unwrap_or_else(|| "0".into());
    let output_cost = cost
        .as_ref()
        .map(|cost| cost.output_cost.to_string())
        .unwrap_or_else(|| "0".into());
    let cache_read_cost = cost
        .as_ref()
        .map(|cost| cost.cache_read_cost.to_string())
        .unwrap_or_else(|| "0".into());
    let cache_creation_cost = cost
        .as_ref()
        .map(|cost| cost.cache_creation_cost.to_string())
        .unwrap_or_else(|| "0".into());

    let provider_type = record
        .provider
        .clone()
        .unwrap_or_else(|| DATA_SOURCE.into());
    let changed = conn.execute(
        "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
            total_cost_usd, latency_ms, status_code, session_id, provider_type,
            is_streaming, cost_multiplier, created_at, data_source, input_token_semantics
         ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8,
                   ?9, ?10, ?11, ?12, ?13, 0, 200, ?14, ?15,
                   1, '1', ?16, ?17, ?18)",
        params![
            record.record_id,
            PROVIDER_PLACEHOLDER,
            APP_TYPE,
            record.model,
            record.usage.input_tokens,
            record.usage.output_tokens,
            record.usage.cache_read_tokens,
            record.usage.cache_creation_tokens,
            input_cost,
            output_cost,
            cache_read_cost,
            cache_creation_cost,
            total_cost,
            record.session_id,
            provider_type,
            created_at_seconds(record.timestamp_ms),
            DATA_SOURCE,
            INPUT_TOKEN_SEMANTICS_FRESH,
        ],
    )?;
    Ok(changed > 0)
}

fn created_at_seconds(timestamp_ms: i64) -> i64 {
    if timestamp_ms > 0 {
        timestamp_ms / 1000
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_frame(file: &mut fs::File, lines: &[String]) {
        let payload = lines.join("\n") + "\n";
        let compressed = zstd::stream::encode_all(payload.as_bytes(), 3).unwrap();
        file.write_all(&compressed).unwrap();
    }

    fn message_line(
        seq: i64,
        id: &str,
        model: &str,
        input: u64,
        output: u64,
        cache: u64,
    ) -> String {
        format!(
            r#"{{"type":"assistant/message","seq":{seq},"time":1792248955528,"data":{{"usage":{{"inputTokens":{input},"outputTokens":{output},"totalTokens":{},"cacheReadTokens":{cache}}},"message":{{"role":"assistant","id":"{id}","source":{{"kind":"model","provider":"tx","model":"{model}"}}}}}}}}"#,
            input + output + cache
        )
    }

    fn compaction_line(seq: i64, id: &str, model: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"compaction/summary","seq":{seq},"time":1792248955528,"data":{{"compactionId":"{id}","provider":"tx","model":"{model}","usage":{{"inputTokens":{input},"outputTokens":{output},"totalTokens":{}}}}}}}"#,
            input + output
        )
    }

    fn session_dir(root: &Path, name: &str) -> PathBuf {
        let dir = root.join("--tmp-project--").join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn totals(db: &Database) -> (i64, i64, i64, i64) {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0)
             FROM proxy_request_logs WHERE app_type = 'dsh' AND data_source = 'dsh_session'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    #[test]
    fn imports_usage_from_every_zstd_frame_once() -> Result<(), AppError> {
        let dir = std::env::temp_dir().join("ccs-dsh-usage-frames");
        let _ = fs::remove_dir_all(&dir);
        let session = session_dir(&dir, "session-aaa");
        let path = session.join(SESSION_FILE_NAME);
        let mut file = fs::File::create(&path).unwrap();
        // Two independent frames, i.e. the shape DSH produces after two flushes.
        write_frame(
            &mut file,
            &[
                message_line(17, "m-1", "deepseek-v4.1-flash", 14856, 185, 0),
                message_line(27, "m-2", "deepseek-v4.1-flash", 159, 150, 14976),
            ],
        );
        write_frame(
            &mut file,
            &[compaction_line(
                40,
                "c-1",
                "deepseek-v4.1-flash",
                16697,
                1945,
            )],
        );
        file.flush().unwrap();
        drop(file);

        let db = Database::memory()?;
        let first = sync_dsh_sessions(&db, &dir)?;
        assert_eq!(first.imported, 3);
        assert_eq!(first.files_scanned, 1);
        assert_eq!(
            totals(&db),
            (3, 14856 + 159 + 16697, 185 + 150 + 1945, 14976)
        );

        // Second pass: same size + mtime, so the file is skipped entirely.
        let second = sync_dsh_sessions(&db, &dir)?;
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(
            totals(&db),
            (3, 14856 + 159 + 16697, 185 + 150 + 1945, 14976)
        );
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn appending_a_frame_only_imports_the_new_records() -> Result<(), AppError> {
        let dir = std::env::temp_dir().join("ccs-dsh-usage-append");
        let _ = fs::remove_dir_all(&dir);
        let session = session_dir(&dir, "session-bbb");
        let path = session.join(SESSION_FILE_NAME);
        let mut file = fs::File::create(&path).unwrap();
        write_frame(&mut file, &[message_line(5, "m-a", "glm-5.3", 100, 20, 0)]);
        file.flush().unwrap();
        drop(file);

        let db = Database::memory()?;
        assert_eq!(sync_dsh_sessions(&db, &dir)?.imported, 1);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write_frame(
            &mut file,
            &[
                message_line(9, "m-b", "glm-5.3", 200, 30, 50),
                // Duplicate of an already imported record: must be ignored.
                message_line(5, "m-a", "glm-5.3", 100, 20, 0),
            ],
        );
        file.flush().unwrap();
        drop(file);

        let appended = sync_dsh_sessions(&db, &dir)?;
        assert_eq!(appended.imported, 1);
        assert_eq!(totals(&db), (2, 300, 50, 50));
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn ignores_records_without_billable_tokens() -> Result<(), AppError> {
        let dir = std::env::temp_dir().join("ccs-dsh-usage-empty");
        let _ = fs::remove_dir_all(&dir);
        let session = session_dir(&dir, "session-ccc");
        let path = session.join(SESSION_FILE_NAME);
        let mut file = fs::File::create(&path).unwrap();
        write_frame(
            &mut file,
            &[
                message_line(1, "m-zero", "unknown", 0, 0, 0),
                r#"{"type":"assistant/message","seq":3,"time":1792248955528,"data":{"usage":{"inputTokens":10,"outputTokens":2},"message":{"id":"missing-provider","source":{"model":"unknown"}}}}"#.to_string(),
                r#"{"type":"compaction/summary","seq":4,"time":1792248955528,"data":{"compactionId":"missing-model","provider":"tx","usage":{"inputTokens":10,"outputTokens":2}}}"#.to_string(),
                r#"{"type":"turn/start","seq":2,"time":1792248955528,"data":{}}"#.to_string(),
            ],
        );
        file.flush().unwrap();
        drop(file);

        let db = Database::memory()?;
        let result = sync_dsh_sessions(&db, &dir)?;
        assert_eq!(result.imported, 0);
        assert_eq!(totals(&db).0, 0);
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    #[ignore = "requires the local DeepSeek Harness session corpus"]
    fn imports_real_dsh_sessions_and_reports_totals() -> Result<(), AppError> {
        let root = PathBuf::from(r"C:\Users\MadeSpark\.dsh\sessions");
        if !root.is_dir() {
            eprintln!("real DSH session root is unavailable: {}", root.display());
            return Ok(());
        }
        let started = std::time::Instant::now();
        let db = Database::memory()?;
        let result = sync_dsh_sessions(&db, &root)?;
        let (rows, input, output, cache_read) = totals(&db);
        let (cost_usd, cache_creation) = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT COALESCE(SUM(total_cost_usd), '0'), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM proxy_request_logs WHERE app_type = 'dsh' AND data_source = 'dsh_session'",
                [],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, i64>(1)?)),
            )?
        };
        let mut samples = Vec::new();
        'files: for path in collect_session_files(&root) {
            let session_id = session_id_of(&path);
            let bytes = fs::read(&path).unwrap();
            let mut decoder = zstd::stream::read::Decoder::new(bytes.as_slice()).unwrap();
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).unwrap();
            for line in String::from_utf8_lossy(&decoded).lines() {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(parsed) = parse_usage_record(&value, &session_id) else {
                    continue;
                };
                if !parsed.usage.has_billable_tokens() {
                    continue;
                }
                let Some(raw_usage) = value.pointer("/data/usage") else {
                    continue;
                };
                samples.push((parsed.record_id, raw_usage.clone()));
                if samples.len() == 3 {
                    break 'files;
                }
            }
        }
        {
            let conn = db.conn.lock().unwrap();
            for (request_id, raw_usage) in &samples {
                let row = conn.query_row(
                    "SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
                     FROM proxy_request_logs WHERE request_id = ?1",
                    [request_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                eprintln!(
                    "sample usage: request_id={}, raw={}, db={{input_tokens:{}, output_tokens:{}, cache_read_tokens:{}, cache_creation_tokens:{}}}",
                    request_id,
                    raw_usage,
                    row.0,
                    row.1,
                    row.2,
                    row.3
                );
            }
        }
        eprintln!(
            "real DSH import: files={}, imported={}, skipped={}, duplicates={}, errors={}, rows={}, cost_usd={}, input={}, output={}, cacheRead={}, cacheWrite={}, elapsed_ms={}",
            result.files_scanned,
            result.imported,
            result.skipped,
            result.suspected_duplicates,
            result.errors.len(),
            rows,
            cost_usd,
            input,
            output,
            cache_read,
            cache_creation,
            started.elapsed().as_millis()
        );
        assert!(
            result.imported > 0,
            "real corpus should contain billable usage"
        );
        assert!(
            result.errors.is_empty(),
            "real corpus errors: {:?}",
            result.errors
        );
        Ok(())
    }

    #[test]
    fn corrupt_frame_is_reported_without_aborting_other_files() -> Result<(), AppError> {
        let dir = std::env::temp_dir().join("ccs-dsh-usage-corrupt");
        let _ = fs::remove_dir_all(&dir);
        let valid = session_dir(&dir, "session-valid");
        let valid_path = valid.join(SESSION_FILE_NAME);
        let mut valid_file = fs::File::create(&valid_path).unwrap();
        write_frame(
            &mut valid_file,
            &[message_line(1, "valid", "glm-5.3", 100, 20, 0)],
        );
        valid_file.flush().unwrap();
        drop(valid_file);

        let corrupt = session_dir(&dir, "session-corrupt");
        fs::write(corrupt.join(SESSION_FILE_NAME), b"not a zstd frame").unwrap();

        let db = Database::memory()?;
        let result = sync_dsh_sessions(&db, &dir)?;
        assert_eq!(result.imported, 1);
        assert_eq!(result.files_scanned, 2);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(totals(&db).0, 1);
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn missing_sessions_root_is_not_an_error() -> Result<(), AppError> {
        let db = Database::memory()?;
        let result = sync_dsh_sessions(&db, Path::new("Z:/definitely/not/there"))?;
        assert_eq!(result.imported, 0);
        Ok(())
    }
}
