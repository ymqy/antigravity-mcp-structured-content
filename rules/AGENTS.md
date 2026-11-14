# MCP StructuredContent 补全规则

- 调用受显式适配规则覆盖的 MCP 工具（例如 `cua-driver` 的 `browser_*`、`get_session`、`list_sessions`）时，请始终直接调用原 MCP 服务（如 `ServerName: "cua-driver"`），不要直接调用 `antigravity-mcp-structured-content_bridge`。
- 命中显式适配器注册表的工具调用会由 `PreToolUse` Hook 自动路由经内部桥接工具 `antigravity-mcp-structured-content_bridge:get_structured_result` 执行，并将原文本内容连同 `[structuredContent] {...}` JSON 一并写入本次工具返回值。
- 若返回结果前带有系统提示 `A pre-tool hook changed the arguments of this tool call before it ran`，属插件正常桥接行为；返回的文本内容与 `[structuredContent]` 即为真实执行结果，无需重复调用原工具。
