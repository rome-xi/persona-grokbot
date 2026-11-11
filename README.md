# Persona 插件：Grok Bot

把 Grok Bot 的对话放进 Persona 的 Agents 页：看对话、发消息。回复经 Grok Bot 的实时流推到 App，不用 Open Lark 每分钟轮询。
Persona 助手也能读这些对话、替你回复（`grok` 命令，每次发送先在手机上确认）。
需要 hub 支持 `agent_sources` 扩展点（nwverse/persona#1400）；给助手用的部分需要 `assistant` 扩展点的命令网关（#1468、#1317）。

## 能做 / 不能做

| 能做 | 不能做（Grok Bot 协议没有） |
| --- | --- |
| Agents 页按 Grok Bot 分组列出每个 Bot 和它的会话 | 逐字流式：一条回复写到哪推到哪，按段整体刷新 |
| 最活跃的几个会话（默认 6 个）实时监听，回复几乎立即出现 | 新开会话 |
| 发文字消息（同一条重试会被 Grok Bot 去重） | 发图片、文件 |
| 未读数（一条回复算一条）、工具步骤折叠显示 | 撤回消息、搜索、停止运行、审批工具 |
| 助手读对话、替你回复（发送先在手机上确认） | 助手在 hub 以外的电脑上跑时用不了（见下） |

## 安装

1. hub 机器上要有 Node.js 22.13+（找不到时设 `PERSONA_NODE=<node 路径>`）。
2. `personad plugin install dir:<本目录>`，或在 hub 管理界面 › 插件里装。
3. App › 设置 › 插件 › Grok Bot，填「Grok Bot 登录凭据」（access token）。登录过期时这里会显示「登录过期了」，重新填一次。
4. hub 机器连不上 `api2.cursor.sh` 时，在插件设置里填「HTTP 代理」（如 `http://127.0.0.1:8080`）。插件拿到的是 hub 给的干净环境，不读 `HTTPS_PROXY`。
5. 和 Open Lark 里的 Grok Bot 同时开着会在 Agents 页出现两份，关掉其中一个。

## 让 Persona 助手读和回复

Persona 助手自带的 `agents_list` / `agent_read` / `agent_send` 只管电脑上的 Claude Code / Codex，看不到 Agents 页里插件接进来的个人 Agent。所以插件给助手加了 `grok-bot` 技能和 `grok` 命令：

```sh
grok GET /sessions                                              # 会话列表
grok GET '/sessions/grokbot:<bot>/<session>/messages?limit=20'  # 最近的消息
grok POST /sessions/grokbot:<bot>/<session>/messages '{"clientId":"UUID","text":"…"}'  # 发消息，先在手机上确认
```

- 走的是 hub 自己的个人 Agent 接口（`/api/v1/agents`，和 App 的 Agents 页同一份数据），用插件的 hub 令牌（权限 `agents.read`、`agents.control`）。
- 令牌由助手所在电脑的 Persona 节点放在命令网关的本机代理里，助手的进程拿不到；读直接放行，发消息逐条在手机上确认，标为已读直接放行，其他一律拒绝（`assistant/gate.json`）。
- hub 只接受从它本机来的插件令牌，所以助手要和 hub 跑在同一台电脑上。地址默认用 hub 的本机地址（`http://127.0.0.1:18660`），可在设置里改端口，但仅接受本机回环地址。

## 风险

- 用的是 Grok Bot 桌面客户端的非公开协议（经 [grok-bot-sdk](https://github.com/RongleCat/grok-bot-sdk)），客户端改版可能失效；请求头声明为官方 Mac 客户端 0.78.1。
- access token 只存在 hub 的加密密钥里，插件不写日志、不外发；只访问 `api2.cursor.sh`。

## 开发

```sh
npm test                 # 单元测试（假的 Grok Bot 客户端）
# 端到端：在 persona 仓库的 server/ 里，把 test/e2e/grokbot_e2e_test.go 拷到 internal/hub/ 后
GROKBOT_PLUGIN_DIR=<本目录> GROKBOT_FAKE=<本目录>/test/fake-grok.mjs go test ./internal/hub -run TestGrokbotE2E -v
```

`vendor/grok-bot-sdk` 是 RongleCat/grok-bot-sdk 0.78.1（MIT）原样拷贝。

### 助手发送限制

每个逻辑消息生成一次 clientId（UUID），重试复用同一 ID 和正文；响应不确定时先回读，不自动换 ID 重发。只收内联 JSON（clientId、text 两字段），总长不超过 1800 字节，不收美元符号、@文件或额外 curl 参数。长内容分成分别确认的短消息。这些限制避免当前 Persona 命令网关对截断文件及含美元符号正文的绑定缺口。

`grok` 客户端只列出和操作 grokbot 来源。hub 授予的 agents.read/control 是粗粒度权限，并非按来源隔离的 token；脚本的来源检查不应被当作 hub 的安全边界。
