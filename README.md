# Persona 插件：Grok Bot

把 Grok Bot 的对话放进 Persona 的 Agents 页：看对话、发消息。回复经 Grok Bot 的实时流推到 App，不用 Open Lark 每分钟轮询。
需要 hub 支持 `agent_sources` 扩展点（nwverse/persona#1400）。

## 能做 / 不能做

| 能做 | 不能做（Grok Bot 协议没有） |
| --- | --- |
| Agents 页按 Grok Bot 分组列出每个 Bot 和它的会话 | 逐字流式：一条回复写到哪推到哪，按段整体刷新 |
| 最活跃的几个会话（默认 6 个）实时监听，回复几乎立即出现 | 新开会话 |
| 发文字消息（同一条重试会被 Grok Bot 去重） | 发图片、文件 |
| 未读数（一条回复算一条）、工具步骤折叠显示 | 撤回消息、搜索、停止运行、审批工具 |

## 安装

1. hub 机器上要有 Node.js 22.13+（找不到时设 `PERSONA_NODE=<node 路径>`）。
2. `personad plugin install dir:<本目录>`，或在 hub 管理界面 › 插件里装。
3. App › 设置 › 插件 › Grok Bot，填「Grok Bot 登录凭据」（access token）。登录过期时这里会显示「登录过期了」，重新填一次。
4. hub 机器连不上 `api2.cursor.sh` 时，在插件设置里填「HTTP 代理」（如 `http://127.0.0.1:8080`）。插件拿到的是 hub 给的干净环境，不读 `HTTPS_PROXY`。
5. 和 Open Lark 里的 Grok Bot 同时开着会在 Agents 页出现两份，关掉其中一个。

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
