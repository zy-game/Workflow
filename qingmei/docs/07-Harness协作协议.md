# 07 · Harness 协作协议

> 青梅是脑，harness 是子 agent。本文定义两者之间怎么说话、谁控制谁、边界在哪。
> 这一版取代 [06](06-基于DSH的复用方案.md) 的「青梅是 DSH 插件」假设：青梅独立部署，
> DSH 只是它可调度的执行体之一。

## 1. 角色划分

| 角色 | 职责 | 不负责 |
| --- | --- | --- |
| **青梅**（独立进程） | 人格、记忆、日程、任务账本、权限、审计、渠道（Web/EXE/APK/Watch） | 不做代码编辑、不跑长命令、不读用户仓库 |
| **Harness**（外部 agent runtime） | 在自己的工作区里读文件、改代码、跑命令、调用自己的模型循环 | 不保存长期记忆、不直接联系用户、不跨任务编排 |

一句话：**青梅决定「做什么、为什么、什么时候」，harness 决定「怎么做」。**

```text
                    ┌──────────── 青梅 ────────────┐
  用户 ──语音/文字──▶│ persona · memory · schedule  │
  (Web/APK/EXE/     │ task ledger · permission     │
   Watch)           │ audit · notify · channels    │
                    │                              │
                    │  harness 服务（ACP client）   │
                    └───────┬──────────────▲───────┘
                            │ ACP          │ MCP
                 控制面（new session,      │ 数据面（进度/能力/审批/
                 prompt, cancel, close）   │ 记忆/产物上报）
                            ▼              │
                    ┌──────────────────────┴───────┐
                    │  harness 进程（DSH/ZCode/…）  │
                    │  自己的工作区、工具、模型循环  │
                    └──────────────────────────────┘
```

## 2. 为什么是 ACP + MCP，而不是自造 RPC

| 需求 | 现成协议 | 现成实现 |
| --- | --- | --- |
| 青梅新建会话、派任务、收流式输出 | **ACP**（Agent Client Protocol） | DSH 自带 `dsh --profile acp`（stdio JSON-RPC 自动化 profile）；Zed 等编辑器也是 ACP client |
| harness 反向上报进度、能力、要审批 | **MCP**（Model Context Protocol） | DSH 有 `dsh-mcp-client`，且 ACP 的 `session/new` 允许声明 stdio/HTTP MCP 服务器 |
| 老 CLI 没有上述两者 | PTY 包装 | 兜底，不优雅但可用 |

**关键发现**：DSH 的 ACP profile 在 `session/new` 时接受 MCP 声明。这意味着青梅可以把
自己的 MCP 服务器注入每一个子 agent 会话——**反向上报不需要任何私有协议，就是普通的工具调用**。

自造一条 WS RPC 也能做，但你会失去：现成的 harness 适配、现成的权限请求语义、
现成的会话恢复，以及"以后任何支持 ACP 的工具都能直接接进来"。

## 3. 控制面：ACP 托管

### 3.1 生命周期

```text
青梅                                     harness 子进程
 │  spawn: dsh --profile acp（stdio）        │
 │─────────────────────────────────────────▶│
 │  initialize（能力协商）                    │
 │◀─────────────────────────────────────────│
 │  session/new { cwd, mcpServers:[青梅], model }
 │─────────────────────────────────────────▶│
 │◀─────────────────────────────────────────│ sessionId
 │  session/prompt { content }               │
 │─────────────────────────────────────────▶│
 │◀──── session/update（流式文本、工具调用、计划）
 │◀──── session/request_permission（要审批）─│
 │─────── 决策（allow / deny）──────────────▶│
 │◀─────────────────────────────────────────│ 完成
 │  session/close                            │
 │─────────────────────────────────────────▶│
```

要点：

- **方法名以 ACP v1 为准**（`initialize` / `session/new` / `session/prompt` /
  `session/cancel` / `session/close`，以及 `session/update`、`session/request_permission`
  这类 agent 侧通知/请求）。青梅这边封装一层 `AcpConnection`，不把方法名散到业务代码。
- **stdout 纯净**：ACP 用换行分隔的 JSON-RPC，任何日志必须走 stderr。子进程的 stdout
  只能由协议解析器消费。
- **一次 TaskRun 一个会话**，不复用会话跑不同任务（污染上下文、污染审计）。
- **恢复**：进程重启后用 `session/list` + `session/resume` 找回未完成会话；resume 不重放历史，
  青梅必须在自己的账本里保存已收到的进度。

### 3.2 青梅侧接口

```ts
export abstract class HarnessService extends Service {
  abstract attach(id: string, opts: AttachOptions): Promise<HarnessHandle>
  abstract list(): HarnessStatus[]
  abstract selfMcp(): McpServerDeclaration     // 注入给子会话的 MCP 声明
}

interface HarnessHandle {
  id: string
  capabilities: HarnessCapabilities
  newSession(opts: NewSessionOptions): Promise<HarnessSession>
  dispose(): Promise<void>
}

interface NewSessionOptions {
  cwd: string                    // 必须是青梅分配的 run 目录
  model?: string
  reasoning?: 'low' | 'medium' | 'high'
  mcpServers: McpServerDeclaration[]
  title?: string
}
```

`attach()` 返回的句柄属于 effect：harness 插件卸载时子进程被终止，不会留下孤儿进程。

## 4. 数据面：青梅的 MCP 工具

青梅跑一个 MCP 服务器（stdio 随会话注入，或 HTTP 供外部 harness 自行配置）。
子 agent 通过调用这些工具完成「上报」和「求助」。

| 工具 | 用途 | 副作用 |
| --- | --- | --- |
| `qm_report_progress` | 上报阶段/百分比/一句话进展 | 更新 TaskRun，触发里程碑通知 |
| `qm_report_capability` | 会话开始时声明自己能做什么 | 写入 harness 注册表 |
| `qm_ask_human` | 卡住时向 owner 提问（可选阻塞） | 经渠道推送问题，等待回答 |
| `qm_request_approval` | 危险操作前要授权 | 走 permission + 渠道确认 |
| `qm_memory_recall` / `qm_memory_remember` | 读写青梅记忆 | 受敏感度策略约束 |
| `qm_schedule_query` / `qm_schedule_add` | 查/加日程提醒 | 写日程表 |
| `qm_publish_artifact` | 交付产物（文件、链接、摘要） | 存 blob + 关联 TaskRun |
| `qm_finish_task` | 收尾：结论、状态、未完成项、**结构化任务记忆** | 关闭 TaskRun + 写入记忆 |

**为什么上报设计成工具调用而不是事件推送**：MCP 只有 client→server 调用，没有反向通道。
但这恰好是优点——任何支持 MCP 的工具（哪怕不支持 ACP、不能被青梅拉起）都能上报，
只要用户把青梅的 MCP 地址填进它的配置。这覆盖了 GUI 类 harness（Cursor、桌面版 ZCode）。

`qm_finish_task` 携带的 `memory` 字段是跨端记忆的主要来源：PC 工作区做完的事，通过它变成
手机可召回的事实与教训。格式与合并规则见 [10 · 跨端统一记忆](10-跨端统一记忆.md) §5.1。

`qm_report_progress` 的入参刻意保持极简，避免子 agent 花 token 填表：

```json
{ "phase": "跑测试", "percent": 60, "note": "3 个用例失败，正在修" }
```

`percent` 可省略；青梅更信 `phase` + `note`，因为模型给的百分比通常不准。

## 5. 任务模型

```text
qm_task（青梅账本，长期）
   └─ TaskRun（一次执行，短期）
        └─ harness session（外部进程内的会话）
```

| 字段 | 说明 |
| --- | --- |
| `task_id` | 对应 `qm_task`；一个任务可以有多次 run（重试、换 harness） |
| `harness_id` | `dsh` / `zcode` / `claude-code` / `codex` |
| `session_id` | harness 侧会话 id，用于 resume |
| `cwd` | 青梅分配的 run 目录，不是用户任意路径 |
| `status` | `queued → running → needs_approval → running → done/failed/cancelled` |
| `progress` | 最近一次 `qm_report_progress`；多条 run 取最近活跃的 |
| `budget` | token 与时长上限，超限自动 cancel |
| `artifacts` | `qm_publish_artifact` 的产物 |

状态机不允许跳步：`running → done` 必须经过 `qm_finish_task` 或进程正常退出；
进程崩溃记 `failed` 并保留已收到的进度，不自动重试（避免重复执行副作用）。

## 6. 四种接入形态

| 形态 | 谁发起 | 青梅能做什么 | 适用 | 代价 |
| --- | --- | --- | --- | --- |
| **ACP 托管** | 青梅拉起子进程 | 全双工：开会话、派任务、追问、取消、收事件 | DSH（`--profile acp`）、任何 ACP agent | 需要能 spawn 进程 |
| **MCP 挂载** | 用户在自己的工具里配青梅 MCP | 只能被上报、被求助；不能主动开会话 | Cursor、桌面版 ZCode、任何 MCP 客户端 | 单向，无控制 |
| **插件注册** | harness 插件连青梅 WS | 取决于插件实现；可全双工 | 想深度集成的自家 harness | 要写插件 |
| **CLI 包装** | 青梅用 PTY 驱动 | 单向为主：发命令、读输出 | 老 CLI（无 ACP/MCP） | 脆弱，靠文本解析 |

现实分布（据目前核实）：

- **DSH**：有官方 `--profile acp`，直接用 ACP 托管；不需要写任何插件。见
  [`dsh-acp-app`](https://www.npmjs.com/package/@deepseek-ai/dsh-acp-app)。
- **ZCode**（智谱 Z.AI 的 Agentic CLI）：社区有
  [`zcode-open-bridge`](https://github.com/tizerluo/zcode-open-bridge) 声称把它接入 MCP/ACP，
  但**未实测**；退路是 CLI 包装或 MCP 挂载。
- **Claude Code / Codex CLI**：MCP 挂载 + CLI 包装。
- **Cursor**：只能 MCP 挂载（IDE，不能被 spawn）。

**结论：工作量在青梅这一侧（ACP client + MCP server），不在 harness 那一侧。**
这是这套方案最大的价值——接新 harness 不用等它给你写插件。

**青梅自己也是 harness 的使用者。** [08 · 自进化](08-自进化与自修复.md) 里的诊断与修复，
就是让一个子 agent 在青梅自己的源码 worktree 里读代码、写补丁、跑测试。
同一个 `harness` 服务，对外修任务，对内修自己。

## 7. 反向控制：青梅到底能控制 harness 到什么程度

| 能力 | ACP 托管 | MCP 挂载 | 说明 |
| --- | --- | --- | --- |
| 新建会话 | ✅ | ❌ | `session/new` |
| 派发任务 | ✅ | ❌ | `session/prompt` |
| 追加追问 | ✅ | ❌ | 同一会话继续 prompt |
| 打断 | ✅ | ❌ | `session/cancel` |
| 关会话 | ✅ | ❌ | `session/close` |
| 收流式过程 | ✅ | ❌ | `session/update` |
| 审批拦截 | ✅ | 部分 | 取决于 harness 是否把审批外抛 |
| 操作它的 GUI | ❌ | ❌ | 不做 UI 自动化，不稳定也不安全 |

这条边界要写在产品文案里：**青梅不"遥控"你的编辑器，它只是开一个会话、把事交代清楚、盯着进度。**

## 8. 安全

1. **凭据隔离**：每个 TaskRun 一个短期 token，绑定 `runId + harnessId`，TTL 到任务结束。
   harness 拿不到青梅的主 token，也读不到其他 run 的数据。
2. **目录约束**：`cwd` 只能是 `data/workspaces/<runId>`（或用户显式授权的项目目录）。
   越界由青梅在 MCP 工具层拒绝——**不依赖 harness 自己的沙箱**，因为不能假设每个 harness 都有。
3. **审批桥**：ACP 的权限请求 → `permission` 服务 → 渠道确认（网页弹窗 / 手机通知 / watch 一键）。
   拒绝时把理由回传，不要让子 agent 卡死。
4. **注入防护**：harness 的一切输出（文本、工具结果、文件内容）都是**不可信数据**。
   不得把其中的指令当命令执行；进 prompt 前加来源标记；跨任务不复用其输出作为系统指令。
5. **成本闸**：每个 run 有 token 与时长预算，超限先 `cancel` 再通知；防止一个失控的子 agent 烧光额度。
6. **审计**：spawn / prompt / approval / artifact / finish 全部落 `qm_audit`，可回放一次任务的全过程。

## 9. 渠道补遗：watch

watch 不是宿主，是一个能力很窄的渠道——和 QQ、飞书同级，只是交互形态不同。

| 能力 | 值 | 说明 |
| --- | --- | --- |
| 语音入 | ✅ | 手表录音 → STT（`service-media`）→ 文本 |
| 文本出 | ⚠️ 一句话 | 超过一行就"请在手机上展开" |
| 语音出 | ✅ | TTS 播报，适合"该吃药了"这类 |
| 通知 | ✅ | 系统通知 + 触感 |
| 确认按钮 | ✅ | 审批场景的两键确认 |
| 富文本/图片/卡片 | ❌ | 不支持，降级为一句话 |

交互范式：**问一句 → 给一句结论 → 需要细节就甩到手机**。
它是 M7 的事，最后做；因为对其它部分零依赖，只消费 `notify` + `permission` + STT/TTS。

## 10. 对既有文档的修订

| 文档 | 修订 |
| --- | --- |
| [01](01-架构总览.md) | 编排层之上新增 **harness 层**（`harness` 服务 + ACP/MCP 适配）；青梅恢复独立进程 |
| [02](02-服务契约.md) | 新增 `harness` 服务契约；`task` 从「表」升级为「账本 + TaskRun 状态机」 |
| [03](03-渠道与宿主.md) | 新增 `channel-watch`；宿主仍是 Web/Electron/APK，watch 只做渠道 |
| [05](05-落地路线.md) | 在 M5 之后插入 harness 集成；watch 作为 M7 |
| [06](06-基于DSH的复用方案.md) | 降级为参考资料：DSH 不再是底座，只是第一个接入的 harness |

## 11. 两周 spike

| # | 假设 | 验证 | 失败退路 |
| --- | --- | --- | --- |
| H1 | 青梅能拉起 `dsh --profile acp` 并完成一次 prompt | 写 150 行 ACP client，stdio 跑通 initialize → new → prompt → close | 改用 DSH 的 SDK/headless 模式，或先做 MCP-only |
| H2 | 注入青梅 MCP 后，子 agent 会主动上报进度 | 会话里让模型"修一个 bug 并随时报告进度"，观察 `qm_report_progress` 调用 | 退化为轮询：青梅定期 `qm_ask_human`/读会话状态 |
| H3 | 审批桥可闭环 | 让子 agent 执行一条被拦截的命令 → 手机收到确认 → 批准 → 继续 | 退化为"预授权全部允许 + 事后审计"，但必须显式告知用户风险 |

三条都过，harness 层的设计就成立；任何一条不过，先修协议而不是先写业务。
