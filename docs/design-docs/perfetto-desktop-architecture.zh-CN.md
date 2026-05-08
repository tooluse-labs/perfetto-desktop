# Perfetto 桌面版与多 LLM AI 插件方案设计

> English version: [perfetto-desktop-architecture.md](perfetto-desktop-architecture.md)

## 1. 背景

Perfetto 当前以 Web UI 为主要交互形态，核心 UI 位于 `ui/`，已有
`ui/src/plugins/com.google.PerfettoMcp` 插件提供基于 Gemini 的 AI Chat
能力。该插件已经注册 Perfetto Trace 与 UI 工具，并通过 MCP
（Model Context Protocol）让模型调用这些工具分析 trace。

本 fork 计划在保持可持续同步 upstream 的前提下，扩展三个能力：

1. 使用 Tauri 将 Perfetto UI 包装为桌面安装包。
2. 基于现有 Perfetto MCP 能力支持多个 LLM Provider。
3. 保持与 upstream Perfetto 的定期同步，降低长期维护成本。

## 2. 目标与非目标

### 2.1 目标

- 提供 macOS、Windows、Linux 桌面安装包。
- 保留 Perfetto Web UI 的主要功能和上游升级路径。
- 新增独立 AI 插件，MVP 支持 Gemini 与 HTTPS OpenAI-compatible Provider；
  Anthropic、Ollama 等 Provider 放入后续阶段。
- 复用现有 MCP 工具注册思路，允许模型查询 trace、运行 SQL、读取 UI
  上下文。
- 将 fork 自有代码控制在清晰边界内，减少 upstream merge 冲突。
- 支持本地配置、API key 管理、模型切换和基础错误诊断。

### 2.2 非目标

- 不修改 Perfetto C++ trace processor 的核心架构。
- 不重写现有 Perfetto UI。
- 不在第一阶段实现多人协作、远程账号体系或企业统一网关。
- 不在 MVP 支持本地 HTTP Provider，例如默认 `http://localhost:11434` 的
  Ollama；该能力需要额外处理 CSP 或 Tauri 代理。
- 不承诺所有模型都支持完整 tool calling；不支持时降级到 SQL 生成或问答模式。

## 3. 总体方案

采用「lean 产品仓 + DEPS-pin upstream」结构：

```text
perfetto-desktop/                  # 本仓库（Tooluse Labs 产品仓）
  DEPS                             # 锁定 upstream Perfetto SHA
  desktop/                         # Tauri 桌面项目
    src-tauri/
    package.json
    tauri.conf.json
  ui-overlay/
    plugins/
      com.tooluselabs.PerfettoDesktop/    # AI 插件源码（Phase 2）
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
  patches/perfetto/                # 在 setup 时应用到 upstream 的 patch
  scripts/
    setup.sh                       # clone + checkout + apply patches + sync overlay
    apply-patches.sh
    sync-overlay.sh
    update-perfetto.sh
  third_party/
    perfetto/                      # gitignored；由 scripts/setup.sh 拉取
```

Tauri 负责桌面生命周期、文件访问、安装包、自动更新和安全存储；Perfetto
UI 仍作为前端主体运行。AI 插件在 UI 内注册页面与侧边栏入口，并通过统一
Provider 抽象调用不同模型。

Upstream Perfetto 是构建依赖而不是 fork：在 `DEPS` 中按 SHA 锁定，由
`scripts/setup.sh` 拉取到 `third_party/perfetto/`，本仓库 git 历史中**不包含**
upstream 源码。AI 插件源码住在 `ui-overlay/plugins/<name>/`，setup 时由
`scripts/sync-overlay.sh` 用 rsync 同步到
`third_party/perfetto/ui/src/plugins/<name>/`，让 Perfetto 自带的插件自动
发现机制原样捡到它。

## 4. 架构设计

### 4.1 桌面层

桌面层位于 `desktop/`，不侵入上游主构建系统。`scripts/setup.sh` 把
`third_party/perfetto/` 拉好之后，构建在 upstream 工作树里跑 Perfetto UI
构建，并把产物当作 Tauri 前端资源：

```sh
./scripts/setup.sh
(cd third_party/perfetto && ./ui/build)
(cd desktop && pnpm tauri build)
```

桌面层职责：

- 加载 `third_party/perfetto/ui/out/dist` 或等价构建产物。
- 提供原生文件打开能力，用于打开本地 trace。
- 使用系统安全存储保存 API key。
- 后续支持自动更新和 sidecar 进程。

第一阶段不把 `trace_processor_shell` 作为 sidecar 强绑定进安装包，避免扩大
平台差异和签名复杂度。需要本地增强能力时再单独评审。

### 4.2 AI 插件层

新增 `com.tooluselabs.PerfettoDesktop` 插件，不直接大改 `com.google.PerfettoMcp`。这样
upstream 修改 Google 插件时，fork 侧冲突更少。

插件职责：

- 在 `onActivate()` 注册全局设置。
- 在 `onTraceLoad()` 注册当前 trace 的 AI Chat 页面。
- 创建 MCP server/client 或等价工具上下文。
- 将 Perfetto tools 转换为不同 LLM Provider 的工具格式。
- 自行驱动 tool-call loop；不依赖 Gemini SDK 的
  `automaticFunctionCalling` 路径。
- 管理聊天状态、工具调用展示、token 用量展示和错误提示。

`onActivate()` 注册的普通设置：

- `Provider`: `Gemini`、`OpenAI Compatible`
- `Base URL`
- `Model`
- `Max Tool Calls`
- `Show Tool Calls`
- `Show Token Usage`
- `System Prompt`

SecretBridge 管理的敏感设置：

- `API Key`
- `Reset API Key` 由 secret UI 渲染为操作按钮，不作为普通 setting 存储。

`API Key` 只在设置 UI 中与其他字段并列展示，持久化必须走 §5 的 secret
bridge，不通过 `app.settings.register`。如果保留现有 UI tool，例如打开 SQL
视图或 Query Page 相关工具，新插件需要像 `com.google.PerfettoMcp` 一样声明
对 `QueryPagePlugin` 的依赖。

### 4.3 Provider 抽象

定义统一接口：

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

核心数据结构应与具体厂商 SDK 解耦：

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

Provider 采用无状态设计：messages 由 AI 插件层持有，Provider 只负责一轮
request/response，不保存会话历史，也不暴露 `reset()`。`ChatInput.tools` 只
包含工具声明，执行器由 AI 插件层的 tool registry 持有；`maxToolCalls` 由
插件层 tool-call loop 持有，不进入 Provider 请求。MVP 可以先返回完整
`ChatResponse`；接口保留 `AbortSignal`，用于用户停止请求。Streaming 作为
第二阶段能力，届时可增加 `streamMessage(): AsyncIterable<ChatChunk>`。
Provider 实例由 AI 插件层按当前 `LlmProviderConfig` 构造；`Provider`、`Base
URL`、`Model` 或 `System Prompt` 变化时重建实例。`API Key` 先由插件层通过
secret bridge 异步解析为字符串，再注入 Provider config；Provider 实现不直接
调用 secret bridge。Provider 切换时由插件层通过 `AbortController` 中止旧的
在途请求，再创建新 Provider。`systemPrompt` 由 Provider adapter 注入到底层
协议，插件不要再在 `ChatInput.messages` 中额外构造 system message。新增
Provider 时在 `provider/<name>.ts` 实现 `LlmProvider`，并把 id 加入
`PROVIDER_IDS`。`ToolCallRecord` 仅用于插件内部聊天 history，不出现在
Provider 接口。

Provider 适配策略：

- Gemini：复用当前插件的工具定义经验，但关闭 SDK 自动工具调用，由插件
  手动处理 `functionCall`/`functionResponse`。
- OpenAI-compatible：MVP 锁定 `chat/completions`，将 Perfetto tools 转换为
  `tools: [{type: "function"}]`。
- Anthropic：第二阶段转换为 Claude tool use/tool result 消息格式。
- Ollama：第二阶段支持；默认本地 HTTP endpoint 需要 CSP fork patch 或
  Tauri 侧代理。

### 4.4 MCP 与工具适配

现有 `com.google.PerfettoMcp` 已有 `tracetools.ts`、`uitools.ts`。新插件应优先
复用或复制其工具注册逻辑，但将工具定义归一化为内部格式：

```ts
export interface PerfettoAiTool extends ToolDeclaration {
  call(input: unknown): Promise<unknown>;
}
```

内部工具格式再由 Provider 转换为模型调用格式。这样 MCP、OpenAI function
calling 和 Anthropic tools 都能共享同一组 Perfetto 能力。Provider 只接收
`ToolDeclaration`；当模型返回 tool call 时，AI 插件层根据 tool name 从
`Map<string, PerfettoAiTool>` 查找执行器并调用 `call()`。

工具调用需要限制：

- 单轮最大工具调用次数，默认 20。
- SQL 查询超时或结果行数限制；新插件的 SQL tool 入参 schema 为
  `{query, limit?}`，默认 `limit` 1000；不修改 upstream
  `com.google.PerfettoMcp` 中的既有 schema。
- 工具错误以结构化消息返回模型，同时在 UI 展示。
- 对可能泄露大量 trace 数据的工具增加显式确认或截断。

## 5. 安全与配置

API key 不应长期存放在普通 localStorage 中。现有 Perfetto `app.settings`
统一落到 `perfettoSettings` localStorage，因此新插件不能使用
`app.settings.register` 存储 API key。桌面环境优先通过插件自有 secret
bridge 调用 Tauri 安全存储或系统 keychain；Web fallback 仅使用内存态并
明确提示刷新后丢失。

Secret bridge 最小接口：

```ts
export interface SecretBridge {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

桌面实现通过 `invoke('secret_get')`、`invoke('secret_set')`、
`invoke('secret_delete')` 调用最终选定的 secret plugin。Web 模式下 API key
仅保存在 JS 内存 `Map` 中，刷新页面或关闭 tab 即丢失；如未输入 API key，
AI Chat 入口禁用并提示。

插件初始化时根据 `window.__PERFETTO_FORK__?.desktop` 选择 SecretBridge
实现：`true` 使用基于 Tauri `invoke()` 的桌面实现；`false` 或 `undefined`
使用基于内存 `Map` 的 Web fallback。Tauri `initialization_script` 在 UI JS
执行前注入该标记，因此 `onActivate()` 中读取是稳定的。

`secret_get`、`secret_set`、`secret_delete` 是 fork 自有 Rust wrapper，不是
secret plugin 的原生命令，用于隔离前端和具体 secret plugin：

```rust
#[tauri::command]
async fn secret_get(key: String) -> Result<Option<String>, String> {
    // Call the selected secret plugin.
}
```

推荐决策：MVP 即接入系统安全存储。若实现受阻，可以短期使用会话内存存储，
但不接受将 API key 持久化到 localStorage，也不通过普通 Perfetto Settings
管理 API key。这样可以避免首版发布后再迁移用户密钥带来的兼容和安全成本。

网络请求策略：

- 默认只访问用户配置的 HTTPS Provider endpoint。
- Base URL 变更需要在设置界面可见。
- 记录错误码和 Provider 名称，不记录完整 API key。

Trace 数据可能包含敏感信息。AI 插件应提供：

- 是否允许发送 trace 查询结果到模型的开关。
- 单次工具结果最大字符数。
- 清空会话按钮。
- 明确的 Provider 当前状态显示。

## 6. 关键技术链路

### 6.1 Tauri 启动与 UI 加载

桌面应用启动后加载 Perfetto UI 静态产物。Perfetto UI 使用 hash route，
因此 Tauri 侧只需要提供单入口 HTML 和静态资源访问，不需要实现服务端路由。

需要在实现中验证：

- `third_party/perfetto/ui/out/dist` 中 JS、CSS、WASM、worker 等资源路径
  在 Tauri 中可访问。
- CSP 不阻断 WASM、worker、Provider API 请求和本地资源加载。Perfetto UI
  当前在 `third_party/perfetto/ui/src/frontend/index.ts` 运行时注入 meta CSP；
  Tauri 也可能叠加 `tauri.conf.json` 的 CSP。多层 CSP 按更严格的交集生效，
  不是并集；Tauri CSP 不能比 Perfetto 运行时 meta CSP 更窄，除非
  `patches/perfetto/` 下有对应的 patch 同步剥离掉那部分能力。
- Hash route 例如 `#!/viewer`、`#!/aichat` 在刷新和窗口恢复后可用。
- 打开本地 trace 的路径通过 Tauri command 或文件打开事件传回 UI。
- 版本化资源目录，例如 `dist/<version>/`，在 Tauri 静态资源服务中可见。

桌面构建需要处理 Service Worker：Perfetto 生产构建会注册
`service_worker.js`，但 Tauri 自定义协议和 macOS WKWebView 下可能不可用。
MVP 推荐通过 fork 自有运行时标记绕过 Service Worker 注册，并把状态徽标的
异常作为验收检查项。统一 runtime flag：

```ts
declare global {
  interface Window {
    __PERFETTO_FORK__?: {
      readonly desktop: boolean;
    };
  }
}
```

Web 构建下 `window.__PERFETTO_FORK__` 为 `undefined`,所有读取必须使用
optional chaining。Tauri `initialization_script` 注入示例:

```ts
window.__PERFETTO_FORK__ = Object.freeze({
  desktop: true,
});
```

早先草案还带 `hideUpstreamMcp` 字段,配套 patch slot
`0002-hide-upstream-mcp-when-fork-flag.patch`。阶段 1 验证（2026-05-08）
已确认上游 `com.google.PerfettoMcp` 在 Tauri WKWebView 中可用,fork
插件改为与之共存而非隐藏,所以该字段与 patch slot 一并移除（详见 §10
和 §14）。

实现以 patch 文件落在 `patches/perfetto/` 下，例如
`0001-bypass-sw-when-fork-flag.patch`，作用于
`third_party/perfetto/ui/src/frontend/index.ts`，在调用
`serviceWorkerController.install()` 之前 gate
`window.__PERFETTO_FORK__?.desktop`。Tauri `initialization_script` 在 UI JS
执行前注入该标记。

macOS WKWebView 下 WASM 需要从两个角度单独验证：

1. **MIME 与 streaming**。WKWebView 对自定义协议的 MIME 和 streaming
   行为可能影响 `WebAssembly.instantiateStreaming`。若失败，应 fallback
   到 `arrayBuffer` 实例化，并确保 asset 协议返回 `application/wasm`。
2. **Memory64**。截至 2026 年，WKWebView 未实现 WASM Memory64 提案。
   Perfetto 上游 `ui/run-dev-server` 硬编码 `--only-wasm-memory64`，
   只产出 64-bit 的 `trace_processor.wasm`，在桌面端加载时直接报
   "Unable to load the 32-bit trace_processor.wasm ... browser does
   NOT support Memory64"。Fork 的 `tauri.conf.json:beforeDevCommand`
   绕开 wrapper，直接调 `ui/build.js` 不带该 flag，build.js 同时产出
   32-bit 与 64-bit 两个版本，WKWebView 自动选 32-bit。具体命令见 §15。

### 6.2 打开 Trace 文件

MVP 支持两种入口：

1. 应用内选择文件。
2. 拖拽文件到窗口。

Tauri 层负责拿到本地文件句柄或路径，UI 层继续复用 Perfetto 现有 trace
加载流程。若直接传路径不可行，则由 Tauri 读取文件内容并以 Blob/ArrayBuffer
形式传给 UI。

MVP 最小实现建议：

- 应用内选择文件：使用 `tauri-plugin-dialog` 打开文件选择器。
- 文件读取：使用 `tauri-plugin-fs`，仅允许读取用户显式选择的 trace 文件。
- 拖拽：使用 Tauri 2 `WebviewWindow` drag/drop 事件。
- OS “打开方式” 和文件关联：作为二阶段能力；若进入 MVP，需要补
  `tauri.conf.json` bundle file association 和平台事件处理。

### 6.3 LLM Tool-Call Loop

Provider 不直接执行业务逻辑，只负责模型协议适配。统一 tool-call loop
由 AI 插件层驱动，Gemini 也走同一条手动循环，不使用
`automaticFunctionCalling`：

```text
User message
  -> LlmProvider.sendMessage(messages, tools)
  -> model returns text and/or tool calls
  -> AI plugin validates tool call
  -> PerfettoAiTool.call(args)
  -> append tool result to messages
  -> continue until no tool call or maxToolCalls reached
```

终止条件：

- 模型返回最终文本且没有 tool call。
- 达到 `Max Tool Calls`，默认 20。
- 工具调用失败且错误不可恢复。
- 用户手动停止；Provider API 需要支持 `AbortSignal` 或等价取消机制。
  Stop 通过插件层标志位让 loop 在下一次循环点退出；本轮 tool 执行默认不
  强制中断，除非该 tool 显式支持 `AbortSignal`。

错误处理：

- 参数校验失败：返回结构化 tool error 给模型。
- SQL 执行失败：返回错误消息和 SQL 片段。
- 结果过大：截断并标记 `truncated: true`。
- SQL 超时由插件层 timer 丢弃结果实现，不强制 terminate WASM worker。
- Provider 请求失败：停止本轮并在 UI 显示 Provider、状态码和脱敏错误。

## 7. 构建与发布

### 7.1 开发命令

Bootstrap：

```sh
./scripts/bootstrap.sh   # 宿主工具链（每台机器一次性：pnpm + rustup）
./scripts/setup.sh       # 仓库状态（clone 后或 DEPS bump 后）：Perfetto checkout + UI build deps
(cd desktop && pnpm install)
```

开发循环：

```sh
(cd desktop && pnpm tauri dev)
```

`pnpm tauri dev` 会按 `tauri.conf.json:beforeDevCommand` 启动 dev
server（直接调 `ui/build.js` 而不是 `ui/run-dev-server`，原因见
§6.1 和 §15），并把 Tauri 壳指向 `devUrl`。

检查：

```sh
(cd third_party/perfetto && ./ui/build --typecheck)
(cd third_party/perfetto && ./ui/run-unittests)
```

出包：

```sh
(cd third_party/perfetto && ./ui/build)
(cd desktop && pnpm tauri build)
```

开发循环固定使用 `--serve-port 10000`。否则 `ui/run-dev-server` 在 10000 被
占用时会自动递增端口，让 Tauri `devUrl` 失效。

### 7.2 CI 建议

CI 至少包含：

- UI TypeScript typecheck。
- AI Provider adapter 单元测试。
- UI 插件基础单测。
- Tauri 构建 smoke test。
- 每周 upstream sync dry-run。

### 7.3 发布产物

第一阶段目标：

- macOS Apple Silicon arm64: `.dmg` 或 `.app`

第二阶段扩展：

- macOS Intel/Universal
- Windows: `.msi` 或 `.exe`
- Linux: `.AppImage` 或 `.deb`

签名、公证和自动更新作为第二阶段交付或专项交付。

## 8. MVP 验收标准

MVP 以 macOS 作为首发验证平台，同时保持 Windows/Linux 目录和配置不阻断后续
扩展。

必须满足：

- 可以通过 Tauri 启动桌面应用并加载 Perfetto UI。
- 可以打开本地 trace，并完成基础浏览。
- 加载 trace 后侧边栏出现上游 `com.google.PerfettoMcp` 提供的 AI Chat 入口。
- 上游 Gemini Provider 完成一次工具调用(阶段 1 实测路径)。
- 阶段 1 不要求 fork 自有 Provider;fork 插件的 AI Chat 与 Provider(DeepSeek/ZAI/Anthropic 等)在阶段 2 完成。
- 阶段 2 起,fork 插件的 API key 不持久化到 localStorage。
- 桌面模式绕过或正确处理 Service Worker 注册。
- WASM、worker 和版本化资源目录在 Tauri 中可加载。
- 单轮工具调用次数、SQL 结果大小和错误信息可控。
- 达到 `Max Tool Calls` 时能停止并向用户说明原因。
- 工具抛错时 tool-call loop 不死循环。
- 用户点击 Stop 后能通过 `AbortSignal` 或等价机制中断在途 Provider 请求；
  若正在执行 tool，则在下一次 loop 边界停止。
- `com.google.PerfettoMcp`（上游 Gemini chat）与 fork 自有 plugin 的 chat 入口共存,菜单文案区分两个入口。
- `(cd third_party/perfetto && ./ui/build --typecheck)` 与
  `(cd third_party/perfetto && ./ui/run-unittests)` 通过。
- macOS Apple Silicon arm64 可生成可运行安装包或 `.app` 产物。

暂不要求：

- Windows/Linux 正式安装包。
- 自动更新。
- 代码签名和公证。
- 打包 `trace_processor_shell` sidecar。
- 企业统一模型网关。

## 9. Upstream 同步策略

本仓库不是 google/perfetto 的 git fork。Upstream 是构建依赖：在 `DEPS` 中按
SHA 锁定，由 `scripts/setup.sh` 拉取到 `third_party/perfetto/`（gitignored）。
Upstream 源码不进入本仓库的 git 历史。

升级 upstream pin：

```sh
./scripts/update-perfetto.sh <new-sha>     # 或：latest

(cd third_party/perfetto && ./ui/build --typecheck)
(cd third_party/perfetto && ./ui/run-unittests)
(cd desktop && pnpm tauri build)

git add DEPS
git commit -m "deps: bump perfetto to <sha>"
```

`update-perfetto.sh` 把新 SHA 写进 `DEPS`，然后跑 `setup.sh`，后者会重新应用
patch 并重新 sync overlay。任何 patch 失败都会让脚本立即停止——upstream
drift 在 setup 阶段暴露，不到 build 才发作。

约束：

- fork 自有源码只在 `desktop/`、`ui-overlay/`、`patches/`、`scripts/`、
  `docs/` 这几处。
- Upstream Perfetto 源码**绝不**进入本仓库 git 历史。任何修改都通过
  `patches/perfetto/` 下的 `.patch` 文件、在 setup 时应用。
- `apply-patches.sh` 在 patch 失败时立刻报错退出，让 upstream drift 在
  setup 阶段暴露而不是 build 阶段。
- fork 自有插件住在 `ui-overlay/plugins/<name>/`，setup 时被 rsync 进
  `third_party/perfetto/ui/src/plugins/<name>/`，跟 upstream 自带插件一样
  走 Perfetto 插件自动发现。
- Upstream 自动生成的 `Android.bp`、Bazel 文件不在本仓库手动维护；
  Perfetto 构建系统完全运行在 `third_party/perfetto/` 内。

## 10. 分阶段实施计划

### 阶段 1：MVP

- 新增 `desktop/` Tauri 项目。
- 完成 Perfetto UI 静态资源加载（含 WKWebView 32-bit WASM workaround,
  解决 Memory64 不兼容,详见 §6.1）。
- 桌面构建绕过或兼容 Service Worker。
- 验证上游 `com.google.PerfettoMcp` 在 Tauri 壳里可用,与之共存,不再隐藏。

验收标准：

- 可以本地打开桌面应用。
- WASM、worker、版本化资源目录在 Tauri 下加载成功。
- `(cd third_party/perfetto && ./ui/build --typecheck)` 通过。
- macOS 桌面产物可运行。
- 上游 `com.google.PerfettoMcp` 插件在 trace 加载后激活,AI Chat 菜单出现,
  Gemini API 完整 round-trip(CSP、fetch streaming、SDK 调用链路均已在
  WKWebView 下验证,验证日期 2026-05-08）。

阶段 1 重要发现：原本计划隐藏 `com.google.PerfettoMcp` 并由 fork 插件
重做 Gemini 路径。该方案已废弃 —— 上游可用,fork 插件不再涉足 Gemini,
转而专注上游不覆盖的 Provider（见阶段 2）。

### 阶段 2：产品化

- 新增 fork 自有的 `com.tooluselabs.PerfettoDesktop` 插件,提供与上游平行
  的 AI Chat 入口,覆盖上游 `com.google.PerfettoMcp` 不支持的 Provider。
- Provider 优先级:
  1. **DeepSeek 与 ZAI（智谱 GLM）为首要交付**,两家都通过同一个
     OpenAI-compatible Provider + 可配置 base URL 提供。同一个 Provider
     类零成本顺带覆盖一大票生态:Kimi（Moonshot）、MiniMax、通义千问
     （阿里 DashScope）、豆包（火山方舟）、OpenAI 本身、本地 Ollama /
     LM Studio / vLLM,以及 OpenRouter 这类聚合网关。Settings UI 提供
     preset 列表（DeepSeek、ZAI、Kimi、MiniMax、Qwen、豆包、OpenAI、
     Ollama、自定义）+ 一个 free-form base URL 输入。
  2. **Anthropic（Claude）为延后任务**。Claude Messages API 协议自成体系
     （endpoint 不同、header 鉴权、content-block 消息结构、tool-use schema
     不同),需要单独的 Provider 类基于 `@anthropic-ai/sdk`。**不阻塞**阶段 2
     验收;明确想用 Claude 的用户可以等、用聚合网关走 OpenAI-compat
     Provider,或者直接在 Claude Code 里用 perfetto-mcp-rs。
- Provider 抽象按 §6.3 实现手动 tool-call 循环（Gemini 的
  `automaticFunctionCalling` 不可移植）。
- Settings 页:Provider 选择、base URL、API key、模型、系统 prompt。
- API key 优先系统安全存储,受阻时允许会话内存兜底,绝不进入 localStorage。
- 工具调用结果截断、错误诊断、重试。
- 跨平台 CI:Linux / Windows runner 出 installer。
- Provider adapter 单测。

验收标准：

- DeepSeek 与 ZAI Provider 各完成一次工具调用。
- 工具调用失败时 UI 有明确错误。
- macOS 之外至少有一个平台产出可运行 installer。

Anthropic Provider 为 stretch goal,等 OpenAI-compat 路径稳定后再 ship。

如果用户**不需要 GUI**,只想让自己已经在用的 MCP client（Claude Code、
Codex、Cursor、Claude Desktop）以 headless 方式分析 trace 文件,推荐使用
[`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
作为配套工具。它是独立的 Rust 二进制,封装 `trace_processor_shell` 并通过
stdio MCP 暴露 PerfettoSQL 与若干专用 Chrome 工具。Perfetto Desktop 与
perfetto-mcp-rs 是互补关系,不是竞争:Perfetto Desktop 提供 GUI 与 in-app
chat,perfetto-mcp-rs 把 trace 工具接进用户已有的 agent 工作流。

### 阶段 3：长期维护

- 增加自动更新。
- 增加 upstream sync CI。
- 评估是否引入 sidecar `trace_processor_shell`。
- 评估是否演进到独立 AI Gateway。

### 排期与依赖

建议按 6 周组织第一轮评审到 MVP：

| 周期 | 工作内容 | 主要依赖 |
| --- | --- | --- |
| 第 1 周 | Tauri 项目骨架、UI 静态资源加载、macOS dev 启动 | Rust/Tauri 工具链 |
| 第 2 周 | 本地 trace 打开链路、AI 插件入口、设置页 | Perfetto UI trace 加载接口 |
| 第 3-4 周 | Provider 抽象、Gemini/OpenAI-compatible、tool-call loop | 模型 API key 与测试账号 |
| 第 5 周 | 安全存储、错误处理、结果截断、单测 | Tauri 安全存储插件 |
| 第 6 周 | macOS 打包、CI smoke test、评审修正 | 构建机和发布证书可选 |

角色需求：

- 1 名前端/Perfetto UI 工程师。
- 1 名 Tauri/Rust 工程师，可兼职。
- 1 名 AI Provider/工具调用链路工程师，可与前端角色合并。

## 11. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Upstream UI 频繁变化 | merge 冲突 | fork 代码集中在新增目录，减少核心文件 patch |
| 不同 LLM 工具调用格式差异大 | Provider 适配复杂 | 使用内部 `PerfettoAiTool` 抽象统一工具定义 |
| 部分模型不支持 tool calling | 功能不完整 | 降级为 SQL 生成和解释模式 |
| Trace 数据敏感 | 合规风险 | 增加发送开关、截断、清空会话和 Provider 明示 |
| Tauri 跨平台差异 | 打包失败 | 先做单平台 MVP，再扩展 CI matrix |
| API key 泄露 | 安全风险 | 使用系统安全存储，日志脱敏 |
| Service Worker 在 Tauri 下不可用 | 缓存和状态异常 | 桌面模式绕过注册并验证状态徽标 |
| WKWebView WASM streaming 不兼容 | trace processor 无法启动 | 验证 MIME，必要时使用 arrayBuffer fallback |
| Ollama 本地 HTTP 被 CSP 拦截 | 本地模型不可用 | MVP 不支持，二阶段通过 CSP patch 或 Tauri 代理 |
| Tauri capability 配置缺失 | IPC、文件打开或 secret 存储不可用 | 新增最小 capability 并纳入 smoke test |
| macOS Gatekeeper 拦截未签名应用 | MVP 演示启动受阻 | 提供右键打开说明；签名和公证进入二阶段 |

## 12. 决策项与推荐结论

| 决策项 | 推荐结论 | 原因 |
| --- | --- | --- |
| 插件命名空间 | `com.tooluselabs.PerfettoDesktop` | 与 upstream `com.google.*` 隔离 |
| MVP Provider | Gemini + HTTPS OpenAI-compatible `chat/completions` | 覆盖现有能力和主流兼容生态，避开本地 HTTP CSP 风险 |
| API key 存储 | 首版使用系统安全存储；受阻时仅允许会话内存 | 避免密钥迁移和泄露风险 |
| Trace 数据发送 | 默认允许发送工具结果，但限制大小并明确显示 Provider | 保证功能可用，同时降低误传风险 |
| 首发平台 | macOS | 开发验证成本最低，适合先跑通链路 |
| Sidecar | MVP 不打包 `trace_processor_shell` | 降低跨平台和签名复杂度 |
| Upstream 同步 | 每周同步，MVP 后由固定负责人处理冲突 | 避免长期分叉扩大 |
| 自动更新 | 第二阶段实现，且依赖代码签名先就位 | 首版优先验证核心产品闭环 |
| Service Worker | MVP 桌面模式绕过注册 | 降低 Tauri 自定义协议兼容风险 |
| Secret 存储插件 | 评审时在 `tauri-plugin-keyring` 和 `tauri-plugin-stronghold` 中二选一 | 两者跨平台行为和运维成本不同 |

## 13. 推荐决策

推荐采用本方案作为第一版架构：新增 Tauri 桌面壳，新增独立 AI 插件，通过
Provider 抽象支持多 LLM，并把 fork 自有代码集中在清晰目录内。该方案在交付
速度、可扩展性和 upstream 同步成本之间取得较好平衡，适合作为长期 fork 的
基础架构。

## 14. 代码改动清单

本仓库（lean repo）预计新增的文件，路径相对仓库根：

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

`desktop/package.json` 最小草案：

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

Tauri 前端包与 Rust crate 必须保持主版本号兼容；secret plugin 包在 §12 决策
落定后再加入依赖。

插件自动注册：`scripts/sync-overlay.sh` 把 `ui-overlay/plugins/<name>/`
rsync 进 `third_party/perfetto/ui/src/plugins/<name>/` 之后，下次构建时
Perfetto 的 `ui/build.js` 会扫描 `ui/src/plugins/*/index.ts` 并生成
`ui/src/gen/all_plugins.ts`，自动捡到 overlay。**插件注册无需任何 upstream
patch**。

针对 upstream Perfetto 的修改以 `.patch` 文件形式落在 `patches/perfetto/`，
由 `git format-patch` 或 `git diff` 针对锁定的 SHA 生成。预期 patch slot：

| Patch | 用途 | 是否必需？ |
| --- | --- | --- |
| `0001-bypass-sw-when-fork-flag.patch` | 在 `serviceWorkerController.install()` 前 gate `window.__PERFETTO_FORK__?.desktop` | 取决实测:仅当 Tauri WebView 拒绝 Perfetto SW 时需要(阶段 1 验证:WKWebView 已经走 user-disabled 分支跳过 SW 注册,该 patch 至今没有触发) |
| `0002-default-enable-perfetto-mcp.patch` | 把 `'com.google.PerfettoMcp'` 追加进上游 `ui/src/core/embedder/default_plugins.ts` 的 `defaultPlugins` 白名单 | **2026-05-08 落地。** 首次用户加载 trace 后 sidebar 直接出现 AI Chat 菜单,无需先去 Plugins 设置页手动 toggle。该数组仅决定 feature flag 默认值,用户后续手动 toggle 仍然生效。 |
| `0003-strip-analytics-from-csp.patch` | 桌面模式下从运行时 meta CSP 剥离 GA/GTM 源 | 可选;取决于 §15 选定的 CSP 策略 |

slot `0002-default-enable-perfetto-mcp.patch` 之前曾承载另一个用途
(在 fork 插件自带 Gemini 路径时把 `com.google.PerfettoMcp` 从插件注册
中过滤掉)。阶段 1 验证表明上游 MCP 在 Tauri WKWebView 下完全可用,fork
插件改为与之共存(详见 §10),slot 因此被重新用于"为首次用户默认启用
上游 MCP"这件事。

`scripts/apply-patches.sh` 是幂等的: `git apply --reverse --check`
成功(即 patch 已应用)时跳过,只有未应用且能正向 apply 时才落到 worktree。
在已经固定 SHA、已经打过 patch 的 checkout 上重新跑 setup.sh 是 no-op。

Phase 1 预期 0 patch。每个 patch 只在它的触发条件被实测验证后才落地。

原则：

- 本仓库 git 历史**不修改**任何 upstream Perfetto 源码。
- 任何针对 upstream 的修改走 `patches/perfetto/`，**不**直接编辑
  `third_party/perfetto/`（那些临时编辑会被下一次 setup 抹掉）。
- 自动生成的 `Android.bp`、Bazel 文件不在本仓库手动维护。

## 15. Tauri 配置草案

Tauri 项目使用 Perfetto UI 构建产物作为前端资源。配置示意：

```json
{
  "build": {
    "beforeBuildCommand": "cd ../third_party/perfetto && ./ui/build",
    "beforeDevCommand": "cd ../third_party/perfetto && ./ui/node ./ui/build.js --serve --serve-port 10000 --watch",
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

`beforeDevCommand` 直接调用 `ui/build.js` 而非 `ui/run-dev-server`，
原因是 wrapper 脚本硬编码 `--only-wasm-memory64`，而 macOS WKWebView
不支持 Memory64 WASM，见 §6.1。`beforeBuildCommand` 仍用 `./ui/build`，
因为该脚本不带这个 flag。

`frontendDist` 相对 `tauri.conf.json` 解析（从 `desktop/src-tauri/`
出发），所以前缀是两个 `../`。

上述 CSP 示例对应「简化 Perfetto 运行时 CSP」选项,由
`patches/perfetto/0003-strip-analytics-from-csp.patch` 在 setup 时作用于
`third_party/perfetto/ui/src/frontend/index.ts`。

Tauri 2 需要显式 capability 才能让前端调用 IPC、dialog、fs 和 secret 存储。
最小 capability 草案：

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

Secret 存储插件需要在 MVP 评审时二选一：

| 选项 | 说明 | 取舍 |
| --- | --- | --- |
| `tauri-plugin-keyring` | 使用系统 keychain/credential vault/libsecret | 推荐优先评估；更贴近系统体验，跨平台差异需要验证 |
| `tauri-plugin-stronghold` | 使用加密本地 vault | 行为更统一，需要管理 vault 初始化和口令策略 |

如果自定义 `app.security.csp`，需要确认 Tauri IPC origin 不被拦截。Tauri 2
通常会为 IPC 注入所需源，但自定义 CSP 后必须在 smoke test 中验证
`invoke('secret_get')`、`invoke('secret_set')`、dialog 和 fs 命令可用。
capability 需要同时允许 fork 自有 wrapper command 和最终选定 secret plugin
的权限。
CSP 策略需要在 MVP 实现时三选一：

| 选项 | 说明 | 取舍 |
| --- | --- | --- |
| 简化 Perfetto 运行时 CSP | fork patch 去掉桌面不需要的 Google Analytics/GTM 源，再让 Tauri CSP 对齐 | 最可控，需要维护小 patch |
| Tauri CSP 覆盖运行时全集 | 复制 Perfetto meta CSP 中的 `script-src`、hash 和连接源 | 少改 UI，但配置容易随 upstream 变化漂移 |
| 不覆盖 Tauri CSP | 不在 `tauri.conf.json` 里覆盖 `app.security.csp`，沿用 Tauri 默认值，由 Perfetto 运行时 meta CSP 提供主要策略 | 简化调试，但需要确认当前 Tauri 版本允许并满足安全要求 |

需要验证的权限和能力：

- 文件打开：允许读取用户显式选择的 trace 文件。
- 网络访问：MVP 允许访问用户配置的 HTTPS Provider endpoint。
- 安全存储：启用 keychain/credential vault/libsecret 等平台能力。
- CSP：允许 Perfetto UI 所需 WASM、worker 和 Provider 请求。

MVP 不开放任意文件系统访问，不开放 shell 执行能力，不默认启用 sidecar。

## 16. Provider 兼容矩阵

| Provider | 协议/SDK | Tool calling | Streaming | MVP | 备注 |
| --- | --- | --- | --- | --- | --- |
| Gemini | `@google/genai` | 支持，手动 loop | 可后续支持 | 是 | 复用工具定义经验，不复用自动调用路径 |
| OpenAI-compatible | HTTPS `chat/completions` | 视模型而定 | 可后续支持 | 是 | 覆盖 OpenAI、DeepSeek、Qwen、vLLM 等 HTTPS endpoint |
| Anthropic | HTTPS Messages API | 支持 | 可后续支持 | 否 | 第二阶段加入 |
| Ollama | OpenAI-compatible 或原生 API | 视模型而定 | 可后续支持 | 否 | 本地 HTTP 需 CSP patch 或 Tauri 代理 |

MVP 不强制实现 streaming。先保证 tool-call loop、错误处理和结果展示稳定。

## 17. Tool 协议与数据限制

工具定义以内部 `PerfettoAiTool` 为主，Provider adapter 负责协议转换。MVP 不
要求复刻 `com.google.PerfettoMcp` 的 MCP server/client 拓扑，可以直接维护
`Map<string, PerfettoAiTool>`。示例：

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

- 复用 MCP SDK 可提供的 JSON Schema 路径，MVP 避免新增 `zod-to-json-schema`
  依赖；若实际实现发现缺口，再专项引入转换库。
- JSON Schema 转 OpenAI/Anthropic/Gemini 对应 tool 声明。
- tool result 统一序列化为 JSON 文本。
- tool result 在 `ChatMessage` 中以 JSON 字符串承载，插件渲染时按需解析。
- `bigint` 转字符串，避免 JSON 精度丢失。
- binary/blob 数据不直接传给模型，只返回摘要或错误。

默认限制建议：

| 项目 | 默认值 |
| --- | --- |
| 单轮最大 tool call | 20 |
| 单次 SQL 最大返回行数 | 1000，可由工具入参 `limit` 覆盖 |
| 单次 tool result 最大字符数 | 64 KiB |
| 单次 Provider 请求超时 | 60 秒 |
| 单次 SQL 查询超时 | 30 秒，插件层定时丢弃，不强制中断 WASM |

SQL 工具返回格式建议：

```json
{
  "columns": ["ts", "dur", "name"],
  "rows": [["123", "456", "slice"]],
  "rowCount": 1,
  "truncated": false
}
```

失败返回格式建议：

```json
{
  "error": {
    "type": "SqlError",
    "message": "no such table: foo",
    "recoverable": true
  }
}
```

## 18. 插件启用策略

推荐 MVP 默认在 fork 桌面版中启用 `com.tooluselabs.PerfettoDesktop`，Web 构建中保留可启用
能力但不默认展示敏感配置入口。

与 `com.google.PerfettoMcp` 的关系：

- 不删除 upstream 插件。
- 不复用 `com.google.*` 命名空间。
- 两个插件在桌面构建中**共存**。阶段 1 验证(2026-05-08)确认上游
  `com.google.PerfettoMcp` 在 Tauri WKWebView 中可正常激活,Gemini SDK
  调用链路完整跑通;有 Gemini API key 的用户直接使用上游的 AI Chat。
- fork 自有插件提供独立的 AI Chat 入口,覆盖非 Gemini 的 Provider(阶段 2
  优先 DeepSeek + ZAI 经 OpenAI-compat,Anthropic 延后)。两个入口的菜单
  文案需要区分 —— 例如上游沿用 `AI Chat`(仅 Gemini,在 `current_trace`
  section),fork 命名为 `Multi-LLM Chat`(或类似)。

## 19. 测试计划

Provider adapter 和 tool-call loop 单测在 `ui/` 现有 Jest 测试体系中执行。
Tauri smoke test 在 MVP 阶段可以先使用人工 checklist，后续再自动化。

单元测试：

- Provider adapter：工具声明转换、tool result 转换、错误转换。
  OpenAI-compatible 直接 mock `fetch`；Gemini adapter 用 Jest module mock
  替换 SDK 客户端。
- Tool-call loop：多轮调用、达到最大次数、工具失败、用户中止。
- 设置解析：Provider、Base URL、Model、API key 缺失场景。

集成测试：

- 使用 fake LLM 返回固定 tool call，验证工具执行和结果回传。
- 使用小型 trace 文件验证 SQL 查询工具。
- 验证无网络、401、429、timeout、Provider 返回畸形 tool call。
- 验证达到 `Max Tool Calls` 后停止、工具抛错不死循环、Stop 能中断请求。

桌面 smoke test：

- Tauri dev 模式能加载 UI。
- 打包产物能启动。
- 本地 trace 可打开。
- AI Chat 页面可进入。
- API key 不出现在普通日志和 localStorage；自动化断言
  `localStorage.getItem('perfettoSettings')` 不包含测试 key 片段。
- Secret bridge round-trip：`invoke('secret_set')` 后 `invoke('secret_get')`
  能读回同值，应用重启后仍可读取；卸载行为按最终选定 secret plugin 文档
  校验。
- Service Worker 在桌面模式下被绕过或状态正常。
- WASM、worker 和 `dist/<version>/` 版本化资源可加载。
- Tauri capability 覆盖 dialog、fs、secret storage 所需权限。

大文件测试：

- 至少使用一个百 MB 级 trace 验证打开流程。
- 验证 tool result 截断不会卡死 UI。

## 20. 故障诊断与日志

桌面版需要提供基础诊断能力：

- About 页面或诊断面板展示应用版本、upstream commit、构建时间。
- Provider 请求失败展示 Provider、状态码、错误类型和脱敏消息。
- Secret 写入失败时提示用户授权 keychain，或建议切换到 stronghold 模式；
  不静默丢弃 API key。
- Tool-call 历史可展开查看，但默认折叠。
- 日志中禁止记录 API key、完整 Authorization header。
- 支持导出诊断信息，内容包括配置摘要、版本信息、最近错误，不包含 trace
  原始数据和密钥。

建议日志分层：

| 类型 | 内容 |
| --- | --- |
| UI 日志 | 页面错误、插件错误、tool-call 状态 |
| Provider 日志 | endpoint host、状态码、耗时、错误类型 |
| Tauri 日志 | 启动、文件打开、存储读写失败 |

## 21. Upstream Drift 检查清单

每次 DEPS bump 后跑 `./scripts/setup.sh` 并检查：

- `apply-patches.sh` 所有 patch 都干净应用。任何 patch 失败就先 rebase
  patch 再 bump SHA。
- `sync-overlay.sh` 把 overlay 落到正确路径。
- overlay 插件仍被注册（构建后看
  `third_party/perfetto/ui/src/gen/all_plugins.ts`）。
- `(cd third_party/perfetto && ./ui/build --typecheck)` 通过。
- `(cd third_party/perfetto && ./ui/run-unittests)` 通过。
- `com.google.PerfettoMcp` 是否有值得移植的 tool 更新。
- `third_party/perfetto/ui/out/dist` 结构（特别是 `dist/<version>/`）未
  变化或已被 Tauri 配置吸收。
- Service Worker bypass patch 行为在新构建后
  保持一致。
- `third_party/perfetto/ui/src/frontend/index.ts` 的 CSP 没发生影响
  Provider endpoint 的变化。
- Tauri 2 插件或 capability schema 没引入 breaking change。

如果 upstream 改了某个 patch 依赖的代码行，patch 会在 setup 时立刻报错。
处理顺序：优先调整 overlay 插件，其次更新 patch 上下文。**绝不**直接编辑
`third_party/perfetto/`——那些编辑会被下次 setup 抹掉。
