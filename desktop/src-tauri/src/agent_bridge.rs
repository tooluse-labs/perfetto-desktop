use std::collections::{HashMap, VecDeque};
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
use tokio::sync::{oneshot, watch, Notify};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

// TODO: thread DEFAULT_PORT through user settings before Phase D.
const DEFAULT_PORT: u16 = 38471;
const MCP_PATH: &str = "/mcp";
const TRACE_CONTEXT_RESOURCE_URI: &str = "perfetto://desktop/current-trace";
const TRACE_CONTEXT_RESOURCE_NAME: &str = "Current Perfetto trace";
// Keep this single-quote-free: the generated shell snippets wrap it in
// single quotes for both sh and PowerShell.
const CLI_TRACE_CONTEXT_PROMPT: &str = "Use the connected Perfetto Desktop MCP server as the primary context. First call perfetto-get-trace-info to inspect the currently loaded trace, then analyze that loaded trace. Do not search the local filesystem for trace files unless explicitly asked.";
// 1 MiB cap on incoming MCP request bodies. JSON-RPC envelopes are far smaller;
// query results stream out via response side, where Phase B SQL caps live.
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_PENDING_MCP_REQUESTS: usize = 8;
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Cap how long the WebView pump may park inside `agent_bridge_next_rpc_request`
// before the command returns `None`. The pump immediately re-issues, so this
// only bounds Tauri IPC churn (and gives runtime watchdogs a heartbeat).
const RPC_LONG_POLL_TIMEOUT: Duration = Duration::from_secs(25);

type ResponseBody = Full<Bytes>;

#[derive(Clone, Default)]
pub struct AgentBridgeState {
    inner: Arc<Mutex<BridgeInner>>,
    // Held outside `BridgeInner` so `agent_bridge_disable`'s
    // `*inner = BridgeInner::default()` reset does not orphan a parked
    // long-poll waiter on the WebView pump. The pump waits on this Notify;
    // re-creating it across enable/disable would force the next request to
    // sit through `RPC_LONG_POLL_TIMEOUT` before the pump notices.
    mcp_request_notify: Arc<Notify>,
}

#[derive(Default)]
struct BridgeInner {
    mode: BridgeMode,
    fallback_port: bool,
    session: Option<Arc<SessionConfig>>,
    pending_client: Option<ClientInfo>,
    connected_client: Option<ClientInfo>,
    trace_context: Option<TraceContext>,
    mcp_requests: VecDeque<AgentBridgeRpcRequest>,
    mcp_responders: HashMap<String, oneshot::Sender<AgentBridgeRpcResponse>>,
    connection_revoker: Option<watch::Sender<()>>,
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
    claude_command_ps: String,
    codex_command_ps: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_command_ps: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_command_ps: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeRpcRequest {
    request_id: String,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeRpcResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcErrorObject>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcErrorObject {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
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
        agent_bridge_next_rpc_request,
        agent_bridge_complete_rpc_request,
    ]
}

pub fn spawn_auto_start(state: AgentBridgeState) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = enable_bridge(state).await {
            eprintln!("agent_bridge: auto-start failed: {err}");
        }
    });
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
    enable_bridge(state.inner().clone()).await
}

async fn enable_bridge(state: AgentBridgeState) -> Result<AgentBridgeSnapshot, String> {
    let bridge = state.inner.clone();

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
    let (connection_revoker, connection_revocations) = watch::channel(());

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
        inner.connection_revoker = Some(connection_revoker);
        inner.shutdown = Some(shutdown_tx);
    }

    tauri::async_runtime::spawn(run_http_edge(
        listener,
        state.clone(),
        shutdown_rx,
        connection_revocations,
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
        revoke_active_connections(&mut inner, "bridge_disabled");
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
        rotate_session(&mut inner);
        revoke_active_connections(&mut inner, "authorization_denied");
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
        rotate_session(&mut inner);
        revoke_active_connections(&mut inner, "authorization_revoked");
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
        revoke_active_connections(&mut inner, "session_regenerated");
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

#[tauri::command]
pub async fn agent_bridge_next_rpc_request(
    state: State<'_, AgentBridgeState>,
) -> Result<Option<AgentBridgeRpcRequest>, String> {
    {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        if let Some(request) = inner.mcp_requests.pop_front() {
            return Ok(Some(request));
        }
    }

    // Park until either a request lands or the long-poll bound elapses. The
    // WebView pump will immediately re-issue on `None`, so the timeout is
    // strictly an IPC-heartbeat ceiling, not a backoff.
    let notify = state.inner().mcp_request_notify.clone();
    let _ = timeout(RPC_LONG_POLL_TIMEOUT, notify.notified()).await;

    let mut inner = state
        .inner()
        .inner
        .lock()
        .map_err(|_| "agent bridge state lock poisoned".to_string())?;
    Ok(inner.mcp_requests.pop_front())
}

#[tauri::command]
pub fn agent_bridge_complete_rpc_request(
    state: State<'_, AgentBridgeState>,
    request_id: String,
    response: AgentBridgeRpcResponse,
) -> Result<(), String> {
    let responder = {
        let mut inner = state
            .inner()
            .inner
            .lock()
            .map_err(|_| "agent bridge state lock poisoned".to_string())?;
        inner.mcp_responders.remove(&request_id)
    };
    if let Some(responder) = responder {
        let _ = responder.send(response);
    }
    Ok(())
}

fn snapshot(state: &State<'_, AgentBridgeState>) -> Result<AgentBridgeSnapshot, String> {
    snapshot_from_bridge(&state.inner().inner)
}

fn snapshot_from_bridge(bridge: &Arc<Mutex<BridgeInner>>) -> Result<AgentBridgeSnapshot, String> {
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
        claude_command_ps: session.map(|s| s.claude_command_ps.clone()),
        codex_command_ps: session.map(|s| s.codex_command_ps.clone()),
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
        // Bash/zsh forms keep the JSON / TOML pairs in single quotes — the
        // shell preserves embedded double quotes verbatim and the CLI sees the
        // intended argument.
        //
        // PowerShell on Windows is more delicate. PowerShell itself preserves
        // embedded double quotes, but `claude.cmd` / `codex.cmd` (the npm-bin
        // shims) hand the argv off to cmd.exe, whose tokenizer strips embedded
        // `"`. The mitigations below avoid putting `"` in the args:
        //   - Claude: write the config JSON to a temp file (ASCII, no BOM)
        //     and pass the path to --mcp-config. Use cmdlets only so the
        //     command also works in Windows PowerShell Constrained Language
        //     Mode, where `[IO.Path]::GetTempFileName()` is blocked.
        //   - Codex: flip the -c TOML pairs to outer double / inner single
        //     quotes. cmd.exe strips the outer double quotes; the inner
        //     single quotes pass through and TOML parses them as literal
        //     strings.
        let claude_command = format!(
            "claude --strict-mcp-config --mcp-config '{claude_json}' '{CLI_TRACE_CONTEXT_PROMPT}'"
        );
        let claude_command_ps = format!(
            "$cfg='{claude_json}'; $tmp=(New-TemporaryFile).FullName; $cfg | Set-Content -LiteralPath $tmp -Encoding ascii -NoNewline; claude --strict-mcp-config --mcp-config $tmp '{CLI_TRACE_CONTEXT_PROMPT}'"
        );
        let codex_args = format!(
            "codex -c 'mcp_servers.perfetto_desktop.url=\"{endpoint}\"' -c 'mcp_servers.perfetto_desktop.bearer_token_env_var=\"PERFETTO_DESKTOP_MCP_TOKEN\"' '{CLI_TRACE_CONTEXT_PROMPT}'"
        );
        let codex_args_ps = format!(
            "codex -c \"mcp_servers.perfetto_desktop.url='{endpoint}'\" -c \"mcp_servers.perfetto_desktop.bearer_token_env_var='PERFETTO_DESKTOP_MCP_TOKEN'\" '{CLI_TRACE_CONTEXT_PROMPT}'"
        );
        let codex_command = format!("PERFETTO_DESKTOP_MCP_TOKEN='{secret}' {codex_args}");
        let codex_command_ps =
            format!("$env:PERFETTO_DESKTOP_MCP_TOKEN='{secret}'; {codex_args_ps}");
        Self {
            port,
            endpoint,
            expected_authorization,
            allowed_hosts,
            claude_command,
            codex_command,
            claude_command_ps,
            codex_command_ps,
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

fn rotate_session(inner: &mut BridgeInner) {
    let Some(port) = inner.session.as_ref().map(|session| session.port) else {
        return;
    };
    inner.session = Some(Arc::new(SessionConfig::new(port)));
}

fn revoke_active_connections(inner: &mut BridgeInner, reason: &str) {
    if let Some(revoker) = &inner.connection_revoker {
        let _ = revoker.send(());
    }

    inner.mcp_requests.clear();
    let response = AgentBridgeRpcResponse {
        result: None,
        error: Some(JsonRpcErrorObject {
            code: -32002,
            message: reason.to_string(),
            data: None,
        }),
    };
    for (_, responder) in inner.mcp_responders.drain() {
        let _ = responder.send(response.clone());
    }
}

fn revocation_receiver_for_new_connection(receiver: &watch::Receiver<()>) -> watch::Receiver<()> {
    let mut receiver = receiver.clone();
    // A receiver cloned after a prior revoke can still observe that old value
    // as "changed". Mark the current epoch as seen so a fresh connection is
    // closed only by future revokes.
    let _ = receiver.borrow_and_update();
    receiver
}

async fn run_http_edge(
    listener: TcpListener,
    state: AgentBridgeState,
    mut shutdown_rx: oneshot::Receiver<()>,
    connection_revocations: watch::Receiver<()>,
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
                let connection_revocations =
                    revocation_receiver_for_new_connection(&connection_revocations);
                tauri::async_runtime::spawn(async move {
                    let io = TokioIo::new(stream);
                    let service_state = state.clone();
                    let service = service_fn(move |request| {
                        handle_request(request, service_state.clone())
                    });
                    let builder = http1::Builder::new();
                    let connection = builder.serve_connection(io, service);
                    let mut connection_revocations = connection_revocations;
                    tokio::select! {
                        result = connection => {
                            if let Err(err) = result {
                                record_connection_error(
                                    &state,
                                    &format!("Agent Bridge HTTP error: {err}"),
                                );
                            }
                        }
                        changed = connection_revocations.changed() => {
                            if changed.is_err() {
                                record_connection_error(
                                    &state,
                                    "Agent Bridge connection revocation channel closed",
                                );
                            }
                        }
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
        return Err((
            StatusCode::NOT_FOUND,
            "unknown Agent Bridge endpoint".to_string(),
        ));
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
    let rpc: JsonRpcRequest = serde_json::from_slice(&bytes).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid JSON-RPC request: {err}"),
        )
    })?;
    set_last_method(&state, &rpc.method);

    if rpc.id.is_none() {
        return Ok(empty_response(StatusCode::ACCEPTED));
    }

    Ok(match rpc.method.as_str() {
        "initialize" => initialize_response(rpc.id, rpc.params, &state, &request_session),
        "resources/list" => resources_list_response(rpc.id),
        "resources/read" => resources_read_response(rpc.id, rpc.params, &state),
        "tools/list" => proxy_mcp_request(rpc.id, rpc.method, rpc.params, &state).await,
        "tools/call" => tools_call_response(rpc.id, rpc.params, &state).await,
        method => json_rpc_error(rpc.id, -32601, &format!("unsupported MCP method: {method}")),
    })
}

fn validate_http_headers(
    headers: &HeaderMap,
    state: &AgentBridgeState,
) -> Result<Arc<SessionConfig>, (StatusCode, String)> {
    // Brief lock to bump the Arc refcount, then drop. Header checks below run
    // lock-free against the immutable SessionConfig.
    let session = {
        let inner = state.inner.lock().map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "state lock poisoned".to_string(),
            )
        })?;
        inner.session.clone().ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "Agent Bridge is disabled".to_string(),
        ))?
    };

    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !session.allowed_hosts.iter().any(|allowed| allowed == host) {
        return Err((
            StatusCode::FORBIDDEN,
            "Host header is not allowed".to_string(),
        ));
    }

    if let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) {
        if origin.starts_with("http://") || origin.starts_with("https://") {
            return Err((
                StatusCode::FORBIDDEN,
                "browser Origin is not allowed".to_string(),
            ));
        }
    }

    if let Some(fetch_site) = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
    {
        if fetch_site.eq_ignore_ascii_case("cross-site") {
            return Err((
                StatusCode::FORBIDDEN,
                "cross-site fetch is not allowed".to_string(),
            ));
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
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid bearer token".to_string(),
        ));
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
    let context = match bridge_context_payload(state) {
        Ok(context) => context,
        Err(err) => return json_rpc_error(id, -32603, &err),
    };
    let instructions = bridge_instructions(&context);

    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "resources": {
                    "listChanged": true,
                },
                "tools": {
                    "listChanged": true,
                },
            },
            "serverInfo": {
                "name": "perfetto-desktop",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": instructions,
        },
    }))
}

fn resources_list_response(id: Option<Value>) -> Response<ResponseBody> {
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "resources": [
                {
                    "uri": TRACE_CONTEXT_RESOURCE_URI,
                    "name": TRACE_CONTEXT_RESOURCE_NAME,
                    "description": "Current Perfetto Desktop trace metadata and Agent Bridge status.",
                    "mimeType": "application/json",
                },
            ],
        },
    }))
}

fn resources_read_response(
    id: Option<Value>,
    params: Option<Value>,
    state: &AgentBridgeState,
) -> Response<ResponseBody> {
    let uri = params
        .as_ref()
        .and_then(|params| params.get("uri"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if uri != TRACE_CONTEXT_RESOURCE_URI {
        return json_rpc_error(id, -32602, "unknown Perfetto Desktop resource");
    }

    let context = match bridge_context_payload(state) {
        Ok(context) => context,
        Err(err) => return json_rpc_error(id, -32603, &err),
    };
    let text = serde_json::to_string_pretty(&context).unwrap_or_else(|_| "{}".to_string());
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": {
            "contents": [
                {
                    "uri": TRACE_CONTEXT_RESOURCE_URI,
                    "mimeType": "application/json",
                    "text": text,
                },
            ],
        },
    }))
}

async fn tools_call_response(
    id: Option<Value>,
    params: Option<Value>,
    state: &AgentBridgeState,
) -> Response<ResponseBody> {
    if let Some(error) = authorization_error(state) {
        if error == "pending_authorization" {
            return json_rpc_error(id, -32002, "pending_authorization");
        }
        return json_rpc_error(id, -32002, &error);
    }

    proxy_mcp_request(id, "tools/call".to_string(), params, state).await
}

async fn proxy_mcp_request(
    id: Option<Value>,
    method: String,
    params: Option<Value>,
    state: &AgentBridgeState,
) -> Response<ResponseBody> {
    let (request, receiver) = {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return json_rpc_error(id, -32603, "state lock poisoned"),
        };
        if inner.mcp_responders.len() >= MAX_PENDING_MCP_REQUESTS {
            return json_rpc_error(id, -32004, "too many pending Agent Bridge MCP requests");
        }

        let request = AgentBridgeRpcRequest {
            request_id: Uuid::new_v4().to_string(),
            method,
            params,
        };
        let (sender, receiver) = oneshot::channel();
        inner
            .mcp_responders
            .insert(request.request_id.clone(), sender);
        inner.mcp_requests.push_back(request.clone());
        (request, receiver)
    };
    state.mcp_request_notify.notify_one();

    let response = match timeout(MCP_REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            return json_rpc_error(
                id,
                -32003,
                "Perfetto Desktop closed the MCP request before it completed",
            );
        }
        Err(_) => {
            if let Ok(mut inner) = state.inner.lock() {
                inner.mcp_responders.remove(&request.request_id);
                inner
                    .mcp_requests
                    .retain(|queued| queued.request_id != request.request_id);
            }
            return json_rpc_error(
                id,
                -32003,
                "Timed out waiting for Perfetto Desktop WebView to handle the MCP request",
            );
        }
    };

    if let Some(error) = response.error {
        return json_response(json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": error,
        }));
    }
    json_response(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": response.result.unwrap_or_else(|| json!({})),
    }))
}

fn bridge_context_payload(state: &AgentBridgeState) -> Result<Value, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "agent bridge state lock poisoned".to_string())?;
    let session = inner.session.as_deref();
    Ok(json!({
        "bridgeStatus": inner.mode.as_str(),
        "endpoint": session.map(|session| session.endpoint.as_str()),
        "sessionId": session.map(|session| session.session_id.as_str()),
        "client": inner.connected_client.as_ref(),
        "trace": inner.trace_context.as_ref(),
        "implementedTools": [
            "perfetto-get-trace-info",
            "perfetto-execute-query",
            "perfetto-list-interesting-tables",
            "perfetto-list-table-structure",
            "show-perfetto-sql-view",
            "show-timeline",
        ],
        "availableResources": [
            {
                "uri": TRACE_CONTEXT_RESOURCE_URI,
                "name": TRACE_CONTEXT_RESOURCE_NAME,
                "mimeType": "application/json",
            },
        ],
        "note": "Agent Bridge reuses upstream Perfetto MCP tool names where available. Tool implementations run in the WebView against the currently loaded trace.",
    }))
}

fn bridge_instructions(context: &Value) -> String {
    let trace = context
        .get("trace")
        .and_then(|trace| if trace.is_null() { None } else { Some(trace) });
    let trace_summary = match trace {
        Some(trace) => serde_json::to_string_pretty(trace).unwrap_or_else(|_| "{}".to_string()),
        None => "No trace is currently loaded in Perfetto Desktop.".to_string(),
    };
    format!(
        "You are connected to Perfetto Desktop through the local Agent Bridge.\n\
Current Perfetto trace context:\n{trace_summary}\n\
Use perfetto-get-trace-info to refresh metadata. Use perfetto-execute-query for bounded \
PerfettoSQL SELECT/WITH queries against the loaded trace before making trace-analysis claims. \
Use show-perfetto-sql-view and show-timeline when the user asks you to change Perfetto Desktop UI state."
    )
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
        .unwrap_or_else(|_| {
            plain_response(StatusCode::INTERNAL_SERVER_ERROR, "response build error")
        })
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
        .header("content-type", "application/json")
        .header("content-length", "0")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_connection_receiver_ignores_prior_revocation_epoch() {
        let (sender, receiver) = watch::channel(());
        sender.send(()).expect("send prior revoke");

        let mut connection_receiver = revocation_receiver_for_new_connection(&receiver);
        let prior = timeout(Duration::from_millis(10), connection_receiver.changed()).await;
        assert!(prior.is_err(), "old revoke must not close a new connection");

        sender.send(()).expect("send future revoke");
        let future = timeout(Duration::from_millis(100), connection_receiver.changed()).await;
        assert!(future.is_ok(), "future revoke must close the connection");
    }

    // The PowerShell connection commands have to dodge a quirky Windows
    // behaviour: `claude.cmd` / `codex.cmd` (the npm-bin shims) hand argv off
    // to cmd.exe, whose tokenizer strips embedded `"`. Earlier revisions of
    // this code passed the JSON config inline as a CLI argument, which was
    // mangled in production (claude received `{mcpServers:...}` and tried to
    // resolve it as a relative file path). The tests below lock down the
    // shape of the PowerShell variants so a future "simplification" can't
    // accidentally fold them back into the sh form.
    #[test]
    fn powershell_claude_command_writes_config_to_a_temp_file() {
        let session = SessionConfig::new(38471);
        assert!(
            session.claude_command_ps.contains("New-TemporaryFile"),
            "PowerShell Claude command must create temp files with CLM-safe cmdlets: {}",
            session.claude_command_ps,
        );
        assert!(
            session.claude_command_ps.contains("Set-Content"),
            "PowerShell Claude command must persist JSON via Set-Content: {}",
            session.claude_command_ps,
        );
        assert!(
            !session.claude_command_ps.contains("[IO.Path]::GetTempFileName"),
            "PowerShell Claude command must not call .NET methods blocked by Constrained Language Mode: {}",
            session.claude_command_ps,
        );
        assert!(
            session.claude_command_ps.contains("--mcp-config $tmp"),
            "PowerShell Claude command must pass the temp-file path, \
             not inline JSON: {}",
            session.claude_command_ps,
        );
        // Sanity-anchor the bash variant: it intentionally inlines the JSON
        // (single-quoted bash strings preserve embedded `"` losslessly).
        assert!(
            session.claude_command.contains("--mcp-config '{"),
            "Bash Claude command should inline JSON: {}",
            session.claude_command,
        );
    }

    #[test]
    fn powershell_codex_command_uses_outer_double_inner_single_quotes() {
        let session = SessionConfig::new(38471);
        assert!(
            session
                .codex_command_ps
                .contains("-c \"mcp_servers.perfetto_desktop.url='"),
            "PowerShell Codex `-c` args must wrap with outer double / \
             inner single quotes so cmd.exe only strips the outer pair: {}",
            session.codex_command_ps,
        );
        assert!(
            session
                .codex_command_ps
                .starts_with("$env:PERFETTO_DESKTOP_MCP_TOKEN="),
            "PowerShell Codex command must use the `$env:` env-var prefix: {}",
            session.codex_command_ps,
        );
        assert!(
            !session
                .codex_command_ps
                .starts_with("PERFETTO_DESKTOP_MCP_TOKEN="),
            "PowerShell Codex command must not use the bare `VAR=val` \
             prefix — PowerShell would treat the assignment as a command \
             name: {}",
            session.codex_command_ps,
        );
        // Sanity-anchor the bash variant: it intentionally uses the
        // sh-only `VAR=val cmd` inline env-var prefix.
        assert!(
            session
                .codex_command
                .starts_with("PERFETTO_DESKTOP_MCP_TOKEN="),
            "Bash Codex command should use the `VAR=val` env-var prefix: {}",
            session.codex_command,
        );
    }

    #[test]
    fn cli_commands_start_with_loaded_trace_context() {
        let session = SessionConfig::new(38471);
        assert!(
            !CLI_TRACE_CONTEXT_PROMPT.contains('\''),
            "prompt must remain single-quote-free for shell embedding"
        );

        for (name, command) in [
            ("claude sh", &session.claude_command),
            ("claude powershell", &session.claude_command_ps),
            ("codex sh", &session.codex_command),
            ("codex powershell", &session.codex_command_ps),
        ] {
            assert!(
                command.contains(&format!("'{CLI_TRACE_CONTEXT_PROMPT}'")),
                "{name} command must pass the trace-context prompt: {command}",
            );
            assert!(
                command.contains("perfetto-get-trace-info"),
                "{name} command must instruct the agent to inspect the loaded trace first: {command}",
            );
        }
    }
}
