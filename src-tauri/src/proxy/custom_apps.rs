//! 自定义应用聚合路由：仅暴露 OpenAI Models 与 Chat Completions。

use super::{
    handler_config::OPENAI_PARSER_CONFIG, handler_context::RequestContext,
    hyper_client::send_request, response_processor::process_response, server::ProxyState,
};
use crate::app_config::AppType;
use crate::services::custom_apps::{
    list_custom_app_models, resolve_model_route, CustomApp, CustomModelRoute,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::str::FromStr;
use std::time::{Duration, Instant};

const CUSTOM_TAG: &str = "Custom App";

fn api_error(
    status: StatusCode,
    message: impl Into<String>,
    error_type: &str,
    param: Option<&str>,
    code: &str,
) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message.into(),
                "type": error_type,
                "param": param,
                "code": code,
            }
        })),
    )
        .into_response()
}

fn extract_header_key(headers: &HeaderMap) -> Option<&str> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let bearer = authorization.and_then(|value| {
        let (scheme, token) = value.split_once(' ')?;
        scheme
            .eq_ignore_ascii_case("bearer")
            .then_some(token.trim())
            .filter(|token| !token.is_empty())
    });
    bearer.or_else(|| {
        headers
            .get(HeaderName::from_static("x-api-key"))
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|token| !token.is_empty())
    })
}

fn authenticate(
    state: &ProxyState,
    app_id: &str,
    headers: &HeaderMap,
) -> Result<CustomApp, Response> {
    let Some(api_key) = extract_header_key(headers) else {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Missing API key. Use Authorization: Bearer <key> or X-API-Key.",
            "authentication_error",
            None,
            "invalid_api_key",
        ));
    };
    let app = state
        .db
        .get_custom_app_by_api_key(api_key)
        .map_err(|e| {
            log::warn!("[custom-apps] API key lookup failed: {e}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to authenticate custom app",
                "server_error",
                None,
                "internal_error",
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::UNAUTHORIZED,
                "Invalid API key.",
                "authentication_error",
                None,
                "invalid_api_key",
            )
        })?;
    if app.id != app_id {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "API key does not belong to this custom app.",
            "authentication_error",
            None,
            "invalid_api_key",
        ));
    }
    Ok(app)
}

fn static_app_type(app_type: &AppType) -> &'static str {
    match app_type {
        AppType::Claude => "claude",
        AppType::ClaudeDesktop => "claude-desktop",
        AppType::Codex => "codex",
        AppType::Gemini => "gemini",
        AppType::GrokBuild => "grokbuild",
        AppType::OpenCode => "opencode",
        AppType::OpenClaw => "openclaw",
        AppType::Hermes => "hermes",
        AppType::Pi => "pi",
        AppType::DeepSeekHarness => "deepseek-harness",
        AppType::Mcode => "mcode",
    }
}

/// OpenAI Chat Completions URL 规则。
pub(crate) fn custom_chat_completions_url(base_url: &str) -> Option<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return None;
    }
    let lower = base_url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if lower.ends_with("/chat/completions") {
        Some(base_url.to_string())
    } else if lower.ends_with("/v1") || lower.ends_with("/v1beta") {
        Some(format!("{base_url}/chat/completions"))
    } else {
        Some(format!("{base_url}/v1/chat/completions"))
    }
}

fn load_route(state: &ProxyState, requested_model: &str) -> Result<CustomModelRoute, Response> {
    let models = list_custom_app_models(&state.db).map_err(|e| {
        log::warn!("[custom-apps] model aggregation failed: {e}");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load custom app models",
            "server_error",
            None,
            "internal_error",
        )
    })?;
    let route = resolve_model_route(&models, requested_model).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            format!("Model '{requested_model}' not found."),
            "invalid_request_error",
            Some("model"),
            "model_not_found",
        )
    })?;
    Ok(route)
}

/// GET /custom/:app_id/v1/models
pub async fn handle_custom_app_models(
    State(state): State<ProxyState>,
    Path(app_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let app = match authenticate(&state, &app_id, &headers) {
        Ok(app) => app,
        Err(response) => return response,
    };
    let models = match list_custom_app_models(&state.db) {
        Ok(models) => models,
        Err(error) => {
            log::warn!("[custom-apps] model list failed: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load custom app models",
                "server_error",
                None,
                "internal_error",
            );
        }
    };
    let created = app.created_at / 1000;
    let data: Vec<Value> = models
        .into_iter()
        .map(|model| {
            json!({
                "id": model.id,
                "object": "model",
                "created": created,
                "owned_by": model.provider_name,
            })
        })
        .collect();
    (
        StatusCode::OK,
        Json(json!({"object": "list", "data": data})),
    )
        .into_response()
}

/// POST /custom/:app_id/v1/chat/completions
pub async fn handle_custom_app_chat_completions(
    State(state): State<ProxyState>,
    Path(app_id): Path<String>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Response {
    if let Err(response) = authenticate(&state, &app_id, &headers) {
        return response;
    }

    let body_bytes = match request.into_body().collect().await {
        Ok(body) => body.to_bytes(),
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!("Failed to read request body: {error}"),
                "invalid_request_error",
                None,
                "invalid_request",
            );
        }
    };
    let mut body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(body) => body,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!("Invalid JSON body: {error}"),
                "invalid_request_error",
                None,
                "invalid_json",
            );
        }
    };
    let Some(requested_model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
    else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Field 'model' is required.",
            "invalid_request_error",
            Some("model"),
            "invalid_request",
        );
    };

    let route = match load_route(&state, &requested_model) {
        Ok(route) => route,
        Err(response) => return response,
    };
    let app_type = match AppType::from_str(&route.model.app_type) {
        Ok(app_type) => app_type,
        Err(error) => {
            log::warn!(
                "[custom-apps] invalid app_type '{}': {error}",
                route.model.app_type
            );
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Selected provider has an unsupported app type",
                "server_error",
                None,
                "internal_error",
            );
        }
    };
    let provider = match state
        .db
        .get_provider_by_id(&route.model.provider_id, &route.model.app_type)
    {
        Ok(Some(provider)) => provider,
        Ok(None) => {
            return api_error(
                StatusCode::NOT_FOUND,
                format!("Model '{requested_model}' not found."),
                "invalid_request_error",
                Some("model"),
                "model_not_found",
            );
        }
        Err(error) => {
            log::warn!("[custom-apps] provider lookup failed: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load selected provider",
                "server_error",
                None,
                "internal_error",
            );
        }
    };
    let (base_url, api_key) = provider.resolve_usage_credentials(&app_type);
    let Some(upstream_url) = custom_chat_completions_url(&base_url) else {
        return api_error(
            StatusCode::BAD_GATEWAY,
            "Selected provider has no valid base URL.",
            "upstream_error",
            None,
            "invalid_base_url",
        );
    };
    let upstream_uri: http::Uri = match upstream_url.parse() {
        Ok(uri) => uri,
        Err(error) => {
            return api_error(
                StatusCode::BAD_GATEWAY,
                format!("Selected provider base URL is invalid: {error}"),
                "upstream_error",
                None,
                "invalid_base_url",
            );
        }
    };

    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    body["model"] = Value::String(route.upstream_model.clone());
    let upstream_body = match serde_json::to_vec(&body) {
        Ok(body) => body,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!("Failed to encode request body: {error}"),
                "invalid_request_error",
                None,
                "invalid_request",
            );
        }
    };

    let mut upstream_headers = HeaderMap::new();
    upstream_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if is_stream {
            "text/event-stream"
        } else {
            "application/json"
        });
    if let Ok(value) = HeaderValue::from_str(accept) {
        upstream_headers.insert(header::ACCEPT, value);
    }
    if let Some(user_agent) = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| HeaderValue::from_str(value).ok())
    {
        upstream_headers.insert(header::USER_AGENT, user_agent);
    }
    if !api_key.trim().is_empty() {
        match HeaderValue::from_str(&format!("Bearer {}", api_key.trim())) {
            Ok(value) => {
                upstream_headers.insert(header::AUTHORIZATION, value);
            }
            Err(error) => {
                return api_error(
                    StatusCode::BAD_GATEWAY,
                    format!("Provider API key is invalid: {error}"),
                    "upstream_error",
                    None,
                    "invalid_provider_key",
                );
            }
        }
    }

    let mut ctx = match RequestContext::for_custom_app(
        &state,
        &body,
        &headers,
        app_type.clone(),
        provider,
        requested_model.clone(),
        route.upstream_model.clone(),
        app_id.clone(),
        CUSTOM_TAG,
        static_app_type(&app_type),
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(error) => {
            log::warn!("[custom-apps] request context failed: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to prepare custom app request",
                "server_error",
                None,
                "internal_error",
            );
        }
    };
    ctx.outbound_model = Some(route.upstream_model.clone());

    let timeout_secs = state.config.read().await.non_streaming_timeout.max(1);
    let proxy_url = super::http_client::get_current_proxy_url();
    let started = Instant::now();
    let upstream = match send_request(
        upstream_uri,
        "custom-app upstream",
        Method::POST,
        upstream_headers,
        http::Extensions::new(),
        upstream_body,
        Duration::from_secs(timeout_secs),
        proxy_url.as_deref(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            log::warn!(
                "[custom-apps] upstream request failed after {}ms: {error}",
                started.elapsed().as_millis()
            );
            return api_error(
                StatusCode::BAD_GATEWAY,
                format!("Upstream request failed: {error}"),
                "upstream_error",
                None,
                "upstream_error",
            );
        }
    };

    match process_response(
        upstream,
        &ctx,
        &state,
        &OPENAI_PARSER_CONFIG,
        is_stream,
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[custom-apps] response processing failed: {error}");
            api_error(
                StatusCode::BAD_GATEWAY,
                format!("Upstream response failed: {error}"),
                "upstream_error",
                None,
                "upstream_error",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Provider;
    use crate::proxy::server::ProxyServer;
    use crate::proxy::types::ProxyConfig;
    use axum::routing::post;
    use axum::Router;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        authorization: Option<String>,
        body: Value,
    }

    async fn mocked_upstream(
        State(captured): State<Arc<Mutex<Vec<CapturedRequest>>>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        captured.lock().await.push(CapturedRequest {
            authorization: headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            body: body.clone(),
        });
        Json(json!({
            "id": "chatcmpl-custom-test",
            "object": "chat.completion",
            "created": 1,
            "model": body.get("model").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 3,
                "total_tokens": 15
            }
        }))
    }

    async fn start_upstream() -> (
        String,
        Arc<Mutex<Vec<CapturedRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/chat/completions", post(mocked_upstream))
            .with_state(captured.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock upstream addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve mock upstream");
        });
        (format!("http://{addr}/v1"), captured, handle)
    }

    #[test]
    fn chat_url_follows_contract() {
        assert_eq!(
            custom_chat_completions_url("https://api.example.com").as_deref(),
            Some("https://api.example.com/v1/chat/completions")
        );
        assert_eq!(
            custom_chat_completions_url("https://api.example.com/v1/").as_deref(),
            Some("https://api.example.com/v1/chat/completions")
        );
        assert_eq!(
            custom_chat_completions_url("https://api.example.com/v1beta").as_deref(),
            Some("https://api.example.com/v1beta/chat/completions")
        );
        assert_eq!(
            custom_chat_completions_url("https://api.example.com/v1/chat/completions").as_deref(),
            Some("https://api.example.com/v1/chat/completions")
        );
        assert_eq!(custom_chat_completions_url("   "), None);
        assert_eq!(custom_chat_completions_url("file:///tmp/api"), None);
    }

    #[tokio::test]
    async fn endpoints_authenticate_route_exactly_and_write_custom_usage() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (upstream_base, captured, upstream_handle) = start_upstream().await;
        let db = Arc::new(crate::database::Database::memory().expect("memory database"));
        let app = db
            .create_custom_app("Bot", "openai", None)
            .expect("create custom app");

        let settings = json!({
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": upstream_base,
                "apiKey": "provider-secret"
            },
            "models": {
                "gpt-test": {}
            }
        });
        let provider = Provider::with_id(
            "mock-provider".to_string(),
            "Mock Provider".to_string(),
            settings,
            None,
        );
        db.save_provider("opencode", &provider)
            .expect("save provider");

        // 同一个上游模型出现在两个 provider 时，外部 id 精确决定走哪一家；
        // 第二个 provider 的地址故意不可用，只有精确选中第一个才能成功。
        let decoy = Provider::with_id(
            "decoy-provider".to_string(),
            "Decoy Provider".to_string(),
            json!({
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": "http://127.0.0.1:1/v1",
                    "apiKey": "decoy-secret"
                },
                "models": {
                    "gpt-test": {}
                }
            }),
            None,
        );
        db.save_provider("opencode", &decoy)
            .expect("save decoy provider");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let info = proxy.start().await.expect("start proxy");
        let base = format!("http://127.0.0.1:{}", info.port);
        let client = reqwest::Client::new();
        let models_path = format!("/custom/{}/v1/models", app.id);
        let chat_path = format!("/custom/{}/v1/chat/completions", app.id);

        let no_auth = client
            .get(format!("{base}{models_path}"))
            .send()
            .await
            .expect("no auth request");
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);

        let wrong_key = client
            .get(format!("{base}{models_path}"))
            .bearer_auth("ccs_wrong")
            .send()
            .await
            .expect("wrong key request");
        assert_eq!(wrong_key.status(), StatusCode::UNAUTHORIZED);

        let other_app = db
            .create_custom_app("Other", "openai", None)
            .expect("create other app");
        let wrong_app = client
            .get(format!("{base}/custom/{}/v1/models", other_app.id))
            .bearer_auth(&app.api_key)
            .send()
            .await
            .expect("key for wrong app");
        assert_eq!(wrong_app.status(), StatusCode::UNAUTHORIZED);

        let models = client
            .get(format!("{base}{models_path}"))
            .header("x-api-key", &app.api_key)
            .send()
            .await
            .expect("models request");
        assert_eq!(models.status(), StatusCode::OK);
        let models_body: Value = models.json().await.expect("models json");
        assert_eq!(models_body["object"], "list");
        let model_ids: Vec<&str> = models_body["data"]
            .as_array()
            .expect("models data array")
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect();
        assert!(model_ids.contains(&"gpt-test-mock-provider"));
        assert!(model_ids.contains(&"gpt-test-decoy-provider"));

        let other_path = client
            .get(format!("{base}/custom/{}/v1/responses", app.id))
            .bearer_auth(&app.api_key)
            .send()
            .await
            .expect("unsupported custom path");
        assert_eq!(other_path.status(), StatusCode::NOT_FOUND);

        let missing_model = client
            .post(format!("{base}{chat_path}"))
            .bearer_auth(&app.api_key)
            .json(&json!({"model": "not-found", "messages": []}))
            .send()
            .await
            .expect("missing model request");
        assert_eq!(missing_model.status(), StatusCode::NOT_FOUND);
        let missing_body: Value = missing_model.json().await.expect("missing model json");
        assert_eq!(missing_body["error"]["code"], "model_not_found");

        let response = client
            .post(format!("{base}{chat_path}"))
            .bearer_auth(&app.api_key)
            .json(&json!({
                "model": "gpt-test-mock-provider",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": false
            }))
            .send()
            .await
            .expect("chat request");
        assert_eq!(response.status(), StatusCode::OK);
        let response_body: Value = response.json().await.expect("chat json");
        assert_eq!(response_body["choices"][0]["message"]["content"], "ok");

        let captured = captured.lock().await.clone();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].body["model"], "gpt-test");
        assert_eq!(
            captured[0].authorization.as_deref(),
            Some("Bearer provider-secret")
        );

        let mut usage = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let conn = db.conn.lock().expect("usage db lock");
            usage = conn
                .query_row(
                    "SELECT app_type, provider_id, model, request_model
                     FROM proxy_request_logs LIMIT 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .ok();
            if usage.is_some() {
                break;
            }
        }
        let (app_type, provider_id, model, request_model) = usage.expect("custom usage row");
        assert_eq!(app_type, app.id);
        assert_eq!(provider_id, "mock-provider");
        assert_eq!(model, "gpt-test");
        assert_eq!(request_model, "gpt-test-mock-provider");

        proxy.stop().await.expect("stop proxy");
        upstream_handle.abort();
    }
}
