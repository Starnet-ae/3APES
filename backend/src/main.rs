use argon2::{password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString}, Argon2};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{get, post}, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions}, SqlitePool};
use std::{env, path::Path as FilePath, sync::Arc, time::{Duration, Instant}};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

type ApiError = (StatusCode, Json<Value>);
type ApiResult<T> = Result<Json<T>, ApiError>;

fn fail(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error": message})))
}
fn internal(e: impl std::fmt::Display) -> ApiError {
    eprintln!("internal error: {e}");
    fail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
fn now() -> i64 { chrono::Utc::now().timestamp() }
fn id() -> String { Uuid::new_v4().to_string() }
fn random_secret(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{}{}", prefix, URL_SAFE_NO_PAD.encode(bytes))
}
fn hash(s: &str) -> String { format!("{:x}", Sha256::digest(s.as_bytes())) }

#[derive(Clone)]
struct Settings {
    small: String,
    medium: String,
    large: String,
    llm_base_url: String,
    llm_key: String,
    signup_enabled: bool,
    resend_api_key: String,
    mail_from: String,
    app_public_url: String,
}
#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    client: reqwest::Client,
    cfg: Arc<Settings>,
    models_cache: Arc<tokio::sync::RwLock<Option<(Instant, Vec<Model>)>>>,
}
#[derive(Deserialize)]
struct Credentials { email: String, password: String }
#[derive(Serialize)]
struct AuthReply { token: String, email: String }
#[derive(Serialize, sqlx::FromRow)]
struct Chat { id: String, title: String, created_at: i64 }
#[derive(Serialize, sqlx::FromRow)]
struct Message { id: String, role: String, content: String, model: Option<String>, created_at: i64 }
#[derive(Serialize)]
struct ChatDetail { chat: Chat, messages: Vec<Message> }
#[derive(Deserialize)]
struct ChatInput { title: Option<String> }
#[derive(Deserialize)]
struct SendInput { content: String, #[serde(default)] model: Option<String>, #[serde(default)] tier: Option<String> }
#[derive(Clone, Serialize)]
struct Model {
    id: String,
    name: String,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct EmailInput { email: String }
#[derive(Deserialize)]
struct PasswordResetInput { token: String, password: String }
#[derive(Serialize, sqlx::FromRow)]
struct ApiKeyRow { id: String, label: String, prefix: String, created_at: i64, last_used_at: Option<i64> }
#[derive(Deserialize)]
struct KeyInput { label: String }
#[derive(Serialize)]
struct KeyCreated { id: String, key: String }

async fn auth(state: &AppState, headers: &HeaderMap) -> Result<String, ApiError> {
    let token = headers.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Sign in first"))?;
    let token_hash = hash(token);
    if token.starts_with("ss_") {
        let user: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?"
        ).bind(token_hash).bind(now()).fetch_optional(&state.db).await.map_err(internal)?;
        return user.ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Session expired"));
    }
    if token.starts_with("3a_") {
        let user: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM api_keys WHERE key_hash=?"
        ).bind(&token_hash).fetch_optional(&state.db).await.map_err(internal)?;
        if user.is_some() {
            sqlx::query("UPDATE api_keys SET last_used_at=? WHERE key_hash=?")
                .bind(now()).bind(token_hash).execute(&state.db).await.map_err(internal)?;
        }
        return user.ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Invalid API key"));
    }
    Err(fail(StatusCode::UNAUTHORIZED, "Invalid credential"))
}

async fn register(State(s): State<AppState>, Json(input): Json<Credentials>) -> ApiResult<Value> {
    if !s.cfg.signup_enabled { return Err(fail(StatusCode::FORBIDDEN, "Registration is disabled")); }
    let email = input.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 || input.password.len() < 12 || input.password.len() > 128 {
        return Err(fail(StatusCode::BAD_REQUEST, "Enter a valid email and password of 12–128 characters"));
    }
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default().hash_password(input.password.as_bytes(), &salt)
        .map_err(internal)?.to_string();
    let result = sqlx::query("INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)")
        .bind(id()).bind(&email).bind(password_hash).bind(now()).execute(&s.db).await;
    match result {
        Ok(_) => Ok(Json(json!({"created": true}))),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(fail(StatusCode::CONFLICT, "Email already exists")),
        Err(e) => Err(internal(e)),
    }
}
async fn login(State(s): State<AppState>, Json(input): Json<Credentials>) -> ApiResult<AuthReply> {
    let email = input.email.trim().to_lowercase();
    let row: Option<(String, String)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE email=?")
        .bind(&email).fetch_optional(&s.db).await.map_err(internal)?;
    let (user_id, password_hash) = row.ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Invalid credentials"))?;
    let parsed = PasswordHash::new(&password_hash).map_err(internal)?;
    Argon2::default().verify_password(input.password.as_bytes(), &parsed)
        .map_err(|_| fail(StatusCode::UNAUTHORIZED, "Invalid credentials"))?;
    let token = random_secret("ss_");
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
        .bind(hash(&token)).bind(user_id).bind(now() + 12*60*60)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(AuthReply { token, email }))
}
async fn me(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    let user_id = auth(&s, &headers).await?;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=?")
        .bind(user_id).fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({"email": email})))
}
async fn logout(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    auth(&s, &headers).await?;
    if let Some(t) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|s| s.strip_prefix("Bearer ")) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?").bind(hash(t))
            .execute(&s.db).await.map_err(internal)?;
    }
    Ok(Json(json!({"ok": true})))
}
// Fetch the provider's complete live model catalog, never a hardcoded list.
// Cache briefly to avoid burdening Phala and to keep selection consistent.
fn model_num(item: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = item.get(key)?;
        value.as_u64().or_else(|| value.as_str()?.parse::<u64>().ok())
    })
}
fn parse_provider_models(value: &Value) -> Result<Vec<Model>, ApiError> {
    let entries = value.get("data").or_else(|| value.get("models")).unwrap_or(value)
        .as_array().ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "Invalid provider model catalog"))?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let Some(model_id) = entry.get("id").and_then(Value::as_str) else { continue; };
        if model_id.is_empty() || model_id.len() > 256 || !seen.insert(model_id.to_string()) { continue; }
        let name = entry.get("name").and_then(Value::as_str).filter(|x| !x.is_empty())
            .unwrap_or(model_id).to_string();
        result.push(Model {
            id: model_id.into(), name,
            context_window: model_num(entry, &["context_window", "context_length", "context_window_length"]),
            max_output_tokens: model_num(entry, &["max_output_length", "max_output_tokens", "max_completion_tokens"]),
        });
    }
    result.sort_by(|a,b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if result.is_empty() { return Err(fail(StatusCode::BAD_GATEWAY, "Provider returned no usable models")); }
    Ok(result)
}
async fn provider_models(s: &AppState) -> Result<Vec<Model>, ApiError> {
    {
        let cache = s.models_cache.read().await;
        if let Some((when, data)) = cache.as_ref() {
            if when.elapsed() < Duration::from_secs(300) { return Ok(data.clone()); }
        }
    }
    if s.cfg.llm_base_url.is_empty() { return Err(fail(StatusCode::SERVICE_UNAVAILABLE,"LLM_BASE_URL not configured")); }
    let url = format!("{}/models", s.cfg.llm_base_url.trim_end_matches('/'));
    let mut request = s.client.get(url);
    if !s.cfg.llm_key.is_empty() { request = request.bearer_auth(&s.cfg.llm_key); }
    let response = request.send().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "Unable to load provider models"))?;
    if !response.status().is_success() {
        eprintln!("Model catalog request failed with HTTP {}", response.status());
        return Err(fail(StatusCode::BAD_GATEWAY, "Unable to load provider models"));
    }
    let raw: Value = response.json().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "Invalid provider model response"))?;
    let models = parse_provider_models(&raw)?;
    *s.models_cache.write().await = Some((Instant::now(), models.clone()));
    Ok(models)
}
async fn models(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    auth(&s, &headers).await?;
    let models = provider_models(&s).await?;
    Ok(Json(json!({"models": models, "attestation": "not_verified", "billing":"not_configured"})))
}

// Mail credentials stay inside the router CVM. The reset token is never logged or stored in plaintext.
async fn forgot_password(State(s): State<AppState>, Json(input): Json<EmailInput>) -> ApiResult<Value> {
    if s.cfg.resend_api_key.is_empty() || s.cfg.mail_from.is_empty() || s.cfg.app_public_url.is_empty() {
        return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "Password recovery is not configured"));
    }
    let email = input.email.trim().to_lowercase();
    let generic = json!({"message":"If this email has an account, a password reset link will be sent."});
    if email.len() > 254 || !email.contains('@') { return Ok(Json(generic)); }
    // Atomic, per-email request throttle, even when the address does not exist.
    let cutoff = now() - 300;
    sqlx::query("DELETE FROM password_reset_limits WHERE last_requested_at < ?")
        .bind(now() - 86400).execute(&s.db).await.map_err(internal)?;
    let allowed = sqlx::query("INSERT INTO password_reset_limits(identity_hash,last_requested_at) VALUES (?,?) ON CONFLICT(identity_hash) DO UPDATE SET last_requested_at=excluded.last_requested_at WHERE last_requested_at < ?")
        .bind(hash(&email)).bind(now()).bind(cutoff).execute(&s.db).await.map_err(internal)?.rows_affected() > 0;
    if !allowed { return Ok(Json(generic)); }
    let user_id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email=?")
        .bind(&email).fetch_optional(&s.db).await.map_err(internal)?;
    if let Some(user_id) = user_id {
        let token = random_secret("pr_");
        let token_hash = hash(&token);
        sqlx::query("DELETE FROM password_resets WHERE user_id=? OR expires_at<=?")
            .bind(&user_id).bind(now()).execute(&s.db).await.map_err(internal)?;
        sqlx::query("INSERT INTO password_resets(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)")
            .bind(&token_hash).bind(&user_id).bind(now() + 20*60).bind(now())
            .execute(&s.db).await.map_err(internal)?;
        let mut url = match reqwest::Url::parse(&s.cfg.app_public_url) {
            Ok(x) if x.scheme() == "https" || (x.scheme()=="http" && x.host_str()==Some("localhost")) => x,
            _ => return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "Password recovery URL is misconfigured")),
        };
        url.set_fragment(Some(&format!("/reset-password?token={token}")));
        let link = url.to_string();
        // Send asynchronously so request timing does not reveal whether an email has an account.
        tokio::spawn(async move {
            let result = s.client.post("https://api.resend.com/emails")
                .bearer_auth(&s.cfg.resend_api_key)
                .header("User-Agent", "3apes-router/1.0")
                .json(&json!({"from":s.cfg.mail_from,"to":[email],"subject":"Reset your 3apes password",
                    "text":format!("Use this link to reset your 3apes password (valid for 20 minutes):\n\n{link}\n\nIf you did not request this, ignore the message."),
                    "html":format!("<p>You requested a password reset for 3apes.</p><p><a href=\"{link}\">Reset your password</a></p><p>This link expires in 20 minutes. If you didn't request it, ignore this email.</p>") }))
                .send().await;
            match result {
                Ok(res) if res.status().is_success() => {},
                other => {
                    // Do not expose whether the address exists, nor the link itself.
                    match other { Ok(res)=> eprintln!("Reset email service rejected request: HTTP {}",res.status()), Err(_)=>eprintln!("Reset email service unreachable") }
                    let _ = sqlx::query("DELETE FROM password_resets WHERE token_hash=?")
                        .bind(token_hash).execute(&s.db).await;
                }
            }
        });
    }
    Ok(Json(generic))
}
async fn reset_password(State(s): State<AppState>, Json(input): Json<PasswordResetInput>) -> ApiResult<Value> {
    if input.password.len() < 12 || input.password.len() > 128 {
        return Err(fail(StatusCode::BAD_REQUEST, "Password must contain 12–128 characters"));
    }
    if !input.token.starts_with("pr_") || input.token.len() > 128 {
        return Err(fail(StatusCode::BAD_REQUEST, "Invalid or expired reset link"));
    }
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default().hash_password(input.password.as_bytes(), &salt)
        .map_err(internal)?.to_string();
    let mut tx = s.db.begin().await.map_err(internal)?;
    let consumed: Option<String> = sqlx::query_scalar("DELETE FROM password_resets WHERE token_hash=? AND expires_at>? RETURNING user_id")
        .bind(hash(&input.token)).bind(now()).fetch_optional(&mut *tx).await.map_err(internal)?;
    let user_id = consumed.ok_or_else(|| fail(StatusCode::BAD_REQUEST, "Invalid or expired reset link"))?;
    sqlx::query("UPDATE users SET password_hash=? WHERE id=?")
        .bind(password_hash).bind(&user_id).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM sessions WHERE user_id=?").bind(&user_id).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM password_resets WHERE user_id=?").bind(&user_id).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}

async fn chats(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Vec<Chat>> {
    let user = auth(&s, &headers).await?;
    let list = sqlx::query_as::<_, Chat>("SELECT id,title,created_at FROM chats WHERE user_id=? ORDER BY created_at DESC")
        .bind(user).fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(list))
}
async fn new_chat(State(s): State<AppState>, headers: HeaderMap, Json(input): Json<ChatInput>) -> ApiResult<Chat> {
    let user = auth(&s, &headers).await?;
    let title = input.title.unwrap_or_else(|| "New chat".to_string());
    let title = title.trim().chars().take(90).collect::<String>();
    let chat = Chat { id: id(), title: if title.is_empty() { "New chat".into() } else { title }, created_at: now() };
    sqlx::query("INSERT INTO chats(id,user_id,title,created_at) VALUES (?,?,?,?)")
        .bind(&chat.id).bind(user).bind(&chat.title).bind(chat.created_at)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(chat))
}
async fn chat_detail(State(s): State<AppState>, headers: HeaderMap, Path(chat_id): Path<String>) -> ApiResult<ChatDetail> {
    let user = auth(&s, &headers).await?;
    let chat = sqlx::query_as::<_, Chat>("SELECT id,title,created_at FROM chats WHERE id=? AND user_id=?")
        .bind(&chat_id).bind(user).fetch_optional(&s.db).await.map_err(internal)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Chat not found"))?;
    let messages = sqlx::query_as::<_, Message>("SELECT id,role,content,model,created_at FROM messages WHERE chat_id=? ORDER BY rowid")
        .bind(chat_id).fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(ChatDetail { chat, messages }))
}
async fn delete_chat(State(s): State<AppState>, headers: HeaderMap, Path(chat_id): Path<String>) -> ApiResult<Value> {
    let user = auth(&s, &headers).await?;
    sqlx::query("DELETE FROM chats WHERE id=? AND user_id=?").bind(chat_id).bind(user)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({"ok": true})))
}
fn choose_model(s: &Settings, tier: &str, prompt: &str) -> Result<String, ApiError> {
    let chosen = match tier {
        "small" => &s.small, "medium" => &s.medium, "large" => &s.large,
        "auto" => {
            if prompt.len() < 140 && !s.small.is_empty() { &s.small }
            else if !s.medium.is_empty() { &s.medium }
            else if !s.large.is_empty() { &s.large }
            else { &s.small }
        },
        _ => return Err(fail(StatusCode::BAD_REQUEST, "Unknown model tier")),
    };
    if chosen.is_empty() { return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "Model tier not configured")); }
    Ok(chosen.clone())
}

// OpenAI-compatible streaming endpoint. The remote inference provider must be
// configured separately; ordinary HTTPS alone does NOT verify its TEE status.
async fn send_message(State(s): State<AppState>, headers: HeaderMap, Path(chat_id): Path<String>, Json(input): Json<SendInput>) -> Result<Response, ApiError> {
    let user = auth(&s, &headers).await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM chats WHERE id=? AND user_id=?")
        .bind(&chat_id).bind(user).fetch_optional(&s.db).await.map_err(internal)?;
    if exists.is_none() { return Err(fail(StatusCode::NOT_FOUND, "Chat not found")); }
    let content = input.content.trim();
    if content.is_empty() || content.len() > 32_000 { return Err(fail(StatusCode::BAD_REQUEST, "Prompt must be 1–32000 bytes")); }
    let model = if let Some(selected) = input.model.as_deref() {
        let available = provider_models(&s).await?;
        if !available.iter().any(|m| m.id == selected) {
            return Err(fail(StatusCode::BAD_REQUEST, "Selected model is no longer in the provider catalog"));
        }
        selected.to_string()
    } else {
        // Backward-compatible legacy tier input for existing API test scripts.
        let tier = input.tier.as_deref().unwrap_or("medium");
        choose_model(&s.cfg, tier, content)?
    };

    if s.cfg.llm_base_url.is_empty() {
        return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "LLM_BASE_URL not configured"));
    }
    let history: Vec<(String, String)> = sqlx::query_as("SELECT role,content FROM (SELECT role,content,rowid FROM messages WHERE chat_id=? ORDER BY rowid DESC LIMIT 50) ORDER BY rowid ASC")
        .bind(&chat_id).fetch_all(&s.db).await.map_err(internal)?;
    let mut messages: Vec<Value> = history.into_iter().map(|(role, content)| json!({"role":role,"content":content})).collect();
    messages.push(json!({"role":"user","content":content}));

    let url = format!("{}/chat/completions", s.cfg.llm_base_url.trim_end_matches('/'));
    let mut request = s.client.post(url).json(&json!({"model":model,"messages":messages,"stream":true}));
    if !s.cfg.llm_key.is_empty() { request = request.bearer_auth(&s.cfg.llm_key); }
    let upstream = request.send().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "LLM provider unavailable"))?;
    if !upstream.status().is_success() {
        return Err(fail(StatusCode::BAD_GATEWAY, "LLM provider rejected the request"));
    }
    sqlx::query("INSERT INTO messages(id,chat_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)")
        .bind(id()).bind(&chat_id).bind("user").bind(content).bind(None::<String>).bind(now())
        .execute(&s.db).await.map_err(internal)?;

    let stream = async_stream::stream! {
        yield Ok::<Event, std::convert::Infallible>(Event::default().event("meta").json_data(json!({"model": model})).unwrap());
        let mut body = upstream.bytes_stream();
        let mut pending: Vec<u8> = Vec::new();
        let mut assistant = String::new();
        let mut received_done = false;
        let mut failed = false;
        'outer: while let Some(piece) = body.next().await {
            let bytes = match piece {
                Ok(data) => data,
                Err(_) => { failed = true; break; }
            };
            pending.extend_from_slice(&bytes);
            if pending.len() > 1_000_000 { failed = true; break; }
            while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = pending.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" { received_done = true; break 'outer; }
                let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(token) = chunk.pointer("/choices/0/delta/content").and_then(|v| v.as_str()) {
                    assistant.push_str(token);
                    if assistant.len() > 200_000 { failed = true; break 'outer; }
                    yield Ok(Event::default().event("token").json_data(json!({"text":token})).unwrap());
                }
            }
        }
        if failed || !received_done {
            yield Ok(Event::default().event("error").json_data(json!({"error":"Inference stream interrupted"})).unwrap());
        } else {
            let saved = sqlx::query("INSERT INTO messages(id,chat_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)")
                .bind(id()).bind(&chat_id).bind("assistant").bind(&assistant).bind(&model).bind(now())
                .execute(&s.db).await;
            match saved {
                Ok(_) => yield Ok(Event::default().event("done").json_data(json!({"model":model})).unwrap()),
                Err(_) => yield Ok(Event::default().event("error").json_data(json!({"error":"Could not persist response"})).unwrap()),
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

async fn list_keys(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Vec<ApiKeyRow>> {
    let user = auth(&s, &headers).await?;
    let keys = sqlx::query_as::<_, ApiKeyRow>("SELECT id,label,prefix,created_at,last_used_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC")
        .bind(user).fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(keys))
}
async fn create_key(State(s): State<AppState>, headers: HeaderMap, Json(input): Json<KeyInput>) -> ApiResult<KeyCreated> {
    let user = auth(&s, &headers).await?;
    let label = input.label.trim();
    if label.is_empty() || label.len() > 80 { return Err(fail(StatusCode::BAD_REQUEST, "Invalid key label")); }
    let key = random_secret("3a_");
    let key_id = id();
    sqlx::query("INSERT INTO api_keys(id,user_id,label,prefix,key_hash,created_at) VALUES (?,?,?,?,?,?)")
        .bind(&key_id).bind(user).bind(label).bind(&key[..12]).bind(hash(&key)).bind(now())
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(KeyCreated { id: key_id, key }))
}
async fn revoke_key(State(s): State<AppState>, headers: HeaderMap, Path(key_id): Path<String>) -> ApiResult<Value> {
    let user = auth(&s, &headers).await?;
    sqlx::query("DELETE FROM api_keys WHERE id=? AND user_id=?")
        .bind(key_id).bind(user).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({"ok": true})))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = env::var("SQLITE_PATH").unwrap_or_else(|_| "./data/3apes.db".into());
    if let Some(parent) = FilePath::new(&db_path).parent() { std::fs::create_dir_all(parent)?; }
    let db = SqlitePoolOptions::new().max_connections(5).connect_with(
        SqliteConnectOptions::new().filename(&db_path).create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal).busy_timeout(Duration::from_secs(5))
            .foreign_keys(true)
    ).await?;
    sqlx::migrate!().run(&db).await?;
    let cfg = Settings {
        small: env::var("MODEL_SMALL_ID").unwrap_or_default(),
        medium: env::var("MODEL_MEDIUM_ID").unwrap_or_default(),
        large: env::var("MODEL_LARGE_ID").unwrap_or_default(),
        llm_base_url: env::var("LLM_BASE_URL").unwrap_or_default(),
        llm_key: env::var("LLM_API_KEY").unwrap_or_default(),
        signup_enabled: env::var("SIGNUP_ENABLED").unwrap_or_default() == "true",
        resend_api_key: env::var("RESEND_API_KEY").unwrap_or_default(),
        mail_from: env::var("MAIL_FROM").unwrap_or_default(),
        app_public_url: env::var("APP_PUBLIC_URL").unwrap_or_default(),
    };
    // Never silently claim remote attestation merely because the process runs in Phala.
    let origin = env::var("PUBLIC_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());
    let cors = CorsLayer::new().allow_origin(origin.parse::<HeaderValue>()?)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let state = AppState {
        db, cfg: Arc::new(cfg),
        client: reqwest::Client::builder().timeout(Duration::from_secs(180)).build()?,
        models_cache: Arc::new(tokio::sync::RwLock::new(None)),
    };
    let app = Router::new()
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/forgot-password", post(forgot_password))
        .route("/api/auth/reset-password", post(reset_password))
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", post(logout))
        .route("/api/models", get(models))
        .route("/api/chats", get(chats).post(new_chat))
        .route("/api/chats/{chat_id}", get(chat_detail).delete(delete_chat))
        .route("/api/chats/{chat_id}/messages", post(send_message))
        .route("/api/keys", get(list_keys).post(create_key))
        .route("/api/keys/{key_id}", axum::routing::delete(revoke_key))
        .layer(cors).with_state(state);
    let host = env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&host).await?;
    println!("3apes API listening on {host}");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auto_router_uses_configured_tier() {
        let settings = Settings {
            small: "small-model".into(), medium: "medium-model".into(),
            large: "large-model".into(), llm_base_url: String::new(),
            llm_key: String::new(), signup_enabled: false,
            resend_api_key: String::new(), mail_from: String::new(), app_public_url: String::new(),
        };
        assert_eq!(choose_model(&settings, "auto", "hi").unwrap(), "small-model");
        assert_eq!(choose_model(&settings, "medium", "hi").unwrap(), "medium-model");
        assert!(choose_model(&settings, "bogus", "hi").is_err());
    }
    #[test]
    fn high_entropy_secrets_are_unique() {
        let a = random_secret("ss_");
        let b = random_secret("ss_");
        assert_ne!(a, b);
        assert_ne!(hash(&a), hash(&b));
    }
}
