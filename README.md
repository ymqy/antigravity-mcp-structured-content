# antigravity-mcp-structured-content

> 原生 Antigravity（`agy`）零依赖插件：按**显式适配器注册表**无损保留并注入 MCP 工具的 `structuredContent` 字段与原生内联截图，无需改动 `~/.gemini/config/mcp_config.json` 直连官方 MCP 服务配置。

## 根因定位

1. **Antigravity 客户端侧（SEP-1865 双路分离设计）**：
   `language_server` 内部采用 SEP-1865（MCP Apps）规范——`the model sees content; the app sees the full result`。`mcpcore.parseCallToolResult` 仅提取 `content[]` 中的文本与媒体（如 `type: "image"`）写入模型上下文，过滤 `structuredContent`；同时 `PostToolUse` 契约对 `call_mcp_tool` 不支持覆写返回值。
2. **部分 MCP 服务端侧（关键数据仅存于 `structuredContent` + 连接态强绑定）**：
   以 `cua-driver 0.49.x`（macOS 60 个工具 / Linux 64 个工具）为例：
   - **关键字段缺失**：`clipboard_read`（剪贴板正文 `text`/`types`）、`clipboard_write`（`types`/`written_type`）、`get_config`（全量驱动配置）、`get_agent_cursor_state`（光标坐标/开关/动画）、`get_window_state(tree_format="elements")`（结构化 `elements[]`）、`browser_*`（`prepared_pid`/`tab_id`/`refs`/`dialog_id`）、`get_session`/`list_sessions`、`verify_state`（逐项断言 `predicates[]`）、`launch_app`/`list_apps`、`start_session`/`end_session` 等均将核心结构化数据仅放在 `structuredContent` 中；
   - **连接级状态强绑定**：`cua-driver` 的显式命名会话（跨连接报错 `session_unavailable`）、隐式会话、光标状态、窗口截图参照系（`get_window_state` → `zoom` / 像素 `click`）及 `since="latest"` 增量基线均严格绑定在单条 MCP 连接（transport）上，**绝不能拆成两条连接混跑**。

## 核心架构与工程特性

- **统一持久单连接模式（`"interceptTools": "*"`）与按需工具白名单模式并存**：
  - **有状态服务（如 `cua-driver`）**：使用 `"interceptTools": "*"` 将全部调用统一路由至同一条持久 `stdio` / `Streamable HTTP` 连接，彻底消除双连接导致的命名/隐式会话隔离、截图坐标系失效与快照基线丢失，自动兼容 macOS（60 工具）、Linux（64 工具）及后续新增工具；
  - **无状态服务**：仍可配置 `"interceptTools": ["tool_a", "tool_b"]` 仅拦截指定工具，其余工具在 `PreToolUse` 约 2 ms 原样直通。
- **无损智能去重（`dedupeTextInContent`）**：
  - 自动检测并剔除 `structuredContent` 中已在 `content[].text` 原文出现的长文本或多行字段（例如 `get_window_state` 的 `tree_markdown`、`run_steps` 的 `observation.state.tree_markdown`、重复的 `summary`/`hint`），避免 UI 树 Token 翻倍，同时 100% 保留 `snapshot_id`、`elements[]`、`capture_id`、`truncated`、`refs` 等非冗余结构化字段；
  - 当 `structuredContent` 仅包含与 `content[].text` 完全一致的单字段文本（如 `page` 的 `text`）时自动静默省略，不注入多余噪音。
- **原生内联大图与 UTF-8 流式帧解析（`O(N)`）**：
  - 全链路采用基于 `Buffer` 分块队列的 `JsonLineReader`（`O(N)` 单次拼接），彻底消除 5 MB+ Retina PNG Base64 截图在管道分片下的 `O(N^2)` 内存拷贝与跨分片多字节 UTF-8 截断乱码；`get_desktop_state`、`get_window_state`、`zoom` 等内联图片由 Antigravity 原生提取渲染。
- **随宿主生命周期常驻保活（Lease 租约机制）+ 动态长超时**：
  - `bridge_mcp.mjs` 与后台连接池 `mcp_pool_daemon.mjs` 建立零 CPU 开销的 Unix Socket 租约连接：只要 Antigravity 仍在运行，即使对话停顿数小时也不会断连丢会话；当退出 Antigravity 或停用插件导致桥接进程关闭时，守护进程在宽限期（默认 30 秒）后自动优雅关闭全部上游 MCP 进程并回收 `isolated_new` 浏览器；
  - 默认单次工具调用超时提升至 **10 分钟**（支持 `arguments.timeout_ms` 动态顺延与环境变量覆盖），满足长耗时 `run_script`、`run_steps`、`verify_state` 执行需求。

## 安装方式

### 方式一：全局安装（推荐，对本机所有项目生效）

直接克隆到全局插件目录 `~/.gemini/config/plugins/`，Antigravity 客户端会自动发现并启用：

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/ymqy/antigravity-mcp-structured-content.git \
  ~/.gemini/config/plugins/antigravity-mcp-structured-content
```

如果希望将源码放在开发目录，使用软链接挂载即可：

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
├── plugin.json                 # 插件清单元数据
├── mcp_config.json             # 内置 bridge MCP 服务（antigravity-mcp-structured-content_bridge）
├── hooks.json                  # PreToolUse 匹配 call_mcp_tool
├── adapters/
│   └── registry.json           # 显式适配器注册表（支持 "*" 全量单连接或工具数组）
├── rules/
│   └── AGENTS.md               # 告知模型信任插件桥接返回的 [structuredContent] 结果
├── scripts/
│   ├── run_hook.sh             # POSIX fail-open Hook 入口（兼容 Dock/GUI 启动 PATH）
│   ├── run_bridge_mcp.sh       # POSIX bridge MCP 启动入口
│   ├── bridge_mcp.mjs          # stdio MCP 桥接服务（暴露 get_structured_result 并维持保活租约）
│   ├── hook_handler.mjs        # PreToolUse 路由改写核心逻辑
│   ├── mcp_pool_daemon.mjs     # 持久单连接池守护进程（stdio / Streamable HTTP + 智能去重）
│   ├── daemon_client.mjs       # Unix Socket IPC 客户端与 Lease 租约管理
│   ├── registry_config.mjs     # 注册表合并加载与 structuredContent 无损去重压缩
│   └── json_line_reader.mjs    # O(N) 流式 Buffer JSON 行帧读取器（大图与多字节 UTF-8 安全）
├── tests/
│   └── run_tests.mjs           # 自动化单元与端到端集成测试套件
└── assets/
    └── logo.svg
```

## 自定义扩展与运维命令

- **用户自定义覆盖**：可在 `~/.gemini/config/mcp_structured_content.json` 按相同 `{"servers": {...}}` 格式覆写或扩展其他 MCP 服务（支持 `"interceptTools": "*"`、`"interceptTools": [...]`、`"excludeTools": [...]`、`"dedupeTextInContent": true`、`"omitStructuredFields": [...]`、`"callTimeoutMs": 600000`），无需改动插件仓库。
- **环境变量调优**：
  - `AGY_MCP_SC_DISABLE=1`：临时停用插件拦截；
  - `AGY_MCP_SC_CALL_TIMEOUT_MS`：默认单次调用超时毫秒数（默认 `600000`，即 10 分钟）；
  - `AGY_MCP_SC_LEASE_GRACE_MS`：桥接进程退出后的连接池优雅回收宽限毫秒数（默认 `30000`）；
  - `AGY_MCP_SC_IDLE_TIMEOUT_MS`：无租约模式下的兜底闲置超时毫秒数（默认 `43200000`，即 12 小时）。
- **查看/重启连接池守护进程与运行测试**：

```bash
node ./scripts/mcp_pool_daemon.mjs --status
node ./scripts/mcp_pool_daemon.mjs --stop
node ./tests/run_tests.mjs
```
