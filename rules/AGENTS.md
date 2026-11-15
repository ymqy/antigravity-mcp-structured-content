# MCP StructuredContent 补全规则

- 调用受显式适配规则覆盖的 MCP 服务（如 `cua-driver` 全量工具）时，请始终直接调用原 MCP 服务（如 `ServerName: "cua-driver"`），不要直接调用 `antigravity-mcp-structured-content_bridge`。
- 命中显式适配器注册表的工具调用会由 `PreToolUse` Hook 自动路由至统一持久单连接桥接工具 `antigravity-mcp-structured-content_bridge:get_structured_result` 执行，确保命名/隐式会话、窗口截图参照系、快照 Token 与浏览器上下文处于同一连接，并将原生内容（含内联截图）连同去重后的 `[structuredContent] {...}` 一并返回。
- 若返回结果前带有系统提示 `A pre-tool hook changed the arguments of this tool call before it ran`，属插件正常桥接行为；返回的文本、媒体与 `[structuredContent]` 即为真实执行结果，无需重复调用原工具。
