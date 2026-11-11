---
name: grok-bot
description: 用户的 Grok Bot（App「Agents」页 Grok Bot 分组里的 Bot，比如 X、个人PR、问题）：列会话和未读、读对话、替用户回复或补充上下文（每次发送先在用户手机上确认）。用户提到 Grok Bot、某个 Bot 的对话，或者要回复、催、补充某个 Bot 时用。命令是 grok。这些会话不在 agents_list / agent_read / agent_send 里，那几个工具只管电脑上的 Claude Code / Codex。
---

# Grok Bot（grok）

`grok` 经 Persona hub 的个人 Agent 接口读写 Grok Bot 的对话，和 App 的 Agents 页是同一份数据。凭据在 hub 上，命令拿不到也不需要。
找不到 `grok`，或者退出码 3：Grok Bot 插件没开、没登录，或者 hub 没给它凭据。告诉用户去 App 的 设置 › 插件 › Grok Bot 看一下，不要自己绕过去（不要直接 curl hub）。

## 命令

| 命令 | 做什么 |
| --- | --- |
| `grok GET /sessions` | Grok Bot 会话：`id`、`title`（Bot 名）、`provider`（Grok Bot 的是 `grok_bot`）、`unreadCount`、`canSend` |
| `grok GET '/sessions/<id>/messages?limit=20'` | 最新的一页消息，旧的在前；`hasMore` 为真时，用 `&cursor=<nextCursor>` 取更早的 |
| `grok POST /sessions/<id>/messages '{"clientId":"UUID","text":"…"}'` | 发一条消息。用户先在手机上确认，拒绝了会返回 403 |
| `grok POST /sessions/<id>/read` | 标为已读 |

- `<id>` 原样照抄 `GET /sessions` 给的 `id`，比如 `grokbot:bf7a7102-bcef-4cbf-9c2c-17a82e422490/`，冒号和斜杠都保留，命令自己会编码。
  这个 id 以 `/` 结尾，所以后面接 `/messages` 时会出现两个斜杠：`grok GET '/sessions/grokbot:bf7a7102-bcef-4cbf-9c2c-17a82e422490//messages?limit=20'`。不要自己改成 `%2F`。
- 读消息的输出比较长，用 jq 取正文：
  `grok GET '/sessions/<id>/messages?limit=20' | jq -r '.messages[] | "\(.role): " + ([.blocks[]? | select(.type=="text") | .text] | join(" "))'`
- 按名字找会话：`grok GET /sessions | jq -r '.sessions[] | select(.provider=="grok_bot") | "\(.id)\t\(.title)\t未读 \(.unreadCount)"'`

## 回复时

1. 先读最近十几条消息，弄清楚 Bot 在问什么、在等什么。
2. 只发用户要你发的内容。用户说「回一下」「补充一下」时，你可以自己写正文，但要按用户给的方向写；方向不清楚就先问。
3. Grok Bot 跑在第三方服务上。除非用户明确要求，正文里不写公司名、内部项目、同事姓名、家庭成员、住址、设备与网络、账号、密钥这类信息，需要时用泛称代替。
4. 执行发送命令时手机上会弹确认卡。用户点允许之后才会真正发出。回复用户时说清楚发给了哪个 Bot、发了什么。
5. `canSend` 为 false 的会话发不了，直接告诉用户。不支持发图片、文件、撤回和新开会话。

## 发送约束与重试

- 每个逻辑消息先单独执行一次 `uuidgen`，把输出的 UUID 原样写进发送命令的 `clientId`。不要写 `$(uuidgen)` 或任何 `$` 变量：网关看到 `$` 就无法把确认卡上的正文和实际发出的正文对上。响应丢失时先读会话核对；只有需要重试时，复用同一个 UUID 和完全相同的正文，不生成新 ID 自动重发。
- 发送只支持内联 JSON，且仅有 `clientId`、`text` 两个字段。不支持 @文件、额外 curl 参数或其他来源的 Agent。
- 每条 JSON 不超过 1800 字节；长内容拆成多个短消息，每条分别确认。正文不能含美元符号，用“美元”代替。限制用于避开当前 Persona 网关对长文件/美元符号的正文绑定缺口，不得绕过。

## 常见报错

| 现象 | 原因和处理 |
| --- | --- |
| 退出码 3 | 插件没开、没登录，或者 hub 没给凭据。请用户到 App 的 设置 › 插件 › Grok Bot 查看 |
| 退出码 2，`grok:` 开头的提示 | 命令被本地校验拒绝，请求没有发出。按提示改：id 照抄、JSON 只留 clientId 和 text、去掉美元符号、拆短 |
| 退出码 22，输出里有 403 | 用户在手机上拒绝了，或者确认已经过期（10 分钟）。不要换个写法重发，先问用户 |
| 409 `cannot send now` | 这个会话现在发不了（`canSend` 为 false），告诉用户 |
| 502 / 超时 | 不确定是否已发出：先读会话最近几条核对，确实没发出再用同一个 clientId 和正文重试 |
