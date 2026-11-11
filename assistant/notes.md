## Grok Bot

App「Agents」页里 Grok Bot 分组的会话（X、个人PR、问题…）是 Grok Bot 插件接进来的个人 Agent，不在 `agents_list` / `agent_read` / `agent_send` 里，那几个工具只管电脑上的 Claude Code / Codex。
用户要看、回复或者补充 Grok Bot 的对话时，用 grok-bot 技能的 `grok` 命令。读消息直接执行，发消息每次都要用户先在手机上确认。
发送格式：`grok POST /sessions/<id>/messages '{"clientId":"<UUID>","text":"…"}'`。UUID 先单独执行 `uuidgen` 生成，再把结果原样写进命令，不要用 `$(…)` 或变量；重试时复用同一个 UUID 和正文。单条 JSON 不超过 1800 字节，正文里不要出现美元符号。
收件箱里来源是 Grok Bot 的条目是 Bot 的新回复，上下文最后一行写着会话 id（`grokbot:<bot>/<session>`）：要读更多或替用户回复时就用这个 id 调 `grok`；在收件箱条目上点「发送」的回复由 Persona 直接发到这个会话，不用再走 `grok`。
