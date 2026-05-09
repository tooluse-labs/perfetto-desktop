use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::header::{AUTHORIZATION, HOST, ORIGIN};
use http::{HeaderMap, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

// TODO: thread DEFAULT_PORT through user settings before Phase D.
const DEFAULT_PORT: u16 = 38471;
const MCP_PATH: &str = "/mcp";
// 1 MiB cap on incoming MCP request bodies. JSON-RPC envelopes are far smaller;
// query results stream out via response side, where Phase B SQL caps live.
const MAX_BODY_BYTES: usize = 1024 * 1024;

type ResponseBody = Full<Bytes>;

#[derive(Clone, Default)]
pub struct AgentBridgeState {
    inner: Arc<Mutex<BridgeInner>>,
}

#[derive(Default)]
struct BridgeInner {
    mode: BridgeMode,
    fallback_port: bool,
    session: Option<Arc<SessionConfig>>,
    pending_client: Option<ClientInfo>,
    connected_client: Option<ClientInfo>,
    trace_context: Option<TraceContext>,
    shutdown: Option<oneshot::Sender<()>>,
    last_error: Option<String>,
    last_method: Option<String>,
}

/// Per-session immutable configuration. Built once at `enable` /
/// `regenerate_session` and shared by reference so the request hot path can
/// read host/auth/command fields without rebuilding strings or holding the
/// bridge mutex across a request.
struct SessionConfig {
    port: u16,
    endpoint: String,
    expected_authorization: String,
    allowed_hosts: [String; 2],
    claude_command: String,
    codex_command: String,
    session_id: String,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
enum BridgeMode {
    #[default]
    Disabled,
    Starting,
    Listening,
    PendingAuthorization,
    Connected,
    // Reserved for the design §5.2 fatal-error state. Bind failures currently
    // roll back to Disabled; this variant lights up when wave 2 introduces a
    // listener-lost-mid-flight or panic recovery path.
    #[allow(dead_code)]
    Error,
}

impl BridgeMode {
    fn as_str(self) -> &'static str {
        match self {
            BridgeMode::Disabled => "Disabled",
            BridgeMode::Starting => "Starting",
            BridgeMode::Listening => "Listening",
            BridgeMode::PendingAuthorization => "Pending Authorization",
            BridgeMode::Connected => "Connected",
            BridgeMode::Error => "Error",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    client_id: String,
    name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceContext {
    title: String,
    url: String,
    start: String,
    end: String,
    unix_offset: String,
    timezone_offset_minutes: i32,
    import_errors: u32,
    trace_types: Vec<String>,
    has_ftrace: bool,
    uuid: String,
    cached: bool,
    downloadable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeSnapshot {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    fallback_port: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_client: Option<ClientInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected_client: Option<ClientInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_command: Option<String>,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

pub fn commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        agent_bridge_status,
        agent_bridge_enable,
        agent_bridge_disable,
        agent_bridge_allow_pending,
        agent_bridge_deny_pending,
        agent_bridge_revoke_connected,
        agent_bridge_regenerate_session,
        agent_bridge_set_trace_context,
    ]
}

#[tauri::command]
pub fn agent_bridge_status(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    snapshot(&state)
}

#[tauri::command]
pub async fn agent_bridge_enable(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    let bridge = state.inner().inner.clone();

    // Atomic claim: only proceed if currently Disabled. Concurrent Enables
    // serialize behind this lock; the loser gets the in-flight snapshot and
    // skips a second bind.
    {
        let mut inner = bridge
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        if inner.mode != BridgeMode::Disabled {
            return snapshot_inner(&inner);
        }
        inner.mode = BridgeMode::Starting;
        inner.last_error = None;
        inner.last_method = None;
    }

    let bind_outcome = bind_listener().await;
    let (listener, fallback_port, bind_warning) = match bind_outcome {
        Ok((listener, fallback, warning)) => (listener, fallback, warning),
        Err(err) => {
            // Roll back to Disabled so the user can retry; surface the cause.
            let mut inner = bridge
                .lock()
                .map_err(|_| "agent bridge state lock poisoned".to_string())?;
            inner.mode = BridgeMode::Disabled;
            inner.last_error = Some(err.clone());
            return Err(err);
        }
    };

    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            let mut inner = bridge
                .lock()
                .map_err(|_| "agent bridge state lock poisoned".to_string())?;
            inner.mode = BridgeMode::Disabled;
            let msg = format!("failed to read listener address: {err}");
            inner.last_error = Some(msg.clone());
            return Err(msg);
        }
    };
    let session = Arc::new(SessionConfig::new(port));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    {
        let mut inner = bridge
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        // The user can click Disable while bind_listener was awaiting; if so
        // the state was reset and we must drop the freshly-bound listener
        // instead of resurrecting it as Listening.
        if inner.mode != BridgeMode::Starting {
            drop(listener);
            return snapshot_inner(&inner);
        }
        inner.mode = BridgeMode::Listening;
        inner.fallback_port = fallback_port;
        inner.session = Some(session);
        inner.pending_client = None;
        inner.connected_client = None;
        // `bind_warning` records non-fatal bind oddities (e.g. AddrInUse on the
        // default port) so the UI can hint at a port collision without flipping
        // the bridge to Error.
        inner.last_error = bind_warning;
        inner.shutdown = Some(shutdown_tx);
    }

    tauri::async_runtime::spawn(run_http_edge(
        listener,
        state.inner().clone(),
        shutdown_rx,
    ));

    snapshot_from_bridge(&bridge)
}

#[tauri::command]
pub fn agent_bridge_disable(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    let shutdown = {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        let shutdown = inner.shutdown.take();
        let trace_context = inner.trace_context.clone();
        *inner = BridgeInner::default();
        inner.trace_context = trace_context;
        shutdown
    };
    if let Some(shutdown) = shutdown {
        let _ = shutdown.send(());
    }
    snapshot(&state)
}

#[tauri::command]
pub fn agent_bridge_allow_pending(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        let client = inner
            .pending_client
            .take()
            .ok_or_else(|| "no pending client to allow".to_string())?;
        inner.connected_client = Some(client);
        inner.mode = BridgeMode::Connected;
    }
    snapshot(&state)
}

#[tauri::command]
pub fn agent_bridge_deny_pending(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        inner.pending_client = None;
        if inner.mode == BridgeMode::PendingAuthorization {
            inner.mode = BridgeMode::Listening;
        }
    }
    snapshot(&state)
}

#[tauri::command]
pub fn agent_bridge_revoke_connected(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        inner.connected_client = None;
        if inner.mode == BridgeMode::Connected {
            inner.mode = BridgeMode::Listening;
        }
    }
    snapshot(&state)
}

#[tauri::command]
pub fn agent_bridge_regenerate_session(
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeSnapshot, String> {
    // Surgical rotate: build a fresh SessionConfig (new bearer + ids + cached
    // commands), drop pending/connected clients, and force the bridge back to
    // Listening. Listener and port are intentionally untouched so any
    // persistent MCP host config keeps working.
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        if inner.mode == BridgeMode::Disabled {
            return snapshot_inner(&inner);
        }
        let port = match inner.session.as_ref() {
            Some(session) => session.port,
            None => return Err("Agent Bridge is not fully started yet".to_string()),
        };
        inner.session = Some(Arc::new(SessionConfig::new(port)));
        inner.pending_client = None;
        inner.connected_client = None;
        inner.mode = BridgeMode::Listening;
    }
    snapshot(&state)
}

#[tauri::command]
pub fn agent_bridge_set_trace_context(
    state: State<'_, AgentBridgeState>,
    context: TraceContext,
) -> Result<AgentBridgeSnapshot, String> {
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        inner.trace_context = Some(context);
    }
    snapshot(&state)
}

fn snapshot(state: &State<'_, AgentBridgeState>) -> Result<AgentBridgeSnapshot, String> {
    snapshot_from_bridge(&state.inner().inner)
}

fn snapshot_from_bridge(
    bridge: &Arc<Mutex<BridgeInner>>,
) -> Result<AgentBridgeSnapshot, String> {
    let inner = bridge
        .lock()
        .map_err(|_| "agent bridge state lock poisoned".to_string())?;
    snapshot_inner(&inner)
}

fn snapshot_inner(inner: &BridgeInner) -> Result<AgentBridgeSnapshot, String> {
    let session = inner.session.as_deref();
    Ok(AgentBridgeSnapshot {
        status: inner.mode.as_str().to_string(),
        port: session.map(|s| s.port),
        endpoint: session.map(|s| s.endpoint.clone()),
        fallback_port: inner.fallback_port,
        session_id: session.map(|s| s.session_id.clone()),
        pending_client: inner.pending_client.clone(),
        connected_client: inner.connected_client.clone(),
        last_error: inner.last_error.clone(),
        last_method: inner.last_method.clone(),
        claude_command: session.map(|s| s.claude_command.clone()),
        codex_command: session.map(|s| s.codex_command.clone()),
    })
}

impl SessionConfig {
    /// Build a fresh session: random secret, ids, and pre-formatted host /
    /// auth / shell-command strings. Invariant: `secret` is hex-only
    /// (`pdb_` + UUID simple) and `endpoint` is a fixed IP-literal URL —
    /// neither contains shell metacharacters or single quotes, so the
    /// command templates below can embed them in single-quoted shell
    /// strings without further escaping.
    fn new(port: u16) -> Self {
        let secret = format!("pdb_{}", Uuid::new_v4().simple());
        let endpoint = format!("http://127.0.0.1:{port}{MCP_PATH}");
        let expected_authorization = format!("Bearer {secret}");
        let allowed_hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        let claude_json = json!({
            "mcpServers": {
                "perfetto-desktop": {
                    "type": "http",
                    "url": endpoint,
                    "headers": {"Authorization": expected_authorization.clone()},
                },
            },
        });
        let claude_command = format!(
            "claude --strict-mcp-config --mcp-config '{claude_json}'"
        );
        let codex_command = format!(
            "PERFETTO_DESKTOP_MCP_TOKEN='{secret}' codex -c 'mcp_servers.perfetto_desktop.url=\"{endpoint}\"' -c 'mcp_servers.perfetto_desktop.bearer_token_env_var=\"PERFETTO_DESKTOP_MCP_TOKEN\"'"
        );
        Self {
            port,
            endpoint,
            expected_authorization,
            allowed_hosts,
            claude_command,
            codex_command,
            session_id: Uuid::new_v4().to_string(),
        }
    }
}

async fn bind_listener() -> Result<(TcpListener, bool, Option<String>), String> {
    // Always bind IPv4 loopback. UI command templates use the literal
    // 127.0.0.1 to avoid any ::1 vs 127.0.0.1 dual-stack confusion.
    let default_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT);
    match TcpListener::bind(default_addr).await {
        Ok(listener) => Ok((listener, false, None)),
        Err(default_err) => {
            // Default port unavailable (typically AddrInUse from another
            // Perfetto Desktop window or unrelated process). Fall back to an
            // OS-assigned ephemeral port and surface the original cause as a
            // non-fatal warning so the UI can show a port-collision hint.
            let fallback_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
            let warning = format!(
                "default port {DEFAULT_PORT} unavailable ({default_err}); using fallback port"
            );
            eprintln!("agent_bridge: {warning}");
            TcpListener::bind(fallback_addr)
                .await
                .map(|listener| (listener, true, Some(warning)))
                .map_err(|err| format!("failed to bind Agent Bridge loopback server: {err}"))
        }
    }
}

async fn run_http_edge(
    listener: TcpListener,
    state: AgentBridgeState,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            accept = listener.accept() => {
                let Ok((stream, _addr)) = accept else {
                    // Per-connection accept failure: log and keep listening.
                    // Do not flip the bridge into Error — a transient EMFILE
                    // or peer reset must not lock out subsequent clients.
                    record_connection_error(&state, "failed to accept Agent Bridge connection");
                    continue;
                };
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let io = TokioIo::new(stream);
                    let service_state = state.clone();
                    let service = service_fn(move |request| {
                        handle_request(request, service_state.clone())
                    });
                    if let Err(err) = http1::Builder::new()
                        .serve_connection(io, service)
                        .await
                    {
                        record_connection_error(
                            &state,
                            &format!("Agent Bridge HTTP error: {err}"),
                        );
                    }
                });
            }
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    state: AgentBridgeState,
) -> Result<Response<ResponseBody>, Infallible> {
    let response = handle_request_inner(request, state)
        .await
        .unwrap_or_else(|(status, message)| plain_response(status, &message));
    Ok(response)
}

async fn handle_request_inner(
    request: Request<Incoming>,
    state: AgentBridgeState,
) -> Result<Response<ResponseBody>, (StatusCode, String)> {
    // TODO: GET /mcp is reserved for Streamable HTTP server-sent events.
    // Phase B wave 2 will use it to push `notifications/tools/list_changed`
    // when the user toggles tier. For now any non-POST method 404s.
    if request.method() != Method::POST || request.uri().path() != MCP_PATH {
        return Err((StatusCode::NOT_FOUND, "unknown Agent Bridge endpoint".to_string()));
    }
    let request_session = validate_http_headers(request.headers(), &state)?;

    let limited = Limited::new(request.into_body(), MAX_BODY_BYTES);
    let bytes = limited
        .collect()
        .await
        .map_err(|err| {
            // `Limited` reports overflow as a generic body error; we map any
            // body-collection failure to 413 to keep the surface simple. JSON
            // parse failures are caught by the next step with 400.
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("request body exceeded {MAX_BODY_BYTES} bytes or could not be read: {err}"),
            )
        })?
        .to_bytes();
    let rpc: JsonRpcRequest = serde_json::from_slice(&bytes)
        .map_err(|err| (StatusCode::BAD_REQUEST, format!("invalid JSON-RPC request: {err}")))?;
    set_last_method(&state, &rpc.method);

    if rpc.id.is_none() {
        return Ok(empty_response(StatusCode::ACCEPTED));
    }

    Ok(match rpc.method.as_str() {
        "initialize" => initialize_response(rpc.id, rpc.params, &state, &request_session),
        "tools/list" => tools_list_response(rpc.id),
        "tools/call" => tools_call_response(rpc.id, rpc.params, &state),
        method => json_rpc_error(
            rpc.id,
            -32601,
            &format!("unsupported MCP method: {method}"),
        ),
    })
}

fn validate_http_headers(
    headers: &HeaderMap,
    state: &AgentBridgeState,
) -> Result<Arc<SessionConfig>, (StatusCode, String)> {
    // Brief lock to bump the Arc refcount, then drop. Header checks below run
    // lock-free against the immutable SessionConfig.
    let session = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "state lock poisoned".to_string()))?;
        inner
            .session
            .clone()
            .ok_or((StatusCode::SERVICE_UNAVAILABLE, "Agent Bridge is disabled".to_string()))?
    };

    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !session.allowed_hosts.iter().any(|allowed| allowed == host) {
        return Err((StatusCode::FORBIDDEN, "Host header is not allowed".to_string()));
    }

    if let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) {
        if origin.starts_with("http://") || origin.starts_with("https://") {
            return Err((StatusCode::FORBIDDEN, "browser Origin is not allowed".to_string()));
        }
    }

    if let Some(fetch_site) = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
    {
        if fetch_site.eq_ignore_ascii_case("cross-site") {
            return Err((StatusCode::FORBIDDEN, "cross-site fetch is not allowed".to_string()));
        }
    }

    let auth = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    // Constant-time compare. Loopback timing leaks are mostly theoretical, but
    // the cost is one short XOR-fold and avoids any debate later.
    if auth
        .as_bytes()
        .ct_eq(session.expected_authorization.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err((StatusCode::UNAUTHORIZED, "missing or invalid bearer token".to_string()));
    }

    Ok(session)
}

fn initialize_response(
    id: Option<Value>,
    params: Option<Value>,
    state: &AgentBridgeState,
    request_session: &Arc<SessionConfig>,
) -> Response<ResponseBody> {
    let client_name = params
        .as_ref()
        .and_then(|params| params.get("clientInfo"))
        .and_then(|client_info| client_info.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown MCP client")
        .to_string();
    let client = ClientInfo {
        client_id: Uuid::new_v4().to_string(),
        name: client_name,
    };

    {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return json_rpc_error(id, -32603, "state lock poisoned");
            }
        };
        let Some(active_session) = inner.session.as_ref() else {
            return json_rpc_error(id, -32001, "Agent Bridge session is no longer active");
        };
        if !Arc::ptr_eq(active_session, request_session) {
            return json_rpc_error(
                id,
                -32001,
                "Agent Bridge session changed; reconnect with the current command",
            );
        }
        if !matches!(
            inner.mode,
            BridgeMode::Listening | BridgeMode::PendingAuthorization | BridgeMode::Connected
        ) {
            return json_rpc_error(id, -32001, "Agent Bridge is not accepting clients");
        }
        // The one-time bearer is the authorization gesture for wave 1's
        // read-only metadata tool. A fresh initialize from the same session can
        // replace the displayed client metadata without another Desktop click.
        inner.pending_client = None;
        inner.connected_client = Some(client);
        inner.mode = BridgeMode::Connected;
    }

    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {
                    "listChanged": true,
                },
            },
            "serverInfo": {
                "name": "perfetto-desktop",
                "version": env!("CARGO_PKG_VERSION"),
            },
        },
    }))
}

fn tools_list_response(id: Option<Value>) -> Response<ResponseBody> {
    // `tools/list` is part of MCP startup for Codex/Claude. Header validation
    // already proved possession of the session bearer, so expose schemas while
    // Desktop authorization is pending; keep the real gate on `tools/call`.
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "tools": [
                {
                    "name": "perfetto-get-trace-info",
                    "description": "Return current Perfetto Desktop Agent Bridge and trace context metadata.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false,
                    },
                },
            ],
        },
    }))
}

fn tools_call_response(
    id: Option<Value>,
    params: Option<Value>,
    state: &AgentBridgeState,
) -> Response<ResponseBody> {
    if let Some(error) = authorization_error(state) {
        if error == "pending_authorization" {
            return tool_text_response(
                id,
                "Desktop authorization is pending. Ask the user to click Allow in Perfetto Desktop, then retry this tool call.",
            );
        }
        return json_rpc_error(id, -32002, &error);
    }

    let tool_name = params
        .as_ref()
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool_name != "perfetto-get-trace-info" {
        return json_rpc_error(id, -32601, "tool is not implemented in this skeleton");
    }

    let snapshot = match snapshot_from_bridge(&state.inner) {
        Ok(snapshot) => snapshot,
        Err(err) => return json_rpc_error(id, -32603, &err),
    };
    let trace_context = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.trace_context.clone());
    let text = serde_json::to_string_pretty(&json!({
        "bridgeStatus": snapshot.status,
        "endpoint": snapshot.endpoint,
        "sessionId": snapshot.session_id,
        "client": snapshot.connected_client,
        "trace": trace_context,
        "implementedTools": ["perfetto-get-trace-info"],
        "note": "This wave exposes trace metadata only. SQL and UI-driving tools will be implemented in the next Phase B wave.",
    }))
    .unwrap_or_else(|_| "{}".to_string());

    tool_text_response(id, &text)
}

fn tool_text_response(id: Option<Value>, text: &str) -> Response<ResponseBody> {
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": text,
                },
            ],
        },
    }))
}

fn authorization_error(state: &AgentBridgeState) -> Option<String> {
    let inner = state.inner.lock().ok()?;
    match inner.mode {
        BridgeMode::Connected => None,
        BridgeMode::PendingAuthorization => Some("pending_authorization".to_string()),
        BridgeMode::Listening => Some("unauthorized".to_string()),
        BridgeMode::Disabled => Some("bridge_disabled".to_string()),
        BridgeMode::Starting => Some("bridge_starting".to_string()),
        BridgeMode::Error => Some("bridge_error".to_string()),
    }
}

fn json_rpc_error(id: Option<Value>, code: i32, message: &str) -> Response<ResponseBody> {
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message,
        },
    }))
}

fn json_response(value: Value) -> Response<ResponseBody> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(value.to_string())))
        .unwrap_or_else(|_| plain_response(StatusCode::INTERNAL_SERVER_ERROR, "response build error"))
}

fn plain_response(status: StatusCode, message: &str) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(message.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn empty_response(status: StatusCode) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

// TODO(review-M7): replace last_method/last_error scalars with the 1000-entry
// in-memory audit ring buffer specified in design §8 (tool name + truncated
// args summary + status + duration). Phase B wave 2 work.
fn set_last_method(state: &AgentBridgeState, method: &str) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.last_method = Some(method.to_string());
    }
}

/// Record a non-fatal error from a single connection. The bridge keeps
/// listening; only `last_error` is updated. Use this for accept errors,
/// per-connection HTTP parse failures, and similar transient noise.
///
/// A fatal counterpart that flips the state machine into `Error` will be
/// added when the first call site needs it (e.g. listener loss mid-flight).
fn record_connection_error(state: &AgentBridgeState, error: &str) {
    eprintln!("agent_bridge: {error}");
    if let Ok(mut inner) = state.inner.lock() {
        inner.last_error = Some(error.to_string());
    }
}
