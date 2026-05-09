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

[Tooluse Labs](https://github.com/tooluse-labs) 出品的 Perfetto 桌面客户端，
基于 Tauri 2，把官方 Perfetto UI 装成一个原生桌面应用，并加上一个叫
**CLI Agent** 的本地 MCP bridge——让 Codex、Claude Code 这类 MCP agent
直接对你当前在 GUI 里打开的 trace 干活。

仓库里只放产品代码。Perfetto 上游本身当作构建依赖处理：版本由
[`DEPS`](DEPS) 里的 SHA 锁定，由 [`scripts/setup.sh`](scripts/setup.sh)
拉到 `third_party/perfetto/`。我们不会改上游源码，万一非改不可，就以补丁
形式放在 `patches/perfetto/` 下，setup 时再打上去。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `desktop/` | Tauri 项目（桌面壳本体） |
| `ui-overlay/` | fork 自己的 UI 插件，setup 阶段覆盖到 Perfetto UI 源码树 |
| `patches/perfetto/` | setup 阶段打到 Perfetto checkout 上的 git 补丁 |
| `scripts/` | `setup.sh`、`apply-patches.sh`、`sync-overlay.sh`、`update-perfetto.sh` |
| `third_party/perfetto/` | 已 gitignore，由 `setup.sh` 填充 |
| `docs/design-docs/` | 架构与发布相关的设计文档 |

## 下载

GitHub Actions 的 release workflow 会产出：

- macOS arm64：未签名 DMG。
- Windows x64：未签名 NSIS `.exe` 与 MSI `.msi` 安装包。

应用还没做代码签名，所以首次运行时 macOS Gatekeeper 和 Windows SmartScreen
可能会弹警告。

## 快速上手

```sh
git clone https://github.com/tooluse-labs/perfetto-desktop
cd perfetto-desktop
./scripts/bootstrap.sh                          # 本机工具链 (pnpm + rustup)，每台机器只用跑一次
./scripts/setup.sh                              # 拉 Perfetto 上游 + UI 构建依赖
(cd desktop && pnpm install && pnpm tauri dev)  # 起 Tauri 壳
```

`pnpm tauri dev` 走的是 `tauri.conf.json:beforeDevCommand`，直接调
`ui/build.js` 而不是 `ui/run-dev-server`——后者把 `--only-wasm-memory64`
写死了，但 macOS 的 WKWebView 加载不了 Memory64 WASM。详见
`docs/design-docs/perfetto-desktop-architecture.md` §6.1。

`scripts/bootstrap.sh` 暂时只覆盖 macOS。Windows 安装包靠 CI 在
`windows-latest` 上出（Perfetto UI 先在 Linux 上预编译好，再喂给 Windows
打包流程）；本地 Windows 的 bootstrap 文档先欠着。

## CLI Agent

CLI Agent 就是 Perfetto Desktop 起的一个本地 MCP bridge。让外部 agent 借
你已有的 Codex / Claude Code 订阅干活，trace 和 UI 状态依然由 Perfetto
Desktop 管。

用法：

1. 打开 Perfetto Desktop，加载一个 trace。
2. 在侧边栏 "current trace" 分组里点 **CLI Agent**。
3. 把生成的 **Codex** 或 **Claude Code** 命令拷出来。
4. 在终端跑这条命令，让 agent 去分析当前 trace。

复制按钮在 trace 加载完之前是灰的，确保 agent 一上来就有 trace 上下文。
Bridge 只听 loopback，要 Bearer token 才放行，浏览器跨站请求一律拒，
桌面端单实例运行，所以同一时间只有一个本地 MCP 端口在工作。

工具命名尽量沿用上游 Perfetto MCP，主要这些：

- `perfetto-get-trace-info`
- `perfetto-execute-query`
- `perfetto-list-interesting-tables`
- `perfetto-list-table-structure`
- `show-perfetto-sql-view`
- `show-timeline`

## 为什么做 CLI Agent，而不扩展 AI Chat

Upstream 的 AI Chat 是围着 Gemini Files API + Gemini 自家的 tool contract
写的，要再加一个 provider 基本等于把 chat UI、流式、文件上传、模型适配层
全部重写。CLI Agent 干脆不接这一摊：对话、流式、重试、账号都交给用户已经
在用的 Codex / Claude Code / Cursor / Claude Desktop，Perfetto Desktop
只把当前 trace 按标准 MCP 工具暴露出去——任何讲 MCP 的 host 都能直接接上，
我们也不用为每家 provider 各做一份 chat 界面。

## 为什么不在桌面端嵌入终端

Perfetto Desktop 既不开 PTY 也不代理 agent CLI。用户的 CLI 还是跑在用户
自己的终端里，模型 API key、agent 工作目录、shell 历史这些东西都不会落到
Perfetto Desktop 进程里。规划中的 `Open in Terminal` QoL（Phase C）也就只是
把连接命令预填进系统终端而已，回车还是用户按，agent 进程依然由用户掌握。

## 设计

完整设计见
[docs/design-docs/perfetto-desktop-architecture.zh-CN.md](docs/design-docs/perfetto-desktop-architecture.zh-CN.md)
（或
[英文版](docs/design-docs/perfetto-desktop-architecture.md)），
里面有架构、MVP 验收标准、以及发布节奏。

## 与上游 Perfetto 的关系

- 仓库历史里我们不会动上游 Perfetto 任何一行代码。
- 通过 `scripts/update-perfetto.sh` 定期 bump 固定的 SHA，跟上上游修复
  和新特性。每个 stable release 锁在打 tag 时的 SHA。
- 实在绕不过去要打补丁，就放进 `patches/perfetto/` 当 `.patch` 文件，
  setup 阶段自动应用。`apply-patches.sh` 一旦发现某个补丁不再能干净
  应用就直接报错退出，把 upstream drift 这种问题挡在 setup 阶段，
  不会带到构建。

## Perfetto Desktop vs perfetto-mcp-rs

[`tooluse-labs/perfetto-mcp-rs`](https://github.com/tooluse-labs/perfetto-mcp-rs)
是无头版的姊妹项目。如果你只想从 CLI 或编辑器里直接喂 trace 文件给一个
MCP server，根本不打算开 Perfetto Desktop——选它就好。它是个独立的 Rust
二进制，走 stdio 讲 MCP，自动管 `trace_processor_shell`，还内置了一套
Chrome 专项工具：scroll jank、page load、startup、主线程 hotspot 之类。

如果 trace 已经在 GUI 里打开，你想让 agent 共用同一份上下文，跑点受限的
PerfettoSQL，或者驱动 Perfetto UI（开 SQL view、把 timeline 拉到某段
时间……），那就走 Perfetto Desktop CLI Agent。

| 维度 | Perfetto Desktop CLI Agent | `perfetto-mcp-rs` |
| --- | --- | --- |
| 主要场景 | Perfetto UI 已经打开时的交互式排查。 | 终端、编辑器、或者 MCP 客户端里的无头分析。 |
| 运行形态 | Tauri 桌面应用 + 一个 loopback HTTP MCP bridge。 | 独立 Rust MCP server 二进制。 |
| MCP 传输 | `127.0.0.1` 上的 Streamable HTTP，配 Bearer token。 | 客户端拉起的 stdio MCP。 |
| Trace 归属 | Trace 与 UI 状态都归 Perfetto Desktop 管。 | MCP server 按 agent 给的路径加载 trace 文件。 |
| UI 控制 | 可以做经过审核的 UI 动作（开 SQL view、聚焦 timeline 等）。 | 没有 GUI，只把数据和摘要回给 MCP 客户端。 |
| SQL 访问 | 对 GUI 当前加载的 trace 跑受限 PerfettoSQL。 | `execute_sql` 跑 PerfettoSQL，结果是带行数上限的列式 JSON。 |
| Schema 探索 | 沿用上游 Perfetto MCP 那套表/结构工具。 | 自带 `list_tables`、`list_table_structure`、process/thread 辅助、stdlib 模块发现。 |
| Chrome 专项分析 | 通用 PerfettoSQL + UI 协助。 | 内置 Chrome 工具：scroll jank、page load、startup、主线程 hotspot、interactions。 |
| `trace_processor_shell` | 直接复用桌面应用里 Perfetto UI 的 trace engine。 | 自动下载和管理，或者读 `PERFETTO_TP_PATH`。 |
| 客户端配置 | 在应用里按会话复制命令；token 随桌面会话轮换。 | 安装器能自动注册到 Claude Code / Codex；也能手配 MCP。 |
| 平台 | 桌面应用：macOS arm64、Windows x64。 | Linux、macOS、Windows 都有预编译。 |
| 批量 / CI 场景 | 不太适合；要桌面应用 + UI 已加载的 trace。 | 适合脚本、可重复 CLI 工作流、CI 风格的批量分析。 |
| 安全边界 | 本地 loopback server，bearer 鉴权 + host/origin 校验 + 桌面单实例。 | stdio 进程边界；能访问什么完全看 MCP 客户端让它加载哪些路径。 |

## License

Apache 2.0，跟 upstream Perfetto 一致。
