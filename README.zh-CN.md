<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="desktop/branding/lockup-dark.svg">
    <img src="desktop/branding/lockup-light.svg" alt="Perfetto Desktop — Unofficial desktop wrapper for Perfetto." width="720">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tooluse-labs/perfetto-desktop/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="docs/design-docs/perfetto-desktop-architecture.zh-CN.md"><img alt="Status" src="https://img.shields.io/badge/status-CLI%20Agent%20preview-orange.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

---

[Tooluse Labs](https://github.com/tooluse-labs) 构建的 Perfetto 桌面客户端，
基于 Tauri 2 将官方 Perfetto UI 封装为原生桌面应用，并新增 **CLI Agent** ——
一个本地 MCP bridge，使 Codex、Claude Code 等 MCP agent 能够直接基于 GUI
当前打开的 trace 进行分析。

本仓库仅托管产品代码。Perfetto 上游作为构建依赖处理：版本由
[`DEPS`](DEPS) 中的 SHA 锁定，由 [`scripts/setup.sh`](scripts/setup.sh)
拉取至 `third_party/perfetto/`。我们不会修改上游源码；如确需调整，则以
补丁文件形式置于 `patches/perfetto/` 目录，在 setup 阶段统一应用。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `desktop/` | Tauri 项目（桌面壳） |
| `ui-overlay/` | fork 自有的 UI 插件，setup 阶段覆盖到 Perfetto UI 源码树 |
| `patches/perfetto/` | setup 阶段应用到 Perfetto checkout 的 git 补丁 |
| `scripts/` | `setup.sh`、`apply-patches.sh`、`sync-overlay.sh`、`update-perfetto.sh` |
| `third_party/perfetto/` | 已 gitignore，由 `setup.sh` 填充 |
| `docs/design-docs/` | 架构与发布相关的设计文档 |

## 下载

Release 构建由 GitHub Actions release workflow 产出：

- macOS arm64：未签名 DMG。
- Windows x64：未签名 NSIS `.exe` 与 MSI `.msi` 安装包。

应用尚未代码签名，因此首次启动时 macOS Gatekeeper 与 Windows SmartScreen
可能会弹出警告。

## 快速开始

```sh
git clone https://github.com/tooluse-labs/perfetto-desktop
cd perfetto-desktop
./scripts/bootstrap.sh                          # 本机工具链 (pnpm + rustup)，每台机器仅需执行一次
./scripts/setup.sh                              # 拉取 Perfetto 上游与 UI 构建依赖
(cd desktop && pnpm install && pnpm tauri dev)  # 启动 Tauri 壳
```

`pnpm tauri dev` 通过 `tauri.conf.json:beforeDevCommand` 直接调用
`ui/build.js`，而非 `ui/run-dev-server`——后者将 `--only-wasm-memory64`
写死在内部，但 macOS 的 WKWebView 无法加载 Memory64 WASM。详见
`docs/design-docs/perfetto-desktop-architecture.md` §6.1。

`scripts/bootstrap.sh` 当前仅覆盖 macOS。Windows 安装包由 CI 在
`windows-latest` 上构建（Perfetto UI 在 Linux 上预编译，再交由 Windows
打包流程消费）；本地 Windows 的 bootstrap 文档暂未补齐。

## CLI Agent

CLI Agent 是 Perfetto Desktop 提供的本地 MCP bridge，允许外部 agent 借助
你已有的 Codex / Claude Code 订阅工作，trace 与 UI 状态则仍由 Perfetto
Desktop 持有。

使用流程：

1. 启动 Perfetto Desktop，加载一个 trace。
2. 在侧边栏 "current trace" 分组中打开 **CLI Agent**。
3. 复制生成的 **Codex** 或 **Claude Code** 命令。
4. 在终端中执行该命令，让 agent 分析当前 trace。

在 trace 加载完成前，复制按钮保持禁用，以确保 agent 启动时即具备 trace
上下文。Bridge 仅监听 loopback，校验 Bearer token 后才放行请求；浏览器
跨站请求一律拒绝；桌面端以单实例运行，确保同一时间只有一个本地 MCP
端口对外服务。

工具命名尽量沿用上游 Perfetto MCP，主要包括：

- `perfetto-get-trace-info`
- `perfetto-execute-query`
- `perfetto-list-interesting-tables`
- `perfetto-list-table-structure`
- `show-perfetto-sql-view`
- `show-timeline`

## 为什么做 CLI Agent，而不扩展 AI Chat

把 AI Chat 扩成多 provider 在技术上并不困难——我们本地已经实现过一版
多 LLM chat 界面，最终选择不上线。卡点不在工程，而在性价比。应用内
chat 面板只能走原始 API key 鉴权，按 token 计费；而大多数用户已经在为
Codex、Claude Code、Cursor、Claude Desktop 这类订阅制 agent 付月费。
让这些已有的 CLI 通过 MCP bridge 接入 Perfetto Desktop，订阅本身就把
对话成本覆盖掉了——不需要再录一次 API key，不会重复扣费，也少一套账号
要维护。如果我们再做一份自有 chat，等于让用户为同一段对话付两次钱，
而外部 agent 在对话体验上更成熟，我们也做不出更好的差异化。

## 为什么不在桌面端嵌入终端

Perfetto Desktop 既不启动 PTY，也不代理 agent CLI。用户的 CLI 仍运行在
用户自己的终端中，模型 API key、agent 工作目录、shell 历史等均不会进入
Perfetto Desktop 的进程。规划中的 `Open in Terminal` QoL（Phase C）仅会
将连接命令预填至系统终端，由用户自行确认执行；agent 进程始终由用户管理。

## 设计

完整设计请参见
[docs/design-docs/perfetto-desktop-architecture.zh-CN.md](docs/design-docs/perfetto-desktop-architecture.zh-CN.md)
（或
[英文版](docs/design-docs/perfetto-desktop-architecture.md)），
其中涵盖架构、MVP 验收标准与发布节奏。

## 与上游 Perfetto 的关系

- 仓库提交历史中不修改上游 Perfetto 任何一行代码。
- 通过 `scripts/update-perfetto.sh` 定期 bump 固定的 SHA，以跟进上游的
  修复与新特性；stable release 锁定在打 tag 时的 SHA。
- 如确需打补丁，则以 `.patch` 文件形式置于 `patches/perfetto/`，setup
  阶段自动应用。`apply-patches.sh` 一旦检测到补丁无法干净应用即报错
  退出，将 upstream drift 类问题在 setup 阶段拦截，避免遗留至构建阶段。

## Perfetto Desktop vs perfetto-mcp-rs

[`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
是对应的无头版项目。若你仅需在 CLI 或编辑器中将 trace 文件直接提供给一
个 MCP server，而不打算启动 Perfetto Desktop，建议选用它。它是一个独立
的 Rust 二进制，通过 stdio 实现 MCP，自动管理 `trace_processor_shell`，
并内置 Chrome 专项分析工具：scroll jank、page load、startup、主线程
hotspot 等。

若 trace 已在 GUI 中加载，且希望 agent 与之共享同一上下文，运行受限的
PerfettoSQL，或驱动 Perfetto UI（打开 SQL view、将 timeline 定位到指定
时间区间等），则使用 Perfetto Desktop CLI Agent。

| 维度 | Perfetto Desktop CLI Agent | `perfetto-mcp-rs` |
| --- | --- | --- |
| 主要场景 | Perfetto UI 已加载时的交互式排查。 | 终端、编辑器或 MCP 客户端中的无头分析。 |
| 运行形态 | Tauri 桌面应用 + loopback HTTP MCP bridge。 | 独立的 Rust MCP server 二进制。 |
| MCP 传输 | `127.0.0.1` 上的 Streamable HTTP，配合 Bearer token。 | 由客户端拉起的 stdio MCP。 |
| Trace 归属 | Trace 与 UI 状态均由 Perfetto Desktop 持有。 | MCP server 按 agent 提供的路径加载 trace 文件。 |
| UI 控制 | 可执行经过审核的 UI 操作（打开 SQL view、聚焦 timeline 等）。 | 无 GUI，仅向 MCP 客户端返回数据与摘要。 |
| SQL 访问 | 针对 GUI 当前加载的 trace 执行受限 PerfettoSQL。 | 通过 `execute_sql` 执行 PerfettoSQL，返回带行数上限的列式 JSON。 |
| Schema 探索 | 沿用上游 Perfetto MCP 提供的表/结构工具。 | 内置 `list_tables`、`list_table_structure`、process/thread 辅助、stdlib 模块发现等。 |
| Chrome 专项分析 | 通用 PerfettoSQL，配合 UI 协助排查。 | 内置 Chrome 工具：scroll jank、page load、startup、主线程 hotspot、interactions。 |
| `trace_processor_shell` | 直接复用桌面应用中 Perfetto UI 的 trace engine。 | 自动下载与管理，或读取 `PERFETTO_TP_PATH`。 |
| 客户端配置 | 在应用内按会话复制命令；token 随桌面会话轮换。 | 安装器可自动注册至 Claude Code / Codex；亦支持手动配置 MCP。 |
| 平台 | 桌面应用：macOS arm64、Windows x64。 | Linux、macOS、Windows 均提供预编译。 |
| 批量 / CI 场景 | 不适合；需要桌面应用且 UI 已加载 trace。 | 适合脚本、可重复的 CLI 工作流与 CI 风格的批量分析。 |
| 安全边界 | 本地 loopback server，结合 Bearer 鉴权、host/origin 校验与桌面单实例。 | stdio 进程边界；可访问范围由 MCP 客户端指定的加载路径决定。 |

## License

Apache 2.0，与上游 Perfetto 一致。
