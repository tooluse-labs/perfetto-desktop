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

由 [Tooluse Labs](https://github.com/tooluse-labs) 构建的 Tauri 2 桌面壳，把
upstream Perfetto UI 打包成原生桌面应用，并附带 **CLI Agent** —— 一个本地
MCP bridge，让 Codex、Claude Code 以及其他 agentic MCP 客户端能直接对当前 GUI 中
打开的 trace 进行分析。

本仓库只承载产品代码。Upstream Perfetto 源码视作构建依赖：通过
[`DEPS`](DEPS) 中固定的 SHA 指定版本，由
[`scripts/setup.sh`](scripts/setup.sh) 拉到 `third_party/perfetto/`。
本仓库的提交历史中从不直接修改 upstream 代码;不可避免的补丁以
`.patch` 文件形式放在 `patches/perfetto/` 下,在 setup 阶段应用。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `desktop/` | Tauri 项目（桌面壳） |
| `ui-overlay/` | fork 自有的 UI 插件，setup 阶段叠加到 Perfetto UI 树。 |
| `patches/perfetto/` | 在 setup 阶段应用到 Perfetto checkout 的 git 补丁。 |
| `scripts/` | `setup.sh`、`apply-patches.sh`、`sync-overlay.sh`、`update-perfetto.sh` |
| `third_party/perfetto/` | Gitignore，由 `setup.sh` 填充。 |
| `docs/design-docs/` | 架构和发布文档 |

## 下载

Release 构建由 GitHub Actions release workflow 产出：

- macOS arm64：未签名 DMG。
- Windows x64：未签名 NSIS `.exe` 与 MSI `.msi` 安装包。

应用尚未代码签名。macOS Gatekeeper 与 Windows SmartScreen 在首次运行时
可能弹出警告。

## 快速开始

```sh
git clone https://github.com/tooluse-labs/perfetto-desktop
cd perfetto-desktop
./scripts/bootstrap.sh                          # 主机工具链 (pnpm + rustup)，每台机器跑一次
./scripts/setup.sh                              # 拉取并固定 upstream Perfetto + UI 构建依赖
(cd desktop && pnpm install && pnpm tauri dev)  # 启动 Tauri 壳
```

`pnpm tauri dev` 通过 `tauri.conf.json:beforeDevCommand` 直接拉起 Perfetto UI
开发服务器。它调用的是 `ui/build.js` 而不是 `ui/run-dev-server`，因为后者
硬编码了 `--only-wasm-memory64`，而 macOS WKWebView 无法加载 Memory64 WASM。
详见 `docs/design-docs/perfetto-desktop-architecture.md` §6.1。

`scripts/bootstrap.sh` 当前只支持 macOS。CI 在 `windows-latest` 上构建 Windows
安装包（Perfetto UI 在 Linux 上预构建，再交给 Windows 打包 job 消费）；本地
Windows bootstrap 文档暂未补齐。

## CLI Agent

CLI Agent 是 Perfetto Desktop 暴露出的本地 MCP bridge。它让外部 agent 复用你
已有的 Codex / Claude Code 订阅，同时把 trace 与 UI 状态的所有权留在 Perfetto
Desktop。

典型流程：

1. 启动 Perfetto Desktop 并打开一个 trace。
2. 在侧边栏 current trace 区域打开 **CLI Agent**。
3. 拷贝生成的 **Codex** 或 **Claude Code** 命令。
4. 在终端里执行命令，让 agent 分析当前加载的 trace。

复制按钮在 trace 加载之前保持禁用，确保 agent 启动时已经有 trace 上下文。
Bridge 只监听 loopback；要求 Bearer token 鉴权；拒绝浏览器风格的 cross-site
请求；以单实例方式运行，确保只有一个本地 MCP 端点占用默认端口。

暴露的工具尽量复用 upstream Perfetto MCP 命名，包括：

- `perfetto-get-trace-info`
- `perfetto-execute-query`
- `perfetto-list-interesting-tables`
- `perfetto-list-table-structure`
- `show-perfetto-sql-view`
- `show-timeline`

## 为什么做本地 MCP bridge

**为什么不直接扩展 upstream 的 AI Chat 面板？** Upstream AI Chat 是围绕
Gemini Files API 和 Gemini 特有的 tool contract 搭起来的；要加 provider
就得重做整个 chat UI、流式、文件上传与模型适配层。CLI Agent 的思路是把
对话、流式、重试、账号管理交给用户已经在用的 Codex / Claude Code / Cursor /
Claude Desktop，Perfetto Desktop 只把当前 trace 暴露成标准 MCP 工具——任何
讲 MCP 的 host 都能用，我们也不必为每个 provider 单独维护 chat 界面。

**为什么不嵌入终端？** Perfetto Desktop 不启动 PTY，也不代理 agent CLI。
用户的 CLI 进程留在用户自己的终端里，模型 API key、agent 工作目录、shell
history 都不会进入 Perfetto Desktop 的进程地址空间。侧边栏规划中的 `Open
in Terminal` QoL（Phase C）只会拉起系统终端并把连接命令预填进去——用户仍
需自己按 Enter，agent 进程仍由用户掌控。

## 设计

参见
[docs/design-docs/perfetto-desktop-architecture.zh-CN.md](docs/design-docs/perfetto-desktop-architecture.zh-CN.md)
（或
[英文版](docs/design-docs/perfetto-desktop-architecture.md)）
了解架构、MVP 验收标准与发布计划。

## 与 upstream 的关系

- 仓库提交历史中从不修改 upstream Perfetto。
- 固定的 SHA 通过 `scripts/update-perfetto.sh` 周期性 bump，让桌面壳跟上
  upstream Perfetto 的修复与新特性。Stable release 锁在打 tag 时的 SHA。
- 如果某次必须打补丁，就以 `.patch` 文件形式放在 `patches/perfetto/` 下，
  在 setup 阶段应用。`apply-patches.sh` 在补丁不再 clean 应用时会大声失败，
  把 upstream drift 的问题前移到 setup 阶段。

## Perfetto Desktop vs perfetto-mcp-rs

[`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
是无头版的伴生项目。当你想要一个能从 CLI 或编辑器直接加载 trace 文件、不
需要打开 Perfetto Desktop 的 MCP server 时，用它。它是独立的 Rust 二进制，
通过 stdio 讲 MCP，自动下载/管理 `trace_processor_shell`，并附带 Chrome
专属分析工具（scroll jank、page load、startup、main-thread hotspot 等）。

当 trace 已经在 GUI 里打开，你希望 agent 分享同一份上下文、跑受限的
PerfettoSQL、或驱动经过审核的 Perfetto UI 操作（开 SQL view、聚焦 timeline
区间等）时，用 Perfetto Desktop CLI Agent。

| 维度 | Perfetto Desktop CLI Agent | `perfetto-mcp-rs` |
| --- | --- | --- |
| 主要场景 | 在 Perfetto UI 可见的情况下交互式排查 trace。 | 在终端、编辑器或 MCP 客户端里做无头 trace 分析。 |
| 运行形态 | 原生 Tauri 桌面应用 + loopback HTTP MCP bridge。 | 独立的 Rust MCP server 二进制。 |
| MCP transport | `127.0.0.1` 上的 Streamable HTTP，配合生成的 Bearer token。 | 由客户端直接拉起的 stdio MCP。 |
| Trace 所有权 | Perfetto Desktop 持有当前 trace 与 UI 状态。 | MCP server 按 agent 提供的路径加载 trace 文件。 |
| UI 控制 | 可暴露经过审核的 UI 操作，如 SQL view 创建、timeline 聚焦。 | 无 GUI，只向 MCP 客户端返回数据和摘要。 |
| SQL 访问 | 针对当前 GUI 加载 trace 的受限 PerfettoSQL。 | 通过 `execute_sql` 跑 PerfettoSQL，返回带行数上限的列式 JSON。 |
| schema 探索 | 复用 upstream Perfetto MCP 的表与结构工具。 | 提供 `list_tables`、`list_table_structure`、process/thread 辅助、stdlib 模块发现等。 |
| Chrome 专项分析 | 通用 PerfettoSQL + UI 协助排查。 | 内置 Chrome 工具：scroll jank、page load、startup、主线程 hotspot、interactions。 |
| `trace_processor_shell` | 复用桌面应用里 Perfetto UI 已加载的 trace 引擎。 | 自动下载/管理 `trace_processor_shell`，或读 `PERFETTO_TP_PATH`。 |
| 客户端配置 | 从应用里复制每会话命令；token 随桌面会话轮转。 | 安装器可自动注册 Claude Code 与 Codex；也支持手动配置 MCP。 |
| 平台目标 | 桌面 release：macOS arm64 与 Windows x64 安装包。 | Linux、macOS、Windows 预编译二进制。 |
| 批量/CI 适配 | 不太合适；需要桌面应用与已加载的 UI trace。 | 适合脚本、可重复 CLI 工作流和 CI 风格的分析。 |
| 安全边界 | 本地 loopback server，配合 bearer 鉴权、host/origin 校验、桌面单实例。 | stdio 进程边界；可访问范围由 MCP 客户端要求加载的文件路径决定。 |

## License

Apache 2.0，与 upstream Perfetto 一致。
