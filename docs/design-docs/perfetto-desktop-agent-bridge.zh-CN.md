# Perfetto Desktop Agent Bridge / MCP 方案

## 1. 背景

Perfetto upstream 已经有 `com.google.PerfettoMcp` 插件，能通过 Gemini 调用
Perfetto trace tools 和有限的 UI tools，例如运行 PerfettoSQL、打开 SQL 结果页、
pan/zoom timeline、选中 SQL event。Perfetto Desktop 原先计划新增
Multi-LLM Chat，把 DeepSeek、ZAI 等 Provider 直接集成到 app 内。

新的判断是：Perfetto Desktop 不应该再维护一个完整的多模型聊天入口。更好的
方向是把 Perfetto Desktop 暴露成一个受控的本地 MCP server，让 Codex、Claude
Code 等外部 agent 使用用户已有订阅来分析 trace 和驱动 Perfetto UI。

这个方案把 Perfetto Desktop 的职责收敛为：持有 trace、执行 Perfetto API、
管理本地权限边界。模型选择、账号登录、上下文策略和自然语言交互交给外部 agent。

## 2. 与 upstream PerfettoMcp 的关系

`com.google.PerfettoMcp` 继续作为 upstream Gemini **AI Chat** 入口存在。Phase B
期间 sidebar 可以同时出现 upstream **AI Chat** 和 fork-owned **Agent Bridge**；
Phase D 再评估是否合并信息架构。

Agent Bridge 不直接复用 upstream `registerTraceTools()` / `registerUiTools()` 的
`McpServer` 实例。原因：

- Agent Bridge 需要 HTTP transport、连接授权、capability gating 和 audit log。
- SQL tool 需要执行前限制、timeout、字节预算和结构化 truncation metadata。
- 外部 agent 的 tool 命名和返回 schema 需要保持长期稳定，不应被 upstream 内部实现
  直接牵动。

实现上可以复用 upstream 的 public Perfetto API 用法，例如
`trace.timeline.panSpanIntoView(...)` 和 `trace.selection.selectSqlEvent(...)`。
但 fork 维护自己的 tool registry，并在文档中列出与 upstream 工具的映射。

工具命名统一使用 MCP 社区常见的 kebab-case，并加 `perfetto-` 前缀，避免与其他
MCP server 冲突：

| Agent Bridge tool | 对应 upstream tool | 说明 |
| --- | --- | --- |
| `perfetto-get-trace-info` | 无 | 当前 trace metadata 和能力 |
| `perfetto-list-tables` | `perfetto-list-interesting-tables` | 表/视图列表 |
| `perfetto-describe-table` | `perfetto-list-table-structure` | 表结构 |
| `perfetto-query-sql` | `perfetto-execute-query` | 受限 SQL 查询 |
| `perfetto-show-sql-view` | `show-perfetto-sql-view` | 打开 Query Page tab |
| `perfetto-show-timeline` | `show-timeline` | timeline pan/zoom |
| `perfetto-select-event` | `show-timeline` 的 `focus` 参数 | 选择 SQL event |
| `perfetto-get-current-selection` | 无 | 读取当前 selection |

## 3. 目标与非目标

### 目标

- 在 Perfetto Desktop 内置一个默认关闭的本地 Agent Bridge。
- Bridge 启用后启动 loopback MCP server，例如 `127.0.0.1:38471`。
- UI 默认显示一次性连接命令，用户将其粘贴到 Codex 或 Claude Code 的 CLI 中。
- 可选提供持久配置命令，但不把一次性授权写入长期 MCP 配置。
- 通过 MCP tools 暴露 trace 查询和受控 UI 操作。
- 不让 Perfetto Desktop 保存 Codex、Claude、OpenAI、Anthropic 等模型账号凭据。
- 每次连接都需要用户在 Desktop 内确认，且权限按 capability 分层。

### 非目标

- 不在 Perfetto Desktop 中嵌入完整 shell/terminal。
- 不由 Codex/Claude Code 自动启动 GUI app。
- 不模拟鼠标键盘点击来控制 UI。
- 不开放任意文件系统、任意命令执行或任意网络访问。
- 不在第一版实现远程多人协作、云端 agent gateway 或长期后台 daemon。
- 不继续实现 fork-owned Multi-LLM Chat Provider 面板。
- 不向远端上报 audit log。
- 不排斥内置 MCP 自检客户端用于诊断；自检客户端不接 LLM、不管理 agent CLI、不提供聊天入口。

## 4. 总体架构

```text
Codex / Claude Code / other MCP host
        |
        | Streamable HTTP MCP over loopback
        v
Tauri Rust HTTP edge (auth + MCP framing)
        |
        | JSON-RPC envelope bridge
        v
Perfetto Desktop WebView plugin
        |
        | Perfetto public plugin APIs
        v
Trace engine / Query Page / Timeline / Selection
```

Rust/Tauri 层持有本地 HTTP server、端口、连接授权和生命周期，只负责 MCP
JSON-RPC framing、鉴权和 envelope 路由，不实现 Perfetto 语义。WebView/plugin 层持有
当前 `Trace`，实现具体 tools。Codex 或 Claude Code 是 MCP host，通过用户复制的
一次性命令连接到 Desktop。持久 MCP 配置是高级选项，不是默认路径。

推荐 transport 是 HTTP MCP，而不是 stdio MCP。stdio MCP 通常要求 host 启动
server 进程；本方案中 server 已经由 GUI app 启动，所以外部 agent 只需要连接。

## 5. 启动、连接和状态机

### 5.1 连接流程

1. 用户打开 Perfetto Desktop。
2. 用户加载 trace。
3. 用户打开 `Agent Bridge` 面板并点击 `Enable`。
4. Desktop 绑定 `127.0.0.1` 端口。
   - MVP 优先使用固定默认端口 `38471`，降低 MCP host 配置成本。
   - 如果固定端口冲突，Desktop 回退到 OS-assigned ephemeral port，并只显示
     一次性命令。
   - Bridge 是 per-window；多窗口下后启用的窗口使用 fallback port，并在 UI 中标明。
5. Desktop 显示连接状态和复制按钮。默认复制 header-capable 的一次性命令模板，
   具体语法需随目标 CLI 实测更新，例如：

   ```sh
   claude --strict-mcp-config --mcp-config '{"mcpServers":{"perfetto-desktop":{"type":"http","url":"http://127.0.0.1:38471/mcp","headers":{"Authorization":"Bearer <session-secret>"}}}}'

   codex -c 'mcp_servers.perfetto_desktop.url="http://127.0.0.1:38471/mcp"' \
     -c 'mcp_servers.perfetto_desktop.headers.Authorization="Bearer <session-secret>"'
   ```

6. 用户把命令粘贴到 Codex/Claude Code CLI。该连接只服务于当前 agent session；
   不要求用户写入全局 MCP 配置。
7. agent 连接时 Desktop 进入 `Pending Authorization` 并弹出确认。
8. 用户选择权限档位：
   - `Read Trace`: 只允许查询和读取上下文。
   - `Drive UI`: 允许打开 SQL view、跳转 timeline、选中 event。
9. 连接断开、trace unload 或用户点击 `Disable` 后，当前授权失效。

连接命令只作为 UI 输出。最终命令格式以对应 CLI 的当前 MCP 配置语法为准，Desktop
实现时需要根据 Codex/Claude Code 的官方文档更新模板。当前设计假设：

- Claude Code 支持 `--mcp-config` 和 `--strict-mcp-config`，适合一次性连接；是否支持
  HTTP MCP `headers` 字段需要在目标版本实测。
- Codex 支持 `-c/--config` runtime override；是否能稳定覆盖 nested
  `mcp_servers.<name>.url` 和 header 配置需要在实现时用目标版本实测。
- 如果 Codex runtime override 不稳定，Desktop 可以生成临时 config 目录命令，
  例如 `CODEX_HOME=<temp-dir> codex ...`，或退回持久配置 + Desktop 内授权。
- Phase B 开工前先做 CLI capability matrix：Claude Code、Codex、Cursor/generic
  JSON 是否支持 HTTP MCP headers。支持 header 的 host 默认使用 Bearer；不支持的
  host 只能走 degraded fallback，并在 Desktop 确认弹窗中明确提示风险。

持久配置命令可以作为可选按钮提供，例如：

```sh
codex mcp add perfetto-desktop --url http://127.0.0.1:38471/mcp
claude mcp add --transport http perfetto-desktop http://127.0.0.1:38471/mcp
```

持久配置 URL 不应包含一次性授权。安全边界仍由 Desktop 的 Enable/Disable、
连接确认和 per-trace capability 授权控制。

Phase B 默认只提供复制命令，不自动调起 shell 或启动 `claude` / `codex` 进程。
`Open Terminal + Copy Command` 可以作为 Phase C/D 的 QoL 候选，但必须默认不自动执行
命令；若未来支持自动执行，需要二次确认并明确提示 session secret 和 shell history 风险。

### 5.2 状态机

```text
Disabled
  | Enable
  v
Listening
  | agent handshake
  v
Pending Authorization
  | allow                         | deny
  v                               v
Connected --------------------> Listening
  | agent disconnect / revoke
  v
Listening

* -> Disabled  (Disable / trace unload)
* -> Error     (port bind failure / bridge panic / protocol error)
```

状态含义：

- `Disabled`: 不监听任何端口。
- `Listening`: HTTP server 已启动，但没有已授权 client。
- `Pending Authorization`: 有 client 连接，等待用户确认。
- `Connected`: 至少一个 client 已授权。MVP 限定单连接；第二个连接进入 pending 或拒绝。
- `Error`: 端口绑定失败、bridge 内部错误或不可恢复协议错误。

## 6. 权限与安全模型

Agent Bridge 必须默认关闭，并且只绑定 loopback 地址。禁止监听 `0.0.0.0`。一次性
连接不依赖把 token 写进 MCP host 的长期配置。若目标 host 支持 headers，当前
session secret 只存在于 Desktop 内存和一次性命令中。Desktop 维护当前 session 的连接
allowlist：只有用户在 Desktop 中确认过的 MCP client 才能调用 tools。授权信息不写入
repo，不进入 trace，不持久化到 `localStorage`。

### 6.1 HTTP 防护

MVP 必须实现以下防护：

- Host allowlist：只接受 `Host: 127.0.0.1:<port>` 或 `Host: localhost:<port>`。
  其他 Host 拒绝，降低 DNS rebinding 风险。
- Origin 防护：拒绝带浏览器 `http://` / `https://` Origin 的请求。CLI client 通常
  不带 Origin；浏览器请求会带 Origin。
- Fetch metadata 防护：如果存在 `Sec-Fetch-Site: cross-site`，直接拒绝。
- 禁止 query-string token 作为主认证方式。URL token 容易进入 shell history、日志和
  MCP host 持久配置。
- header-capable host 必须使用 `Authorization: Bearer <session-secret>`。
- 不支持 header 的 host 只能使用 degraded fallback：loopback + Host/Origin 防护 +
  Desktop 确认 + session allowlist。确认弹窗必须显示这是弱认证路径，并尽量展示
  连接来源进程、clientInfo、端口和权限档位。

### 6.2 MCP handshake 与授权

Rust 在连接接受时生成 `connectionId`，在 MCP `initialize` 完成时生成 server-owned
`clientId`。`initialize.clientInfo` 只能用于 UI 展示和 audit log，不能覆盖 `clientId`。

未授权路径必须按以下规则处理：

- 未经 `initialize` 的连接调用 `tools/call`，立即返回 MCP 标准错误或
  `unauthorized`。
- `Pending Authorization` 阶段的 `tools/call` 直接返回 `pending_authorization`，
  不排队，避免用户点击 Allow 后释放积压调用。
- Rust 注入 `clientId`、`connectionId` 和当前 capability tier 到 WebView envelope；
  WebView 不接受来自 client 参数中的身份字段。
- `revoke` 后当前连接立即失效；同一 session 内复用旧 `clientId` 的请求拒绝。新的连接
  必须重新进入 `Pending Authorization`。

### 6.3 Capability 分层

| Capability | Tier | 默认 | 说明 |
| --- | --- | --- | --- |
| `trace.read` | Read Trace | 开 | 读取 trace metadata、列出表、查询 schema |
| `sql.query` | Read Trace | 开 | 执行受限 PerfettoSQL |
| `ui.show_sql_view` | Drive UI | 关 | 在 Query Page 打开查询结果 |
| `ui.show_timeline` | Drive UI | 关 | pan/zoom timeline |
| `ui.select_event` | Drive UI | 关 | 选择 SQL event 并滚动到 selection |
| `ui.get_current_selection` | Drive UI | 关 | 读取当前 selection |
| `file.read` | Experimental | 永远关 | v1 不通过 MCP 暴露 |
| `shell.exec` | Experimental | 永远关 | v1 不通过 MCP 暴露 |

高风险 UI 操作需要二次确认或 capability 升级。第一版不提供 destructive tools。

MCP `tools/list` 只返回当前授权 tier 可用的 tools。用户在 Desktop 中升降级权限时，
server 发送 `notifications/tools/list_changed`；agent 重新拉取 `tools/list`。如果
agent 继续调用已被撤销的 tool，server 返回 `capability_revoked` 结构化错误。

### 6.4 SQL 多层限制

所有 SQL 工具必须在执行层做限制，而不是只在结果迭代时截断。PerfettoSQL 支持多语句
和 side-effect statement，不能盲目把整段 SQL 包成 `SELECT * FROM (...) LIMIT N`。

`perfetto-query-sql` 使用多层防御：

1. 将输入切分为 statement 列表。
2. 允许 `INCLUDE PERFETTO MODULE ...` 等非 row statement，但记录在 audit log。
3. 仅对末位 row-producing statement 做 LIMIT 包装或改写。
4. 默认 row cap 为 500，server 硬上限为 5000。
5. 默认 byte cap 为 1 MiB。
6. 默认 query timeout 为 15 s；超时后返回结构化错误或 truncated result。
7. 任一 cap 触发时返回 `truncated: {reason}`，并提示 agent 缩窄查询。

### 6.5 URL handoff 安全

URL scheme 不属于 Phase B MVP。后续如果实现 `perfetto-desktop://...` inbound deep-link
或 `claude://...` / `codex://...` outbound handoff，必须遵守：

- URL 来源不可信，可能来自浏览器、邮件、IM、脚本或命令行参数。
- URL 中不得携带 session secret、Bearer token 或持久授权；短期 `nonce` 只能用于关联
  一次性确认流程，不能等同于 MCP session secret。
- inbound URL 不直接执行高影响 side effect。`open-trace` 需要用户确认文件；
  `agent-bridge/*` 必须走第 5.2 节状态机和 Desktop 授权，不得自动 enable 或自动授权。
- `path` 参数必须 canonicalize，拒绝系统目录和符号链接逃逸，只接受明确支持的 trace
  扩展名，例如 `.pftrace` / `.perfetto-trace`。
- outbound handoff 只在被调方官方支持 deeplink 后实现；具体调用使用当期 Tauri
  opener/shell open API 和最小 URL scope，不在设计中锁死某个 plugin 名称。

## 7. MCP Tool 初始集合

### 7.1 只读 trace tools

- `perfetto-get-trace-info`
  - 返回 trace start/end、duration、loaded trace name、当前 capability、bridge 状态。
- `perfetto-list-tables`
  - 查询 `sqlite_schema`，排除 `sqlite_%` 和内部表。
- `perfetto-describe-table`
  - 对指定表执行 `pragma table_info(...)`。
- `perfetto-query-sql`
  - 执行受限 PerfettoSQL。
  - 返回 JSON rows、column names、truncated metadata、elapsed time、byte count。

### 7.2 UI tools

- `perfetto-show-sql-view`
  - 参数：`query`, `title`。
  - 调用 Query Page 插件打开一个结果 tab。
- `perfetto-show-timeline`
  - 参数：`start_time`, `end_time`。
  - 调用 `trace.timeline.panSpanIntoView(...)`。
- `perfetto-select-event`
  - 参数：`table`, `id`。
  - 调用 `trace.selection.selectSqlEvent(...)`。
- `perfetto-get-current-selection`
  - 无 selection 时返回 `{kind: "none"}`，不返回错误。

第一版优先实现 `perfetto-get-trace-info`、`perfetto-list-tables`、
`perfetto-describe-table`、`perfetto-query-sql`、`perfetto-show-sql-view`、
`perfetto-show-timeline`。`perfetto-select-event` 在 `Drive UI` 权限确认流程完成后再打开。

## 8. Desktop UI 设计

新增一个轻量入口，建议在 `com.tooluselabs.PerfettoDesktop` 插件中注册页面：

- Sidebar: `Agent Bridge`
- 状态：`Disabled` / `Listening` / `Pending Authorization` / `Connected` / `Error`
- 操作：
  - `Enable`
  - `Disable`
  - `Copy One-Time Codex Command`
  - `Copy One-Time Claude Code Command`
  - `Copy Persistent Setup Command`
  - `Regenerate Session`
- 权限选择：
  - `Read Trace`
  - `Drive UI`
- 连接列表：
  - client name
  - connected time
  - last tool call
  - revoke button
- 审计日志：
  - tool name
  - short args summary
  - result status
  - duration

`Regenerate Session` 会 rotate 当前 session secret、断开所有 client、清空 allowlist，
并要求用户复制新的 one-time command。连接列表里的 `revoke` 只影响对应连接：立即断开，
当前 session 内拒绝旧 `clientId` 的后续请求，新连接仍需重新授权。

Audit log 只保存在内存环形缓冲中，默认 1000 条，app 退出即丢弃。后续可提供
`Export...` 按钮，通过 Tauri 文件 API 导出 JSONL。默认不写 localStorage，不上传远端。
对 `perfetto-query-sql`，UI summary 只显示前 120 字符和 SHA-256 前 8 位 hash。
完整 SQL 只保存在当前内存环形缓冲中，用户显式导出 JSONL 时才写入本地文件。

UI 文案要明确：Perfetto Desktop 不会管理外部模型账号；用户的 Codex/Claude Code
CLI 负责登录和调用模型。

## 9. Rust ↔ WebView 实现边界

### 9.1 Tauri/Rust 层

Rust 层负责本地 HTTP server、端口绑定、连接授权、Host/Origin 防护和生命周期管理。
它不理解 Perfetto trace 语义。

候选依赖：

- `axum` 或 `hyper`：loopback HTTP server。
- `tokio`：async runtime / network。
- `serde` / `serde_json`：JSON-RPC envelope。
- `uuid` 或随机 ID generator：request/client/session id。

候选职责：

- 启停 MCP HTTP server。
- 管理当前 trace/session 的连接 allowlist。
- 将 MCP JSON-RPC envelope 转发到 WebView。
- 管理 request timeout、并发上限和 cancellation。
- 将 WebView tool result 返回给 MCP client。

### 9.2 WebView/Plugin 层

插件层持有 `Trace`，适合实现具体 tools：

- SQL 查询。
- Query Page tab。
- timeline pan/zoom。
- selection 操作。
- 当前 trace/context 读取。

WebView 不能绑定 TCP 端口。MVP 可以先用 mock TypeScript harness 验证 tool handler
接口，但生产路径必须由 Rust 启动 HTTP server。

### 9.3 Bridge envelope

Rust 与 WebView 之间使用 Tauri command/event 通道传递稳定 envelope：

```ts
interface AgentBridgeRequest {
  readonly requestId: string;
  readonly clientId: string;
  readonly capabilityTier: 'read_trace' | 'drive_ui';
  readonly method: string;
  readonly params: unknown;
  readonly deadlineMs: number;
}

interface AgentBridgeResponse {
  readonly requestId: string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}
```

Rust 负责 request lifecycle；WebView 只根据 `method` 派发到 tool handler。超时、
client 断开和取消由 Rust 统一收口。`clientId` 和 `capabilityTier` 均由 Rust 注入；
WebView 只将它们用于权限判断、连接列表和 audit log。

## 10. Trace lifecycle

MVP 采用每个 trace load 生成新 session 的模型。trace unload、加载新 trace 或关闭
窗口时：

- 当前 authorized clients 失效。
- Agent Bridge 回到 `Listening` 或 `Disabled`，取决于用户设置。
- 下一次 tool call 返回 `trace_unloaded` 或要求重新授权。
- 用户需要复制新的 one-time command 或在 Desktop 中重新允许连接。

这比跨 trace 保持连接更保守，也能避免 agent 对旧 trace 的上下文误用于新 trace。
跨 trace 保持连接和 MCP resource changed notification 放到 Phase D 之后再评估。

已知 UX 取舍：跨 trace 对比时，用户每次切换 trace 都需要重新连接或重新授权。如果
Phase D 反馈这是高频痛点，可以演进为保持连接、对每个新 trace 重新确认 `Drive UI`
tier，并通过 `notifications/resources/list_changed` 通知 agent 刷新上下文。

## 11. 分阶段计划

### Phase A: Done / 现状

- `com.tooluselabs.PerfettoDesktop` 已默认启用。
- Multi-LLM Chat surface 已移除。
- v0.1.1 release notes 已改为 fork-owned integration point。
- Agent Bridge 设计文档已新增。

### Phase B: Local Bridge MVP

- Desktop UI 增加 `Agent Bridge` 页面。
- 实测 Claude Code、Codex 和 generic JSON 的 HTTP MCP header 支持，生成 host-specific
  one-time command 模板。
- `Cargo.toml` 增加 HTTP server/runtime/JSON 相关依赖。
- Rust 层启动 loopback server。
- 实现 §6.1 HTTP 防御：Host allowlist、Origin 拒绝、`Sec-Fetch-Site` 拒绝、header
  Bearer 或 degraded fallback。
- 实现 §6.2 未授权调用拒绝：未 `initialize`、pending 状态、伪造 `clientId` 都不能
  调用 tools。
- 定义 Rust ↔ WebView envelope schema。
- 实现 `tools/list` capability 过滤和 `notifications/tools/list_changed`。
- 插件实现 read-only tools：
  - `perfetto-get-trace-info`
  - `perfetto-list-tables`
  - `perfetto-describe-table`
  - `perfetto-query-sql`
- 显示一次性连接命令。
- 提供可选持久配置命令，但不在持久 URL 中包含一次性授权。
- 对 SQL query 做 statement 切分 + row/byte/time 三层 cap。
- 实现内存 audit log 和 SQL summary 规则。
- 在 fork plugin `onTraceLoad` 校验 `trace.timeline` / `trace.selection` 可用性。

### Phase C: UI Control & Diagnostics

- 增加 `perfetto-show-sql-view`。
- 增加 `perfetto-show-timeline`。
- 增加 `perfetto-select-event`，需要 `Drive UI` 权限。
- 添加 tool-call audit log。
- MCP self-check / `Test Connection` 面板：内置 MCP client 跑 `initialize`、
  `tools/list` 和 `perfetto-get-trace-info`，只用于诊断，不连接 LLM。
- 可选评估 `perfetto-desktop://open-trace?path=...`，作为 deep-link 基础设施验证；
  它不属于 Agent Bridge 必需能力，且必须先满足 §6.5 的 URL handoff 安全约束。
- 评估 `Open Terminal + Copy Command` QoL：只打开终端或复制命令，默认不自动执行外部
  agent CLI。

### Phase D: Hardening

- 更细 capability 升降级。
- session regeneration。
- idle timeout。
- 更完整的 error mapping。
- Codex/Claude Code 命令模板版本检测。
- Bearer/OAuth 升级路径，覆盖 header 配置能力较弱或非 loopback 的 host。
- 评估 outbound `claude://` / `codex://` deeplink；仅在被调方官方支持后启用，并提供
  feature-detect 和复制命令 fallback。
- 评估 inbound `perfetto-desktop://agent-bridge/*` 是否有真实需求；即使实现，也只能打开
  UI 或触发确认流程，不能绕过授权。
- Playwright 或 integration smoke test。
- 评估 resources/prompts、multi-agent 和跨 trace 连接。

## 12. 验收标准

- 默认安装后 Agent Bridge 关闭，不监听任何端口。
- 启用后只监听 `127.0.0.1`。
- 带浏览器 Origin 或 cross-site fetch metadata 的请求被拒绝。
- Host 非 `127.0.0.1:<port>` / `localhost:<port>` 的请求被拒绝。
- 未带或带错 `Authorization` 的 header-capable host 请求被拒绝；degraded fallback
  只在用户明确确认后可用。
- 一次性连接命令可复制，并能让 Codex/Claude Code 发现 tools。
- 未经 `initialize` 或 Desktop 确认的 client 不能调用 tools。
- `Pending Authorization` 阶段发出的 `tools/call` 返回 `pending_authorization`，
  不会在授权后补执行。
- client 自报的身份不能覆盖 Rust 分配的 `clientId`。
- tier 降级后 `tools/list` 更新，旧 UI tool 调用返回 `capability_revoked`。
- `perfetto-query-sql` 能对当前 trace 返回受限 JSON 结果。
- `SELECT * FROM slice` 在大 trace 上能在 15 s timeout 内返回截断或结构化错误，不导致
  UI 内存无界增长。
- `perfetto-show-timeline` 能把 UI 跳转到指定时间范围。
- 禁用 Bridge、trace unload 或 session regeneration 后旧连接立即失效。
- Perfetto UI typecheck、plugin ESLint、Tauri build 都通过。

## 13. 待定问题

- Codex 的 `-c/--config` runtime override 是否能稳定表达 nested HTTP MCP server。
- Claude Code 和 Codex 的 HTTP MCP 配置是否稳定支持 `headers.Authorization`。
- 如果 Codex 一次性 runtime config 不稳定，是否使用临时 `CODEX_HOME` 方案。
- Claude/Codex 的一次性命令模板是否需要根据版本检测动态生成。
- 不支持 header 的 host 是否接受 degraded fallback，还是要求用户先做持久配置。
- 是否注册 inbound `perfetto-desktop://open-trace?path=...`，作为 Phase C deep-link
  基础设施验证。
- inbound `perfetto-desktop://agent-bridge/*` 的命名空间如何划分；是否需要
  `agent-bridge/enable` 或 `agent-bridge/connect?nonce=...`，以及是否等 agent 生态出现
  明确需求再做。
- outbound `claude://` / `codex://` deeplink 的 feature-detect 策略：PATH 探测、
  用户配置选项，还是仅在被调方官方文档确认后开放。
- 是否提供 `Open Terminal + Copy Command`；若支持自动执行，如何处理二次确认、
  shell quoting 和 shell history 中的 session secret。
- MCP HTTP transport 是否需要后续增加 OAuth 或 bearer-token-env-var 模式，以支持
  非 loopback 场景。
- 是否允许多个 agent 同时连接同一个 trace。MVP 默认单连接。
- 是否把 per-trace session 演进为跨 trace 连接 + per-trace 重新授权。
- 是否需要英文版 `perfetto-desktop-agent-bridge.md`；当前中文文档是 source of truth。
