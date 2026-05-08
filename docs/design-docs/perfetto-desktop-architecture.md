# Perfetto Desktop with Multi-LLM AI Plugin — Architecture

> 中文版：[perfetto-desktop-architecture.zh-CN.md](perfetto-desktop-architecture.zh-CN.md)

## 1. Background

Perfetto's primary user-facing surface is the Web UI under `ui/`. The
upstream `ui/src/plugins/com.google.PerfettoMcp` plugin already provides
a Gemini-backed AI Chat. It registers Perfetto trace and UI tools and
exposes them to the model via MCP (Model Context Protocol).

This fork extends three capabilities while keeping upstream sync
sustainable:

1. Package the Perfetto UI as a Tauri desktop installer.
2. Add multi-LLM Provider support on top of Perfetto's existing MCP
   tools.
3. Sync with upstream Perfetto on a regular cadence to keep long-term
   maintenance costs low.

## 2. Goals and Non-goals

### 2.1 Goals

- Ship desktop installers for macOS, Windows, and Linux.
- Preserve the Perfetto Web UI's main features and upstream upgrade
  path.
- Add a standalone AI plugin. MVP supports Gemini and HTTPS
  OpenAI-compatible Providers; Anthropic and Ollama land in later
  phases.
- Reuse the existing MCP tool registration approach so the model can
  query traces, run SQL, and read UI context.
- Keep fork-specific code inside clear directory boundaries to reduce
  upstream merge conflicts.
- Support local config, API key management, model switching, and basic
  error diagnostics.

### 2.2 Non-goals

- No changes to Perfetto's C++ trace processor core.
- No rewrite of the existing Perfetto UI.
- No multi-user collaboration, account system, or enterprise gateway in
  phase 1.
- No support for local-HTTP Providers like Ollama (default
  `http://localhost:11434`) in MVP. That capability needs a CSP fork
  patch or a Tauri-side proxy.
- No commitment that all models support full tool calling. Models that
  don't support it fall back to SQL generation or chat-only mode.

## 3. Overall Approach

A "lean product repo + DEPS-pinned upstream" structure:

```text
perfetto-desktop/                  # this repo (Tooluse Labs product repo)
  DEPS                             # pinned upstream Perfetto SHA
  desktop/                         # Tauri desktop project
    src-tauri/
    package.json
    tauri.conf.json
  ui-overlay/
    plugins/
      com.tooluselabs.PerfettoDesktop/    # AI plugin source (Phase 2)
        index.ts
        chat_page.ts
        settings.ts
        provider/
          types.ts
          gemini.ts
          openai_compatible.ts
          # anthropic.ts, ollama.ts in phase 2
        mcp/
          server.ts
          tool_adapter.ts
        styles.scss
  patches/perfetto/                # patches applied to upstream at setup time
  scripts/
    setup.sh                       # clone + checkout + apply patches + sync overlay
    apply-patches.sh
    sync-overlay.sh
    update-perfetto.sh
  third_party/
    perfetto/                      # gitignored; populated by scripts/setup.sh
```

Tauri owns the desktop lifecycle, file access, installer, auto-update,
and secure storage. The Perfetto UI continues to drive the front end.
The AI plugin registers a page and a sidebar entry inside the UI, and
calls different models through a unified Provider abstraction.

Upstream Perfetto is treated as a build dependency, not a fork: pinned
by SHA in `DEPS`, fetched into `third_party/perfetto/` by
`scripts/setup.sh`, and never modified in this repo's git history. The
AI plugin source lives in `ui-overlay/plugins/<name>/` and is rsync'd
into `third_party/perfetto/ui/src/plugins/<name>/` by
`scripts/sync-overlay.sh` at setup time, so Perfetto's existing plugin
auto-discovery picks it up unchanged.

## 4. Architecture

### 4.1 Desktop Layer

The desktop layer lives under `desktop/` and does not invade the
upstream build system. After `scripts/setup.sh` has populated
`third_party/perfetto/`, the build runs Perfetto's UI build inside the
upstream checkout and consumes its output as the Tauri front-end asset:

```sh
./scripts/setup.sh
(cd third_party/perfetto && ./ui/build)
(cd desktop && pnpm tauri build)
```

Desktop layer responsibilities:

- Load `third_party/perfetto/ui/out/dist` (or its equivalent build
  output).
- Provide native file open for local traces.
- Use system secure storage for the API key.
- Add auto-update and sidecar processes later.

Phase 1 does not bundle `trace_processor_shell` as a sidecar inside the
installer. That keeps platform diff and signing complexity low. Local
enhancement use cases get a separate review when needed.

### 4.2 AI Plugin Layer

A new `com.tooluselabs.PerfettoDesktop` plugin. It does not refactor
`com.google.PerfettoMcp`, so upstream changes to the Google plugin
cause fewer fork-side conflicts.

Plugin responsibilities:

- Register global settings in `onActivate()`.
- Register the per-trace AI Chat page in `onTraceLoad()`.
- Create an MCP server/client or an equivalent tool context.
- Convert Perfetto tools into each LLM Provider's tool format.
- Drive the tool-call loop manually, without relying on the Gemini
  SDK's `automaticFunctionCalling` path.
- Manage chat state, tool-call display, token usage display, and error
  reporting.

Regular settings registered through `onActivate()`:

- `Provider`: `Gemini`, `OpenAI Compatible`
- `Base URL`
- `Model`
- `Max Tool Calls`
- `Show Tool Calls`
- `Show Token Usage`
- `System Prompt`

Sensitive settings managed through SecretBridge:

- `API Key`
- `Reset API Key`, rendered by the secret UI as an action button, not
  stored as a normal setting.

`API Key` only appears alongside other fields in the settings UI;
persistence must go through the §5 secret bridge, not
`app.settings.register`. If the new plugin keeps existing UI tools
(such as opening a SQL view or other Query Page tools), it must declare
a dependency on `QueryPagePlugin`, the same way `com.google.PerfettoMcp`
does.

### 4.3 Provider Abstraction

A unified interface:

```ts
export const PROVIDER_IDS = ['gemini', 'openai_compatible'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface LlmProviderConfig {
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly systemPrompt: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  sendMessage(input: ChatInput, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
```

Core data structures stay vendor-SDK-agnostic:

```ts
export interface ChatInput {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDeclaration[];
}

export interface ChatResponse {
  readonly messages: readonly ChatMessage[];
  readonly usage?: TokenUsage;
}

export type ChatMessage =
  | {readonly role: 'system'; readonly content: string}
  | {readonly role: 'user'; readonly content: string}
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCallRequest[];
    }
  | {readonly role: 'tool'; readonly toolCallId: string; readonly content: string};

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ToolCallRecord extends ToolCallRequest {
  readonly result?: string;
  readonly error?: string;
}
```

Provider design notes:

- Stateless: messages are owned by the AI plugin layer. The Provider
  handles a single request/response and does not store conversation
  history. There is no `reset()`.
- `ChatInput.tools` carries declarations only. Executors live in the
  AI plugin layer's tool registry. `maxToolCalls` is held by the
  plugin's tool-call loop and does not enter the Provider request.
- MVP returns the full `ChatResponse`. The interface keeps
  `AbortSignal` for user-initiated cancellation. Streaming arrives in
  phase 2 via an added `streamMessage(): AsyncIterable<ChatChunk>`.
- Provider instances are constructed by the AI plugin layer from the
  current `LlmProviderConfig`. Changes to `Provider`, `Base URL`,
  `Model`, or `System Prompt` rebuild the instance.
- `API Key` is asynchronously resolved to a string by the plugin
  layer via the secret bridge before being injected into the Provider
  config; the Provider implementation never calls the secret bridge
  directly.
- On Provider switch, the plugin layer aborts any in-flight request
  via `AbortController` before creating the new Provider.
- `systemPrompt` is injected into the underlying protocol by the
  Provider adapter. The plugin must not also push a system message
  into `ChatInput.messages`.
- New Providers go in `provider/<name>.ts` and add their id to
  `PROVIDER_IDS`.
- `ToolCallRecord` is for the plugin's internal chat history only. It
  is not part of the Provider interface.

Provider adapter strategy:

- Gemini: reuse the existing plugin's tool definitions, but disable
  the SDK's automatic tool calling and let the plugin handle
  `functionCall` / `functionResponse` manually.
- OpenAI-compatible: lock MVP to `chat/completions`, converting
  Perfetto tools to `tools: [{type: "function"}]`.
- Anthropic: phase 2; convert to Claude tool use / tool result
  message format.
- Ollama: phase 2; the default local HTTP endpoint requires a CSP
  fork patch or a Tauri-side proxy.

### 4.4 MCP and Tool Adapter

The upstream `com.google.PerfettoMcp` already has `tracetools.ts` and
`uitools.ts`. The new plugin reuses or copies that registration logic
but normalizes the tool definitions into an internal format:

```ts
export interface PerfettoAiTool extends ToolDeclaration {
  call(input: unknown): Promise<unknown>;
}
```

The Provider then converts the internal format to the model's tool
representation. MCP, OpenAI function calling, and Anthropic tools share
the same Perfetto capabilities. The Provider receives only
`ToolDeclaration`. When the model returns a tool call, the AI plugin
layer looks up the executor in `Map<string, PerfettoAiTool>` by tool
name and calls `call()`.

Tool-call constraints:

- Default cap of 20 tool calls per turn.
- SQL query timeout and result row limit. The new plugin's SQL tool
  input schema is `{query, limit?}` with default `limit` 1000. The
  upstream `com.google.PerfettoMcp` schema is not modified.
- Tool errors are returned to the model as structured messages and
  shown in the UI.
- Tools that may leak large amounts of trace data require explicit
  confirmation or truncation.

## 5. Security and Configuration

API keys must not live in plain localStorage. Perfetto's
`app.settings` system stores everything in the `perfettoSettings`
localStorage blob, so the new plugin cannot use
`app.settings.register` for the API key. On desktop, the plugin's own
secret bridge calls into Tauri secure storage / the system keychain.
The Web fallback only uses in-memory state and explicitly tells the
user it is lost on refresh.

Minimal secret bridge interface:

```ts
export interface SecretBridge {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

The desktop implementation calls `invoke('secret_get')`,
`invoke('secret_set')`, and `invoke('secret_delete')`, which dispatch
to the chosen secret plugin. In Web mode the API key only lives in a
JS in-memory `Map` and is lost on refresh or tab close. If the user
has not entered an API key, the AI Chat entry is disabled with a
prompt.

The plugin selects its SecretBridge implementation at init time based
on `window.__PERFETTO_FORK__?.desktop`: `true` selects the Tauri
`invoke()`-backed desktop implementation; `false` or `undefined`
selects the in-memory `Map` Web fallback. Tauri
`initialization_script` injects the flag before the UI's JS runs, so
reading it inside `onActivate()` is reliable.

`secret_get`, `secret_set`, and `secret_delete` are fork-owned Rust
wrappers, not native commands of any secret plugin. They isolate the
front end from the chosen secret plugin:

```rust
#[tauri::command]
async fn secret_get(key: String) -> Result<Option<String>, String> {
    // Call the selected secret plugin.
}
```

Recommended decision: MVP wires up system secure storage immediately.
If implementation is blocked, fall back to in-session memory storage
short-term, but never persist API keys to localStorage and never
manage them through normal Perfetto settings. This avoids
post-release credential migration and exposure.

Network request policy:

- Only access the user-configured HTTPS Provider endpoint by default.
- Make Base URL changes visible in the settings UI.
- Log error codes and Provider names; never log full API keys.

Trace data may contain sensitive information. The AI plugin offers:

- A toggle for whether to send trace query results to the model.
- A maximum character count per tool result.
- A "Clear conversation" button.
- An explicit display of the current Provider state.

## 6. Key Technical Paths

### 6.1 Tauri Boot and UI Loading

The desktop app loads the Perfetto UI's static build output. Perfetto's
UI uses hash-based routes, so Tauri only needs a single entry HTML and
static asset access. No server-side routing is needed.

Things to verify in the implementation:

- JS, CSS, WASM, and worker resource paths under
  `third_party/perfetto/ui/out/dist` are reachable from Tauri.
- The CSP does not block WASM, workers, Provider API requests, or
  local resource loading. Perfetto's UI injects a meta CSP at runtime
  in `third_party/perfetto/ui/src/frontend/index.ts`; Tauri may also
  overlay its own CSP from `tauri.conf.json`. Multiple CSPs apply as
  the most restrictive intersection, not the union. The Tauri CSP
  must not be narrower than Perfetto's runtime meta CSP, unless the
  affected capability is removed by a corresponding patch under
  `patches/perfetto/`.
- Hash routes such as `#!/viewer` and `#!/aichat` survive refresh and
  window restore.
- Local trace paths are passed back to the UI through a Tauri command
  or file-open event.
- Versioned asset directories such as `dist/<version>/` are visible
  to Tauri's static asset server.

The desktop build needs to handle Service Worker. The Perfetto
production build registers `service_worker.js`, but Service Workers
may not work under Tauri's custom protocols and macOS WKWebView. MVP
recommends bypassing Service Worker registration via a fork-owned
runtime flag and treating any badge anomaly as an acceptance check
item. Unified runtime flag:

```ts
declare global {
  interface Window {
    __PERFETTO_FORK__?: {
      readonly desktop: boolean;
    };
  }
}
```

In Web builds, `window.__PERFETTO_FORK__` is `undefined`. All reads
must use optional chaining. Example Tauri `initialization_script`
injection:

```ts
window.__PERFETTO_FORK__ = Object.freeze({
  desktop: true,
});
```

The earlier draft also carried a `hideUpstreamMcp` flag, paired with
patch slot `0002-hide-upstream-mcp-when-fork-flag.patch`. Phase 1
verification (2026-05-08) showed upstream `com.google.PerfettoMcp`
works in the Tauri WKWebView, so the fork plugin coexists with it
instead of hiding it; the flag and the patch slot are both removed
(see §10 and §14).

The implementation lives as a patch file under `patches/perfetto/`
(e.g., `0001-bypass-sw-when-fork-flag.patch`), applied to
`third_party/perfetto/ui/src/frontend/index.ts` at setup time. The
patch gates `window.__PERFETTO_FORK__?.desktop` in front of the
`serviceWorkerController.install()` call. The Tauri
`initialization_script` injects the flag.

WASM needs separate verification on macOS WKWebView for two reasons:

1. **MIME and streaming**. WKWebView's MIME and streaming behaviour
   over custom protocols can affect
   `WebAssembly.instantiateStreaming`. If it fails, fall back to
   `arrayBuffer` instantiation and ensure the asset protocol returns
   `application/wasm`.
2. **Memory64**. As of 2026, WKWebView does not implement the WASM
   Memory64 proposal. Perfetto's `ui/run-dev-server` hardcodes
   `--only-wasm-memory64`, which produces only the 64-bit
   `trace_processor.wasm` and breaks the desktop app at load time
   ("Unable to load the 32-bit trace_processor.wasm. ... browser does
   NOT support Memory64"). The fork's `tauri.conf.json:beforeDevCommand`
   invokes `ui/build.js` directly without that flag, so build.js
   produces both the 32-bit and 64-bit variants and WKWebView auto-
   selects the 32-bit one. See §15 for the exact command.

3. **Live-reload watch loop**. Upstream `ui/build.js` in `--watch`
   mode self-triggers when fork-owned overlays are present: rollup or
   tsc periodically re-emits files inside `ui/out/dist/<version>/`,
   the `fs.watch` on `ui/out/dist/` fires the `notifyLiveServer` rule,
   the page reloads, and the cycle repeats roughly every 8–9 s. The
   page becomes unusable for testing. As a Phase 2 workaround,
   `tauri.conf.json:beforeDevCommand` drops the `--watch` flag — the
   trade-off is that source edits no longer trigger automatic
   rebuild; the developer runs `(cd third_party/perfetto && ./ui/build)`
   manually, then reloads the webview with `Cmd+R`. Root-cause fix
   (debounce notifyLiveServer on actual content change, or break the
   tsc/rollup spurious-reemit chain) is tracked as a Phase 2 follow-up.

### 6.2 Opening Trace Files

MVP supports two entry points:

1. In-app file picker.
2. Drag-and-drop onto the window.

The Tauri layer obtains the local file handle or path; the UI layer
keeps using the existing Perfetto trace-load flow. If passing the path
directly is not feasible, Tauri reads the file content and ships it to
the UI as a Blob or ArrayBuffer.

MVP minimal implementation:

- In-app file picker: use `tauri-plugin-dialog`.
- File reading: use `tauri-plugin-fs`, scoped to the user-selected
  trace file only.
- Drag-and-drop: Tauri 2 `WebviewWindow` drag/drop events.
- OS "Open With" and file association: phase-2 capability. If pulled
  into MVP, add `tauri.conf.json` bundle file association and the
  per-platform event handling.

### 6.3 LLM Tool-Call Loop

The Provider does not execute business logic; it only adapts the
model's protocol. The unified tool-call loop is driven by the AI
plugin layer. Gemini also goes through the same manual loop and does
not use `automaticFunctionCalling`:

```text
User message
  -> LlmProvider.sendMessage(messages, tools)
  -> model returns text and/or tool calls
  -> AI plugin validates tool call
  -> PerfettoAiTool.call(args)
  -> append tool result to messages
  -> continue until no tool call or maxToolCalls reached
```

Termination conditions:

- The model returns a final text with no tool call.
- `Max Tool Calls` is reached (default 20).
- A tool call fails with an unrecoverable error.
- The user stops manually. The Provider API must support `AbortSignal`
  or an equivalent cancellation mechanism. Stop sets a plugin-layer
  flag so the loop exits at its next iteration boundary; the
  in-progress tool call is not forcibly aborted unless that tool
  explicitly accepts `AbortSignal`.

Error handling:

- Argument validation failure: return a structured tool error to the
  model.
- SQL execution failure: return the error message and the SQL
  fragment.
- Result too large: truncate and mark `truncated: true`.
- SQL timeout: implemented as a plugin-layer timer that discards the
  result; the WASM worker is not forcibly terminated.
- Provider request failure: stop the current turn and show the
  Provider, status code, and a redacted error in the UI.

## 7. Build and Release

### 7.1 Development Commands

Bootstrap:

```sh
./scripts/bootstrap.sh   # host toolchain (one-time per machine: pnpm + rustup)
./scripts/setup.sh       # repo state (after clone or DEPS bump): Perfetto checkout + UI build deps
(cd desktop && pnpm install)
```

Inner loop:

```sh
(cd desktop && pnpm tauri dev)
```

`pnpm tauri dev` runs the dev server defined by
`tauri.conf.json:beforeDevCommand` (calling `ui/build.js` directly
rather than `ui/run-dev-server`; see §6.1 and §15) and launches the
Tauri shell against `devUrl`.

Checks:

```sh
(cd third_party/perfetto && ./ui/build --typecheck)
(cd third_party/perfetto && ./ui/run-unittests)
```

Packaging:

```sh
(cd third_party/perfetto && ./ui/build)
(cd desktop && pnpm tauri build)
```

The dev loop pins `--serve-port 10000`. Without it,
`ui/run-dev-server` would increment the port when 10000 is in use and
break Tauri's `devUrl`.

### 7.2 CI Suggestions

CI should at least include:

- UI TypeScript typecheck.
- AI Provider adapter unit tests.
- Plugin unit tests.
- Tauri build smoke test.
- Weekly upstream sync dry-run.

### 7.3 Release Artifacts

Phase 1 target:

- macOS Apple Silicon arm64: `.dmg` or `.app`

Phase 2 expansion:

- macOS Intel/Universal
- Windows: `.msi` or `.exe`
- Linux: `.AppImage` or `.deb`

Signing, notarization, and auto-update are phase-2 deliveries or
dedicated tracks.

## 8. MVP Acceptance Criteria

MVP picks macOS as the first launch target; Windows/Linux directories
and configuration are kept in place to not block later expansion.

Must-haves:

- The desktop app starts via Tauri and loads the Perfetto UI.
- The user can open a local trace and do basic browsing.
- After a trace loads, the AI Chat entry appears in the sidebar.
- Gemini and the OpenAI-compatible Provider each complete at least
  one tool call.
- API keys are not persisted in localStorage.
- Desktop mode bypasses or correctly handles Service Worker
  registration.
- WASM, workers, and the versioned asset directory load under Tauri.
- Per-turn tool-call cap, SQL result size, and error messages are
  controlled.
- Reaching `Max Tool Calls` halts the loop and tells the user why.
- Tool errors do not put the loop into an infinite spin.
- Stop interrupts an in-flight Provider request via `AbortSignal` (or
  an equivalent mechanism). If a tool is currently executing, the
  loop stops at its next iteration boundary.
- `com.google.PerfettoMcp` (upstream Gemini chat) coexists with the
  fork-owned plugin's chat entry; menu labels disambiguate them.
- `(cd third_party/perfetto && ./ui/build --typecheck)` and
  `(cd third_party/perfetto && ./ui/run-unittests)` pass.
- macOS Apple Silicon arm64 produces a runnable installer or `.app`.

Not required yet:

- Production Windows/Linux installers.
- Auto-update.
- Code signing and notarization.
- Bundled `trace_processor_shell` sidecar.
- Enterprise unified model gateway.

## 9. Upstream Sync Strategy

This repo is not a git fork of google/perfetto. Upstream is treated as
a build dependency: pinned by SHA in `DEPS`, fetched into
`third_party/perfetto/` (gitignored) by `scripts/setup.sh`. Upstream
source never enters this repo's git history.

Bumping the upstream pin:

```sh
./scripts/update-perfetto.sh <new-sha>     # or: latest

(cd third_party/perfetto && ./ui/build --typecheck)
(cd third_party/perfetto && ./ui/run-unittests)
(cd desktop && pnpm tauri build)

git add DEPS
git commit -m "deps: bump perfetto to <sha>"
```

`update-perfetto.sh` writes the new SHA into `DEPS`, then re-runs
`setup.sh`, which re-applies any patches and resyncs the overlay. If
a patch fails, the script aborts before the build, so upstream drift
surfaces at setup, not at build.

Constraints:

- Fork-owned source lives only in `desktop/`, `ui-overlay/`,
  `patches/`, `scripts/`, and `docs/`.
- Upstream Perfetto source is never modified in this repo's git
  history. Modifications happen as `.patch` files under
  `patches/perfetto/` and are applied at setup time.
- `apply-patches.sh` fails loudly when a patch no longer applies, so
  upstream drift is caught at setup, not at build.
- Fork-owned plugins live in `ui-overlay/plugins/<name>/` and are
  rsync'd into `third_party/perfetto/ui/src/plugins/<name>/` at setup
  time. They participate in Perfetto's plugin auto-discovery the same
  way upstream plugins do.
- Upstream's generated `Android.bp` and Bazel files are never
  hand-maintained in this repo; the Perfetto build system runs
  entirely inside `third_party/perfetto/`.

## 10. Phased Plan

### Phase 1: MVP

- Stand up the `desktop/` Tauri project.
- Get Perfetto UI's static assets loading (incl. WKWebView 32-bit
  WASM workaround for the Memory64 incompatibility, see §6.1).
- Bypass or align with Service Worker in the desktop build.
- Verify upstream `com.google.PerfettoMcp` works in the Tauri shell
  for users who supply a Gemini API key. Coexist with it; do not
  hide.

Acceptance:

- The desktop app opens locally.
- WASM, workers, and the versioned asset directory load under Tauri.
- `(cd third_party/perfetto && ./ui/build --typecheck)` passes.
- macOS desktop artifact runs.
- Upstream `com.google.PerfettoMcp` plugin activates after trace
  load, AI Chat menu appears, Gemini API call round-trips end-to-end
  (CSP, fetch streaming, SDK chain all verified in WKWebView on
  2026-05-08).

Phase 1 finding: the original plan to hide `com.google.PerfettoMcp`
and re-implement Gemini support inside the fork plugin is dropped.
Upstream works; the fork plugin stays out of the Gemini path entirely
and focuses on Providers upstream does not cover (see Phase 2).

### Phase 2: Productization

- Add the fork-owned `com.tooluselabs.PerfettoDesktop` plugin with a
  parallel AI Chat entry, providing Providers that upstream
  `com.google.PerfettoMcp` does not cover.
- Provider priority order:
  1. **DeepSeek and ZAI (Zhipu/GLM)** as the primary cut, both via
     a single OpenAI-compatible Provider with a configurable base
     URL. The same Provider class covers a wide ecosystem at zero
     extra implementation cost: Kimi (Moonshot), MiniMax, Qwen
     (Alibaba DashScope), Doubao (Volcano Ark), OpenAI itself, local
     Ollama / LM Studio / vLLM, and aggregator gateways such as
     OpenRouter. The Settings UI ships a preset list (DeepSeek, ZAI,
     Kimi, MiniMax, Qwen, Doubao, OpenAI, Ollama, "Custom") plus a
     free-form base URL field.
  2. **Anthropic (Claude)** as a deferred follow-up. Claude Messages
     API has its own protocol (different endpoint, header auth,
     content-block message shape, distinct tool-use schema), so it
     needs a separate Provider class using `@anthropic-ai/sdk`. Not
     blocking Phase 2 acceptance; users who specifically want Claude
     can either wait, use a translating gateway through the
     OpenAI-compat Provider, or use perfetto-mcp-rs from inside
     Claude Code.
- Provider abstraction implements the manual tool-call loop per §6.3
  (Gemini's `automaticFunctionCalling` is not used).
- Settings page for Provider selection, base URL, API key, model,
  system prompt.
- Prefer system secure storage for API keys. If blocked, fall back
  to in-session memory; never localStorage.
- Tool-call result truncation, error diagnostics, retries.
- Cross-platform CI: Linux / Windows runners producing installers.
- Provider adapter unit tests.

Acceptance:

- DeepSeek and ZAI Providers each complete a tool call.
- Tool-call failures show a clear UI error.
- At least one platform beyond macOS produces a runnable installer.

Anthropic Provider is a stretch goal; ship it when the OpenAI-compat
path is stable.

For users who do not need the desktop GUI and just want their MCP
client (Claude Code, Codex, Cursor, Claude Desktop) to analyze a
trace file headlessly, [`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
is the recommended companion. It is a standalone Rust binary that
wraps `trace_processor_shell` and exposes PerfettoSQL plus
domain-specific Chrome tools over stdio MCP. Perfetto Desktop and
perfetto-mcp-rs are complementary, not competing: Perfetto Desktop
gives you the GUI and in-app chat; perfetto-mcp-rs gives you headless
trace tools wired into your existing agent.

### Phase 3: Long-term Maintenance

- Auto-update.
- Upstream sync CI.
- Evaluate bundling `trace_processor_shell` as a sidecar.
- Evaluate evolving toward a standalone AI Gateway.

### Schedule and Dependencies

A 6-week schedule from kickoff to MVP:

| Week | Work | Main Dependencies |
| --- | --- | --- |
| 1 | Tauri project skeleton, UI static asset loading, macOS dev startup | Rust/Tauri toolchain |
| 2 | Local trace open path, AI plugin entry, settings page | Perfetto UI trace-load API |
| 3-4 | Provider abstraction, Gemini/OpenAI-compatible, tool-call loop | Model API keys and test accounts |
| 5 | Secure storage, error handling, result truncation, unit tests | Tauri secure storage plugin |
| 6 | macOS packaging, CI smoke tests, review fixes | Build machine, optional signing certs |

Roles:

- 1 frontend / Perfetto UI engineer.
- 1 Tauri/Rust engineer (can be part-time).
- 1 AI Provider / tool-call loop engineer (can merge with the
  frontend role).

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Frequent upstream UI churn | Merge conflicts | Keep fork code in new directories; minimize core-file patches |
| Differing LLM tool-calling formats | Provider adapters get complex | Use the internal `PerfettoAiTool` abstraction to unify tool definitions |
| Some models lack tool calling | Feature gaps | Degrade to SQL generation and explanation mode |
| Trace data is sensitive | Compliance risk | Add a send toggle, truncation, "Clear conversation", and Provider visibility |
| Tauri cross-platform diffs | Packaging failure | Single-platform MVP first; expand the CI matrix later |
| API key leak | Security risk | Use system secure storage; redact in logs |
| Service Worker fails under Tauri | Cache and status anomalies | Bypass registration in desktop; verify the badge state |
| WKWebView WASM streaming incompatibility | Trace processor cannot start | Validate MIME; fall back to arrayBuffer instantiation |
| Ollama local HTTP blocked by CSP | Local models unusable | Not in MVP; phase 2 via CSP patch or Tauri proxy |
| Missing Tauri capabilities | IPC, file open, or secret storage broken | Add the minimal capability set and cover via smoke test |
| macOS Gatekeeper blocks unsigned apps | MVP demo cannot launch | Provide right-click instructions; signing and notarization in phase 2 |

## 12. Decisions and Recommendations

| Decision | Recommendation | Reason |
| --- | --- | --- |
| Plugin namespace | `com.tooluselabs.PerfettoDesktop` | Isolated from upstream `com.google.*` |
| MVP Providers | Gemini + HTTPS OpenAI-compatible `chat/completions` | Covers existing capability and the mainstream-compatible ecosystem; avoids local-HTTP CSP risk |
| API key storage | System secure storage in MVP; in-session memory only if blocked | Avoid post-release credential migration and exposure |
| Trace data send | Tool results allowed by default but size-limited and Provider visible | Keep functionality usable while reducing accidental leaks |
| Launch platform | macOS | Lowest validation cost; good fit for getting the chain running |
| Sidecar | No `trace_processor_shell` bundled in MVP | Lower cross-platform and signing complexity |
| Upstream sync | Weekly sync; one designated owner handles conflicts post-MVP | Avoid long divergence |
| Auto-update | Phase 2; depends on code signing being in place | Validate the core product loop in v1 |
| Service Worker | Bypass registration in desktop MVP | Lower Tauri custom-protocol compatibility risk |
| Secret storage plugin | Pick one of `tauri-plugin-keyring` and `tauri-plugin-stronghold` at review time | Different cross-platform behaviour and operational cost |

## 13. Recommended Decision

Adopt this plan as the v1 architecture: a Tauri desktop shell, a
standalone AI plugin, multi-LLM via the Provider abstraction, with
fork-owned code constrained to clear directories. The plan balances
delivery speed, extensibility, and upstream sync cost. It is a sound
base for a long-term fork.

## 14. Code Change List

Expected new files in this lean repo (relative to repo root):

```text
desktop/
  package.json
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/
      default.json
    src/main.rs

ui-overlay/plugins/com.tooluselabs.PerfettoDesktop/
  index.ts
  chat_page.ts
  settings.ts
  styles.scss
  provider/
    types.ts
    gemini.ts
    openai_compatible.ts
  mcp/
    server.ts
    tool_adapter.ts
  test/
```

Minimal `desktop/package.json` draft:

```json
{
  "private": true,
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-fs": "^2"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

Tauri front-end packages and Rust crates must stay on compatible major
versions. The chosen secret plugin package is added after the §12
decision lands.

Plugin auto-registration: when `scripts/sync-overlay.sh` rsyncs
`ui-overlay/plugins/<name>/` into
`third_party/perfetto/ui/src/plugins/<name>/`, Perfetto's
`ui/build.js` scans `ui/src/plugins/*/index.ts` at the next build and
emits `ui/src/gen/all_plugins.ts`, picking up the overlay automatically.
No upstream patch is needed for plugin registration.

Patches against upstream Perfetto live as files under
`patches/perfetto/`. Each patch is generated with `git format-patch`
or `git diff` against the pinned SHA. When two patches touch nearby
lines in the same upstream file, generate them with one line of context
(`git format-patch -U1` or `git diff -U1`) so one patch does not claim
the other patch's insertion as context. This is the default convention
for `defaultPlugins` edits. Expected patch slots:

| Patch | Purpose | Required? |
| --- | --- | --- |
| `0001-bypass-sw-when-fork-flag.patch` | Gate `serviceWorkerController.install()` on `window.__PERFETTO_FORK__?.desktop` | Conditional: only if Tauri's WebView rejects Perfetto's SW (Phase 1 verification: WKWebView already skips SW registration via the user-disabled path, so this patch has not been required) |
| `0002-default-enable-perfetto-mcp.patch` | Append `'com.google.PerfettoMcp'` to upstream's `defaultPlugins` allowlist in `ui/src/core/embedder/default_plugins.ts` | **Landed 2026-05-08.** First-run users get upstream's AI Chat (Gemini) directly after a trace loads, without manually toggling the plugin. Honors any later user toggle (the array only seeds the feature flag default). |
| `0003-strip-analytics-from-csp.patch` | Conditionally remove Google Analytics/GTM sources from runtime meta CSP in desktop mode | Optional; depends on §15 CSP option chosen |
| `0004-default-enable-fork-plugin.patch` | Append `'com.tooluselabs.PerfettoDesktop'` to the same `defaultPlugins` allowlist | **Landed 2026-05-08.** Mirrors 0002's UX rationale for the fork-owned plugin: first-run users see the `Multi-LLM Chat` menu directly. Hunk position is anchored on lines 0002 already inserted, so 0004 must apply *after* 0002; `apply-patches.sh` runs them in lexicographic order which gives the right ordering naturally. |

Slot `0002-default-enable-perfetto-mcp.patch` previously documented a
different intent (filter `com.google.PerfettoMcp` out of plugin
registration when the fork plugin shipped its own Gemini path). After
Phase 1's verification that upstream MCP works cleanly in the Tauri
WKWebView, the fork plugin coexists with upstream instead of hiding
it (see §10), so the slot was repurposed to default-enable upstream
MCP for first-run users.

`scripts/apply-patches.sh` is idempotent: it skips a patch if
`git apply --reverse --check` succeeds (i.e., the patch is already
applied), and only forward-applies otherwise. Re-running `setup.sh`
on an already-pinned, already-patched checkout is a no-op.

Phase 1 expects zero patches. Each patch only lands when its trigger
is verified empirically.

Principles:

- This repo never modifies upstream Perfetto in git history.
- Upstream-affecting changes go through `patches/perfetto/`, not
  through direct edits to `third_party/perfetto/` (those edits are
  ephemeral and overwritten by `setup.sh`).
- Generated `Android.bp` and Bazel files are never hand-maintained.

## 15. Tauri Configuration Draft

The Tauri project consumes the Perfetto UI's build output as the
front-end asset. Configuration sketch:

```json
{
  "build": {
    "beforeBuildCommand": "cd ../third_party/perfetto && ./ui/build",
    "beforeDevCommand": "cd ../third_party/perfetto && ./ui/node ./ui/build.js --serve --serve-port 10000",
    "devUrl": "http://localhost:10000",
    "frontendDist": "../../third_party/perfetto/ui/out/dist"
  },
  "productName": "Perfetto Desktop",
  "version": "0.1.0",
  "identifier": "com.tooluselabs.perfetto.desktop",
  "app": {
    "security": {
      "csp": "default-src 'self'; connect-src 'self' https: blob: data: ws://127.0.0.1:8037 http://127.0.0.1:9001 ws://127.0.0.1:9001; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;"
    },
    "windows": [
      {
        "title": "Perfetto Desktop",
        "width": 1440,
        "height": 960
      }
    ]
  }
}
```

The `beforeDevCommand` invokes `ui/build.js` directly rather than
`ui/run-dev-server` because the wrapper script hardcodes
`--only-wasm-memory64` and macOS WKWebView cannot load Memory64
WASM. See §6.1. `beforeBuildCommand` keeps `./ui/build` because that
script does not pass the flag.

`frontendDist` is resolved relative to `tauri.conf.json` (i.e., from
`desktop/src-tauri/`), which is why it carries two leading `../`.

The CSP example above corresponds to the "simplify Perfetto runtime
CSP" option, implemented as
`patches/perfetto/0003-strip-analytics-from-csp.patch` applied to
`third_party/perfetto/ui/src/frontend/index.ts` at setup time.

Tauri 2 requires explicit capabilities for the front end to call IPC,
dialog, fs, and secret storage. Minimum capability draft:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Main window permissions for Perfetto Desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "fs:default",
    "<secret-plugin>:default"
  ]
}
```

The secret storage plugin is picked at MVP review time:

| Option | Description | Trade-off |
| --- | --- | --- |
| `tauri-plugin-keyring` | System keychain / credential vault / libsecret | Recommended for first evaluation; more native UX, cross-platform diffs need verification |
| `tauri-plugin-stronghold` | Encrypted local vault | More uniform behaviour; needs vault init and passphrase policy |

If `app.security.csp` is customized, confirm Tauri's IPC origin is
not blocked. Tauri 2 normally injects the IPC origin into the CSP,
but with a custom CSP the smoke test must verify
`invoke('secret_get')`, `invoke('secret_set')`, dialog, and fs
commands work. The capability must allow the fork-owned wrapper
commands and the chosen secret plugin's permissions.

The CSP strategy is also a three-way choice at MVP time:

| Option | Description | Trade-off |
| --- | --- | --- |
| Simplify the Perfetto runtime CSP | Fork patch out the Google Analytics/GTM sources not needed on desktop, then align Tauri CSP | Most controllable; small ongoing patch |
| Tauri CSP supersets the runtime CSP | Mirror the `script-src`, hashes, and connect sources from Perfetto's meta CSP | Less UI churn; more drift risk as upstream changes |
| Do not override Tauri CSP | Leave `app.security.csp` unset; use Tauri's default and let the runtime meta CSP be the primary policy | Easiest to debug; verify the current Tauri version permits this and meets security requirements |

Permissions and capabilities to verify:

- File open: read user-selected trace files only.
- Network: MVP allows the user-configured HTTPS Provider endpoint.
- Secure storage: enable platform capabilities (keychain / credential
  vault / libsecret).
- CSP: allow WASM, workers, and Provider requests required by the
  Perfetto UI.

MVP does not open arbitrary file system access, does not open shell
execution, and does not enable a sidecar by default.

## 16. Provider Compatibility Matrix

| Provider | Protocol/SDK | Tool calling | Streaming | MVP | Note |
| --- | --- | --- | --- | --- | --- |
| Gemini | `@google/genai` | Yes, manual loop | Phase 2 | Yes | Reuse tool-definition experience; do not reuse the auto-call path |
| OpenAI-compatible | HTTPS `chat/completions` | Model-dependent | Phase 2 | Yes | Covers OpenAI, DeepSeek, Qwen, vLLM, etc., HTTPS endpoints |
| Anthropic | HTTPS Messages API | Yes | Phase 2 | No | Phase 2 |
| Ollama | OpenAI-compatible or native API | Model-dependent | Phase 2 | No | Local HTTP needs a CSP patch or Tauri proxy |

MVP does not require streaming. Stabilize the tool-call loop, error
handling, and result rendering first.

## 17. Tool Protocol and Data Limits

Tool definitions are owned by the internal `PerfettoAiTool`; Provider
adapters do the protocol conversion. MVP does not require replicating
the `com.google.PerfettoMcp` MCP server/client topology. A direct
`Map<string, PerfettoAiTool>` is fine. Example:

```ts
const sqlTool: PerfettoAiTool = {
  name: 'perfetto-execute-query',
  description: 'Run a Perfetto SQL query.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {type: 'string'},
      limit: {type: 'integer', default: 1000},
    },
    required: ['query'],
  },
  async call(input) {
    // Validate input, run SQL, return structured JSON.
  },
};
```

- Reuse the JSON Schema path the MCP SDK provides; MVP avoids adding
  `zod-to-json-schema`. Add a converter only if a real gap appears.
- Convert JSON Schema to OpenAI / Anthropic / Gemini tool
  declarations.
- Tool results are uniformly serialized as JSON text.
- Tool results are carried in `ChatMessage` as JSON strings; the
  plugin parses on demand for rendering.
- Convert `bigint` to string to avoid JSON precision loss.
- Binary/blob data is never sent to the model; return a summary or
  error instead.

Default limits:

| Item | Default |
| --- | --- |
| Max tool calls per turn | 20 |
| Max rows per SQL query | 1000, overridable via the tool's `limit` input |
| Max characters per tool result | 64 KiB |
| Provider request timeout | 60 seconds |
| SQL query timeout | 30 seconds; plugin-layer timer discards the result, does not force-terminate WASM |

Suggested SQL tool result format:

```json
{
  "columns": ["ts", "dur", "name"],
  "rows": [["123", "456", "slice"]],
  "rowCount": 1,
  "truncated": false
}
```

Suggested failure format:

```json
{
  "error": {
    "type": "SqlError",
    "message": "no such table: foo",
    "recoverable": true
  }
}
```

## 18. Plugin Enablement Strategy

MVP enables `com.tooluselabs.PerfettoDesktop` by default in the fork
desktop build. The Web build keeps it available but does not surface
sensitive configuration entries by default.

Relationship with `com.google.PerfettoMcp`:

- Do not delete the upstream plugin.
- Do not reuse the `com.google.*` namespace.
- Both plugins coexist in the desktop build. Phase 1 verification
  (2026-05-08) confirmed upstream `com.google.PerfettoMcp` activates
  cleanly in the Tauri WKWebView and the Gemini SDK chain works
  end-to-end; users with a Gemini API key get the upstream AI Chat
  for free.
- The fork-owned plugin owns its own AI Chat entry with non-Gemini
  Providers (Phase 2 priority: DeepSeek + ZAI via OpenAI-compat,
  Anthropic deferred). Menu labels disambiguate the two entries —
  e.g., upstream's `AI Chat` (Gemini-only, on `current_trace`
  section) and the fork's `Multi-LLM Chat` (or similar).

## 19. Test Plan

Provider adapter and tool-call loop unit tests run inside the
existing `ui/` Jest test setup. The Tauri smoke test is a manual
checklist for MVP and gets automated later.

Unit tests:

- Provider adapter: tool declaration conversion, tool result
  conversion, error conversion. The OpenAI-compatible adapter mocks
  `fetch` directly; the Gemini adapter uses a Jest module mock to
  replace the SDK client.
- Tool-call loop: multi-turn calls, hitting the cap, tool failure,
  user abort.
- Settings parsing: Provider, Base URL, Model, missing API key.

Integration tests:

- Use a fake LLM that returns a fixed tool call to verify execution
  and result roundtrip.
- Use a small trace file to verify the SQL query tool.
- Verify no-network, 401, 429, timeout, and malformed tool calls from
  the Provider.
- Verify halting at `Max Tool Calls`, no infinite loop on tool
  errors, and Stop interrupting the request.

Desktop smoke test:

- Tauri dev mode loads the UI.
- The packaged artifact starts up.
- Local trace can open.
- The AI Chat page is reachable.
- API keys never appear in normal logs or localStorage; an automated
  assertion checks `localStorage.getItem('perfettoSettings')` does
  not contain a test key fragment.
- Secret bridge round-trip: `invoke('secret_set')` followed by
  `invoke('secret_get')` returns the same value, and the value
  survives an app restart. Uninstall behaviour follows the chosen
  secret plugin's documented policy.
- Service Worker is bypassed (or in a normal state) in desktop mode.
- WASM, workers, and the `dist/<version>/` versioned assets load.
- The Tauri capability set covers dialog, fs, and secret storage.

Large-file test:

- Use at least one trace in the hundreds-of-megabytes range to
  validate the open flow.
- Verify tool-result truncation does not freeze the UI.

## 20. Diagnostics and Logging

The desktop build provides basic diagnostics:

- An About page or diagnostics panel showing app version, upstream
  commit, and build time.
- Provider request failures show Provider, status code, error type,
  and a redacted message.
- On secret write failure, prompt the user to authorize the keychain
  or suggest switching to stronghold; never silently drop the API
  key.
- Tool-call history is collapsible but defaults to collapsed.
- Logging never records API keys or full Authorization headers.
- An "Export diagnostics" capability bundles a config summary, version
  info, and recent errors. It does not include trace data or secrets.

Suggested log layers:

| Type | Content |
| --- | --- |
| UI log | Page errors, plugin errors, tool-call state |
| Provider log | endpoint host, status code, latency, error type |
| Tauri log | Startup, file open, storage read/write failure |

## 21. Upstream Drift Checklist

After every DEPS bump, run `./scripts/setup.sh` and verify:

- `apply-patches.sh` still applies all patches cleanly. If any patch
  fails, rebase it against the new SHA before bumping.
- `sync-overlay.sh` lands the overlay at the expected paths.
- The overlay plugin is still registered (visible in
  `third_party/perfetto/ui/src/gen/all_plugins.ts` after build).
- `(cd third_party/perfetto && ./ui/build --typecheck)` passes.
- `(cd third_party/perfetto && ./ui/run-unittests)` passes.
- `com.google.PerfettoMcp` has no reusable tool updates worth
  porting.
- `third_party/perfetto/ui/out/dist`'s structure (especially
  `dist/<version>/`) is unchanged or accommodated by the Tauri
  config.
- The Service Worker bypass behaves the same after the new build.
- The CSP in `third_party/perfetto/ui/src/frontend/index.ts` has not
  changed in a way that affects Provider endpoints.
- Tauri 2 plugin or capability schema changes have not introduced
  breakage.

If upstream changes the lines a patch depends on, the patch will fail
loudly at setup. Prefer adapting the overlay plugin or updating the
patch context, in that order. Never edit `third_party/perfetto/`
directly; those edits are erased by the next setup run.
