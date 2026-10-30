# 17 · DSH 接入：升级、模型路由与 ACP 验证

> 记录 2026-10-30 在 139 上把 DeepSeek Harness 从 0.1.0 升到 0.2.1-rc.5、
> 把模型路由切到本机 sub2api、并验证 ACP 会话可用的过程与结论。

## 1. 为什么要升级

青梅要把 DSH 当"内嵌大脑"，而它必须能作为 ACP agent 被拉起。
旧环境是 `0.1.0-rc.8`，只有 `headless` / `web` 两个 profile：

- `headless` 是一次性的：`dsh --profile headless "任务"` → 打印答案 → 退出，没有会话与流式；
- `acp` profile 依赖 `@deepseek-ai/dsh-acp-app`，而该包**最低版本是 0.1.6-alpha.1**，
  装不进 0.1.0。

## 2. 升级过程

| 步骤 | 结果 |
| --- | --- |
| 新版本 | `0.2.1-rc.5`，独立前缀 `/opt/dsh`（不与系统 node 混装） |
| 命令入口 | `/usr/local/bin/dsh`：包装脚本，固定用 `/opt/node24/bin/node` 启动 |
| 旧安装清理 | `/opt/dsh8`、`/usr/lib/node_modules/@deepseek-ai/dsh`、`/opt/node24/lib/node_modules/@deepseek-ai/dsh` 全部删除 |
| profile 重建 | `acp` / `web` / `headless` 全部在 0.2.1-rc.5 重建，无兼容警告 |
| 备份 | `~/dsh-profile-backup-20261030`（旧 profile 与 settings） |

坑一：机器上曾并存三份 DSH（系统 npm 前缀、/opt/dsh8、/opt/node24），`dsh` 命令解析到哪份取决于 PATH。
坑二：`dsh` 的 shebang 是 `/usr/bin/env node`，会拿到系统 Node 20；必须用包装脚本固定 Node 24。

## 3. 模型路由：指向 sub2api

DSH 的 LLM 适配器 `@deepseek-ai/dsh-llm-pi-ai` 支持手工声明网关路由：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      qingmei-sub2api:
        displayName: Sub2API (DeepSeek)
        apiKeyEnv: QM_DSH_API_KEY      # 按请求解析，密钥不进配置
        api: openai-completions
        baseURL: http://127.0.0.1:8081/v1
        models:
          - id: deepseek-v4-flash
            contextWindow: 131072
            maxTokens: 8192
```

默认模型写在 `~/.dsh/settings.yaml`：

```yaml
agent-default-model:
  provider: qingmei-sub2api
  model: deepseek-v4-flash
```

坑三：`settings.yaml` 只在启动时导入一次，随后被改名为 `settings.yaml.imported` 并进入存储。
**改完必须再启动一次才生效**，第一次运行用的仍是旧值。

验证：

```bash
QM_DSH_API_KEY=sk-... dsh --profile headless "用一句话介绍你自己"
# → 我是 DeepSeek Harness 中的 AI 编程智能体……
```

## 4. ACP 验证

`scripts/spike-acp.mjs` 用 stdio JSON-RPC 跑完整一轮：

```text
initialize → session/new(cwd) → session/prompt → session/update(agent_message_chunk) → session/close
```

实测返回：

```json
{"protocolVersion":1,
 "agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
 "agentCapabilities":{"mcpCapabilities":{"http":true},
                      "sessionCapabilities":{"close":{},"list":{},"resume":{}}}}
```

结论：青梅可以拉起 DSH、建会话、流式取回复、恢复会话，并通过 MCP over HTTP 回连自己的工具。

## 5. 对架构的确认

- 对话车道换到 DSH 之后，`provider-llm-openai` 只保留给**后台认知**（记忆抽取、分类、摘要），
  不再直接回用户。
- DSH 的 persona 默认是"编程智能体"，要变成"青梅"，需要在 `acp-app` 的 patch 层换人格，
  这属于人格层，随 ACP client 一起做。
- ACP 的 `session/request_permission` 将接到青梅的 `permission` 服务（手机确认）。

**已落地（同日）**：`@qingmei/provider-dsh-acp` 实现 `HarnessService`，`qm-agent` 优先走 harness、
失败才回落 llm。部署后实测回复由 DSH 产生（会列出它自己的工具与工作区策略）。

由此暴露的产品问题：DSH 会把内部工具清单与工作区路径说给用户听。正式版需要在人格层
和输出层做"内部信息不出圈"，这属于 A 类（硬边界）而不是提示词问题。

## 6. 复现清单

```bash
# 1. 确认版本
dsh --version            # 0.2.1-rc.5

# 2. 确认 profile
ls ~/.dsh/profiles       # acp headless node_modules web

# 3. 确认握手
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | dsh --profile acp | head -1

# 4. 跑一轮真实会话
QM_DSH_API_KEY=sk-... node scripts/spike-acp.mjs
```

## 7. 人格白名单（最终形态）

`acp` profile 的 `system-prompt.personaPrefix` 收敛为一句可执行的能力声明：

```yaml
- id: system-prompt
  config:
    personaPrefix: '你叫青梅，是用户的个人助理。用中文简短回答，不寒暄。你只有四项能力：记忆（查/记）、联网检索、日程与提醒、任务清单。你没有文件和命令权限，不能读写文件、执行命令或运行脚本；被问到能力时只按这四项回答，不要声称其他能力。不要提内部工具名、文件路径、运行环境或权限策略。'
```

配套关闭 `tool-bash` / `tool-pwsh` / `tool-jobs` / `tool-fs` / `tool-fs-search` /
`tool-subagent*` / `tool-workflow`（`dump-config` 里 13 行 `disabled: true`）。

实测「你有哪些能力？能读写文件或执行命令吗？」→ 只列四项，并明确回答
「我不能读写文件、执行命令或运行脚本」。之前那种"能读写文件、执行命令"的谎报消失。

注意：人格只约束**表述**；真正的边界仍是工具没挂载 + `qm-agent` 的 `sanitizeReply`
（过滤 `mcp__`、绝对路径、`workspace-write`、反引号工具名）。
