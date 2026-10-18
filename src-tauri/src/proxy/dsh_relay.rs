//! DeepSeek Harness 中转：字节级透传
//!
//! DSH 各 provider 的 `baseURL` 被改写成本机的 `http://127.0.0.1:<port>/dsh/<provider_id>`，
//! 这里把 `<provider_id>` 换回原始上游地址，接上剩下的路径和查询串原样转发。
//!
//! 请求体和响应体一律不解析、不改写：DSH 的 token 用量来自上游响应体里的 `usage` 字段，
//! 任何改写（哪怕只是重新序列化 JSON）都可能让 DSH 的用量统计对不上。

use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::http_client;

/// 请求/响应体不超过这个值时整块读取，这样 `content-length` 能原样带给对端；超过的（以及
/// 长度未知的，比如 SSE）走流式转发。
const BUFFER_LIMIT: usize = 8 * 1024 * 1024;

/// 单次请求的总超时。共享客户端默认 600s，长对话的流式响应可能更久，这里放宽到 1 小时。
const RELAY_TIMEOUT: Duration = Duration::from_secs(3600);

/// `GET|POST /dsh/<provider_id>[/<path>]`：把请求原样转给该 provider 的原始上游地址。
pub async fn handle_dsh_relay(uri: Uri, request: Request) -> Response {
    let Some((provider_id, tail)) = split_relay_path(uri.path()) else {
        return error_json(
            StatusCode::BAD_REQUEST,
            "dsh_relay_bad_path",
            "DSH 中转路径无效",
        );
    };

    let Some(target) = crate::services::dsh_relay::relay_target(provider_id) else {
        return error_json(
            StatusCode::NOT_FOUND,
            "dsh_relay_unknown_provider",
            format!("DSH 供应商 `{provider_id}` 未接管，找不到原始地址"),
        );
    };
    if crate::services::dsh_relay::is_relay_url(&target.base_url) {
        return error_json(
            StatusCode::BAD_GATEWAY,
            "dsh_relay_loop",
            format!("DSH 供应商 `{provider_id}` 的地址仍指向本机中转，无法转发"),
        );
    }

    let url = join_target_url(&target.base_url, tail, uri.query());
    let method = request.method().clone();
    let (parts, body) = request.into_parts();

    let mut headers = sanitize_request_headers(&parts.headers);
    inject_auth(
        &mut headers,
        target.api.as_deref(),
        target.api_key.as_deref(),
    );

    // 长度已知且不大的请求体整块发，保证上行 content-length 精确；其余流式转发（DSH 的
    // 请求体都是 JSON，通常远小于上限）。
    let request_body = match declared_content_length(&parts.headers) {
        Some(length) if length <= BUFFER_LIMIT => {
            match axum::body::to_bytes(body, BUFFER_LIMIT).await {
                Ok(bytes) => reqwest::Body::from(bytes),
                Err(error) => {
                    log::warn!("[DSH-Relay] 读取请求体失败: {error}");
                    return error_json(StatusCode::BAD_REQUEST, "dsh_relay_body", "读取请求体失败");
                }
            }
        }
        _ => reqwest::Body::wrap_stream(body.into_data_stream()),
    };

    let client = http_client::get_for_url(&url);
    let upstream = match client
        .request(method.clone(), &url)
        .headers(headers)
        .body(request_body)
        .timeout(RELAY_TIMEOUT)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            log::warn!(
                "[DSH-Relay] {} {} -> {} 失败: {error}",
                method,
                provider_id,
                loggable_url(&url)
            );
            return error_json(
                StatusCode::BAD_GATEWAY,
                "dsh_relay_upstream_error",
                format!("转发到上游失败: {error}"),
            );
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response_headers = sanitize_response_headers(upstream.headers());
    let response_body = match upstream.content_length() {
        Some(length) if length <= BUFFER_LIMIT as u64 => match upstream.bytes().await {
            Ok(bytes) => {
                if let Ok(value) = HeaderValue::from_str(&bytes.len().to_string()) {
                    response_headers.insert(header::CONTENT_LENGTH, value);
                }
                Body::from(bytes)
            }
            Err(error) => {
                log::warn!("[DSH-Relay] 读取上游响应体失败: {error}");
                return error_json(
                    StatusCode::BAD_GATEWAY,
                    "dsh_relay_upstream_body",
                    format!("读取上游响应失败: {error}"),
                );
            }
        },
        _ => Body::from_stream(upstream.bytes_stream()),
    };

    let mut response = Response::new(response_body);
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

/// 从 `/dsh/<provider_id>/<rest>` 里切出 id 和剩余路径。手写切分而不是用 `Path` 提取器：
/// 剩余路径要按原样（含百分号编码）拼回上游 URL，不能被解码。
fn split_relay_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/dsh/")?;
    if rest.is_empty() {
        return None;
    }
    match rest.split_once('/') {
        Some((id, tail)) => (!id.is_empty()).then_some((id, tail)),
        None => Some((rest, "")),
    }
}

/// 原始地址 + 剩余路径 + 原始查询串。只补一个斜杠，其余字节不动。
fn join_target_url(base_url: &str, tail: &str, query: Option<&str>) -> String {
    let mut url = base_url.trim_end_matches('/').to_string();
    let tail = tail.trim_start_matches('/');
    if !tail.is_empty() {
        url.push('/');
        url.push_str(tail);
    }
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    url
}

/// 逐跳头只对单条连接有意义，不能往下游传。
fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// 转发给上游的请求头：去掉逐跳头、`host`（换了目标主机）和 `content-length`（由 reqwest
/// 按实际 body 重新算，避免重复分帧）。其余一律原样保留，含 `authorization`、`x-api-key`、
/// `anthropic-*`、`accept-encoding`（共享客户端关掉了自动解压，压缩字节会原样透传）。
fn sanitize_request_headers(headers: &HeaderMap) -> HeaderMap {
    let mut sanitized = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if is_hop_by_hop(name) || name == header::HOST || name == header::CONTENT_LENGTH {
            continue;
        }
        sanitized.append(name.clone(), value.clone());
    }
    sanitized
}

/// 回给客户端的响应头：同样去掉逐跳头和 `content-length`（长度由本进程重新决定）。
fn sanitize_response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut sanitized = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if is_hop_by_hop(name) || name == header::CONTENT_LENGTH {
            continue;
        }
        sanitized.append(name.clone(), value.clone());
    }
    sanitized
}

/// 兜底补认证：只有客户端一个认证头都没带时才补。正常情况 DSH 自己会带，这里主要防
/// 某些 provider 把 key 放在 CCS 侧（`apiKeyEnv` 指向的凭据）而客户端没带的情况。
fn inject_auth(headers: &mut HeaderMap, api: Option<&str>, api_key: Option<&str>) {
    let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) else {
        return;
    };
    let already_authenticated = headers.contains_key(header::AUTHORIZATION)
        || headers.contains_key("x-api-key")
        || headers.contains_key("x-goog-api-key");
    if already_authenticated {
        return;
    }

    let api = api.unwrap_or("").to_ascii_lowercase();
    if api.contains("anthropic") {
        if let Ok(value) = HeaderValue::from_str(api_key) {
            headers.insert("x-api-key", value);
        }
        if !headers.contains_key("anthropic-version") {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    } else if let Ok(value) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
        headers.insert(header::AUTHORIZATION, value);
    }
}

fn declared_content_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// 日志里去掉查询串：部分 provider（如 Gemini）把 key 放在 query 里。
fn loggable_url(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}

fn error_json(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    let payload = json!({
        "error": {
            "message": message.into(),
            "type": code,
            "code": code,
        }
    });
    (status, axum::Json(payload)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_target_url_keeping_path_and_query() {
        assert_eq!(
            join_target_url("https://api.deepseek.com", "v1/chat/completions", None),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_target_url("https://api.deepseek.com/", "/v1/chat/completions", None),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_target_url(
                "https://example.com/anthropic",
                "v1/messages",
                Some("beta=1")
            ),
            "https://example.com/anthropic/v1/messages?beta=1"
        );
        // 百分号编码原样保留
        assert_eq!(
            join_target_url("https://example.com", "v1/a%2Fb", Some("q=%E4%B8%AD")),
            "https://example.com/v1/a%2Fb?q=%E4%B8%AD"
        );
        // 没有剩余路径时就是原始地址本身
        assert_eq!(
            join_target_url("https://example.com/v1", "", None),
            "https://example.com/v1"
        );
        assert_eq!(
            join_target_url("https://example.com/", "", Some("x=1")),
            "https://example.com?x=1"
        );
    }

    #[test]
    fn splits_relay_path_without_decoding() {
        assert_eq!(
            split_relay_path("/dsh/deepseek-official/v1/messages"),
            Some(("deepseek-official", "v1/messages"))
        );
        assert_eq!(split_relay_path("/dsh/pi/"), Some(("pi", "")));
        assert_eq!(split_relay_path("/dsh/pi"), Some(("pi", "")));
        assert_eq!(
            split_relay_path("/dsh/pi/v1/a%2Fb"),
            Some(("pi", "v1/a%2Fb"))
        );
        assert_eq!(split_relay_path("/dsh/"), None);
        assert_eq!(split_relay_path("/v1/messages"), None);
    }

    #[test]
    fn sanitizes_request_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:15721"));
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("42"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer sk-test"),
        );
        headers.insert("x-api-key", HeaderValue::from_static("sk-anthropic"));
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("prompt-caching-2024-07-31"),
        );
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let sanitized = sanitize_request_headers(&headers);
        assert!(!sanitized.contains_key(header::HOST));
        assert!(!sanitized.contains_key(header::CONTENT_LENGTH));
        assert!(!sanitized.contains_key(header::CONNECTION));
        assert!(!sanitized.contains_key("transfer-encoding"));
        assert_eq!(
            sanitized.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-test"
        );
        assert_eq!(sanitized.get("x-api-key").unwrap(), "sk-anthropic");
        assert_eq!(
            sanitized.get("anthropic-beta").unwrap(),
            "prompt-caching-2024-07-31"
        );
        assert_eq!(sanitized.get(header::ACCEPT_ENCODING).unwrap(), "gzip");
        assert_eq!(
            sanitized.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }

    #[test]
    fn injects_auth_only_when_missing() {
        let mut headers = HeaderMap::new();
        inject_auth(&mut headers, Some("openai-completions"), Some("sk-openai"));
        assert_eq!(
            headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-openai"
        );

        let mut anthropic = HeaderMap::new();
        inject_auth(&mut anthropic, Some("anthropic-messages"), Some("sk-ant"));
        assert_eq!(anthropic.get("x-api-key").unwrap(), "sk-ant");
        assert_eq!(anthropic.get("anthropic-version").unwrap(), "2023-06-01");
        assert!(!anthropic.contains_key(header::AUTHORIZATION));

        // 客户端已带认证头时不动
        let mut present = HeaderMap::new();
        present.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer client"),
        );
        inject_auth(&mut present, Some("anthropic-messages"), Some("sk-ant"));
        assert_eq!(present.get(header::AUTHORIZATION).unwrap(), "Bearer client");
        assert!(!present.contains_key("x-api-key"));

        // 没有 key 时什么都不加
        let mut empty = HeaderMap::new();
        inject_auth(&mut empty, Some("openai-completions"), None);
        assert!(empty.is_empty());
    }

    #[test]
    fn hides_query_in_logs() {
        assert_eq!(
            loggable_url("https://example.com/v1?key=secret"),
            "https://example.com/v1"
        );
    }
}
