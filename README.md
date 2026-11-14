# antigravity-mcp-structured-content

> 原生 Antigravity（`agy`）零依赖插件：按**显式适配器注册表**无损保留并注入 MCP 工具的 `structuredContent` 字段，无需额外搭建外部 MCP 转发代理，让 `mcp_config.json` 直连官方 MCP 服务。

## 根因定位

1. **Antigravity 客户端侧（有意架构隔离，非解析 Bug）**：
   `language_server` 内部采用 SEP-1865（MCP Apps）的双路分离规范——`the model sees content; the app sees the full result`。`mcpcore.parseCallToolResult` 仅提取 `content[]` 中的文本与媒体内容写入模型可见步骤，主动过滤仅给前端 `ui://` 应用使用的 `structuredContent`；同时 `PostToolUse` 契约对 `call_mcp_tool` 不消费 `overwriteResult`。
2. **部分 MCP 服务端侧（未向下兼容回填文本）**：
   以 `cua-driver 0.49.x` 为例，部分工具（如 `browser_prepare`、`get_browser_state`、`browser_dialog`、`browser_download`、`get_session`、`list_sessions`）将 `prepared_pid`、`tab_id`、`refs`、`dialog_id`、`path`/`sha256` 及会话元数据仅放入 `structuredContent`，未在 `content[].text` 中输出，导致 Antigravity 模型侧拿不到必需句柄而卡死。

## 工作原理

- **显式适配器注册表（`adapters/registry.json`）**：精确列出需要补全的 `(server, tool)`，**绝不盲目猜测 `outputSchema`**（例如 `cua-driver` 的 `get_window_state` 等 33 个桌面工具声明了 `outputSchema` 且依赖原生截图，不能改写；而 `get_browser_state` 等核心工具反而没有声明 `outputSchema`）。
- **零侵入直通**：未在注册表里的工具在 `PreToolUse` / `PostToolUse` 立即直通（约 2 ms），原生截图与普通工具 100% 不受影响。
- **`PreToolUse` 桥接 + 持久影子连接池**：
  1. 命中注册表的 `call_mcp_tool` 在 `PreToolUse` 阶段直接将 `(ServerName, ToolName, Arguments)` 改写为插件内置桥接 MCP 工具 `antigravity-mcp-structured-content_bridge:get_structured_result`（无需目标服务提供额外只读 `noop` 工具）；
  2. 桥接 MCP 服务通过 Unix Socket（`/tmp/agy-mcp-sc-<uid>/pool.sock`）调用按需后台常驻的 Node.js 守护进程（`mcp_pool_daemon.mjs`，复用持久 stdio/HTTP MCP 会话，闲置 10 分钟自动退出）；
  3. 桥接服务保留原 `content[]` 与 `isError`，并追加 `\n[structuredContent] {...}` 文本块，作为真实 `CallToolResult` 原生返回给模型；
  4. 对于 `start_session` / `end_session` 等会话生命周期工具，`PostToolUse` 自动同步影子会话，保证 `isolated_new` 隔离浏览器在 `end_session` 时随宿主一并干净回收。

## 内置 `cua-driver` 显式适配清单

- **拦截补全（12 个工具）**：
  `browser_prepare`、`get_browser_state`、`browser_navigate`、`browser_type`、`browser_select`、`browser_click`、`browser_dialog`、`browser_set_input_files`、`browser_download`、`browser_pointer`、`get_session`、`list_sessions`
- **会话同步（2 个工具）**：
  `start_session`、`end_session`（`onlyIfActive: true`）
- **原生直通（其余 46 个工具）**：
  包括 `get_window_state`、`get_desktop_state`、`zoom`、`click`、`run_steps`、`run_script`、`start_recording` 等，原样直连 `cua-driver` 并保留原生内联截图。

## 安装方式

### 方式一：全局安装（推荐，对本机所有项目生效）

直接克隆到全局插件目录 `~/.gemini/config/plugins/`，Antigravity 客户端会自动发现并启用：

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/ymqy/antigravity-mcp-structured-content.git \
  ~/.gemini/config/plugins/antigravity-mcp-structured-content
```

如果你希望将源码放在自己的开发目录（方便本地修改与 `git pull` 更新），使用软链接挂载即可：

```bash
git clone https://github.com/ymqy/antigravity-mcp-structured-content.git
mkdir -p ~/.gemini/config/plugins
ln -sfn "$(pwd)/antigravity-mcp-structured-content" \
  ~/.gemini/config/plugins/antigravity-mcp-structured-content
```

### 方式二：工作区级安装（仅对单个项目生效）

将插件放入目标项目根目录下的 `.agents/plugins/` 目录：

```bash
mkdir -p .agents/plugins
git clone https://github.com/ymqy/antigravity-mcp-structured-content.git \
  .agents/plugins/antigravity-mcp-structured-content
```

## 目录结构

```text
antigravity-mcp-structured-content/
├── plugin.json               # 插件清单元数据
├── mcp_config.json           # 内置 bridge MCP 服务（namespaced: antigravity-mcp-structured-content_bridge）
├── hooks.json                # 仅匹配 call_mcp_tool (PreToolUse / PostToolUse)
├── adapters/
│   └── registry.json         # 显式适配器注册表
├── rules/
│   └── AGENTS.md             # 告知模型信任插件桥接返回的 [structuredContent] 结果
├── scripts/
│   ├── run_hook.sh           # POSIX fail-open Hook 入口（兼容 Dock/GUI 启动 PATH）
│   ├── run_bridge_mcp.sh     # POSIX bridge MCP 启动入口
│   ├── bridge_mcp.mjs        # stdio MCP 桥接服务（暴露 get_structured_result）
│   ├── hook_handler.mjs      # PreToolUse / PostToolUse 核心逻辑
│   ├── mcp_pool_daemon.mjs   # 按需持久 MCP 连接池守护进程（stdio / Streamable HTTP）
│   └── daemon_client.mjs     # Unix Socket IPC 客户端
└── assets/
    └── logo.svg
```

## 自定义扩展与运维命令

- **用户自定义覆盖**：可在 `~/.gemini/config/mcp_structured_content.json` 按相同 `{"servers": {...}}` 格式覆写或扩展其他 MCP 服务，无需改动插件仓库。
- **临时停用插件级拦截**：设置环境变量 `AGY_MCP_SC_DISABLE=1`，或在 Antigravity 插件管理页直接停用插件。
- **查看/关闭连接池守护进程**：

```bash
node ./scripts/mcp_pool_daemon.mjs --status
node ./scripts/mcp_pool_daemon.mjs --stop
```
