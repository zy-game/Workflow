# Cordis 架构约束

青梅是 Cordis 应用：组合根只装配，能力全部是插件，数据通过服务契约和事件流动。

## 1. 组合根

`apps/server/src/index.ts` / `cli.ts` 只负责：

- 读取配置
- 按清单加载插件
- 启停

不得在组合根里写业务分支，也不得直接访问业务 collection。

## 2. 插件形态

```ts
export const name = '@qingmei/xxx'
export const inject = ['store', 'gateway', 'memory']

export function apply(ctx: Context, config: XxxConfig): void {
  const store = ctx.store
  const gateway = ctx.gateway
  ...
}
```

规则：

- 依赖必须在 `inject` 中声明。
- 已声明的服务直接使用 `ctx.<service>`，不再 `ctx.reflect.get('<service>')`。
- `ctx.reflect.get` 只允许用于**真正可选的增强依赖**，并要在代码注释说明降级行为；不允许用来绕过 inject。
- 生命周期用 `ctx.effect`，事件用 `ctx.events.on/emit`，不要自己实现全局单例。
- 一个插件只负责一个能力域；跨域只能调用服务或发事件。

## 3. 数据所有权

每条 collection 只能有一个 owner 插件：

```text
qm_message       qm-history
qm_session_*     qm-device / qm-thread
qm_task_run      provider-task-sqlite
qm_approval      provider-approval-sqlite
qm_channel_target qm-approval
```

其他插件不得直接 `store.collection()` 读写别人的表；需要数据就调用 owner 的服务方法。

## 4. 统一领域模型

只保留三个用户可理解的概念：

```text
Conversation  一次持续对话
Task          一次需要执行器的意图
Device        执行任务的位置
```

`Turn` 是 Conversation 的回合，`Harness`/`Session` 是执行适配器细节，不作为用户概念。

`DeviceTask`、`TaskRun`、`HarnessRequest` 不应继续作为并列业务模型存在：

```text
Task
  target: { executorId, workspaceId?, sessionKey?, cwd? }
  sessionId?: string
  status
```

## 3.1 执行门禁

```bash
pnpm arch       # 0 reflect + 0 跨插件 collection，否则退出 1
pnpm artifacts  # Android APK 的 size/sha256 与 Desktop 安装器存在
```

`check-architecture.mjs` 默认报告，`--strict` 作为提交/发布门禁。
## 4.0 Conversation session key

会话在历史/线程里的规范 key 只由核心函数生成：

```ts
conversationSessionId(conversationId)   // s_<id>
conversationIdFromSession(sessionId)    // 还原
```

`qm-agent`、`qm-history`、`host-gateway` 不再各自拼 `s_` 前缀。
## 4.1 TaskTarget

执行器只有一个领域概念：DSH executor。服务器和设备只是执行位置：

```ts
interface TaskTarget {
  executorId: string      // local | device:<id>
  workspaceId?: string
  sessionKey?: string     // 复用执行器会话的键，不是 qm-thread 的 Thread
  cwd?: string
}
```

`TaskRun.target` 是唯一目标来源；不再有根上的 `harnessId`、`cwd`、`source`，也不再有 `target.deviceId/harnessId/threadId/sessionId/legacyId`。

对外统一为 `TaskView`：

```ts
interface TaskView {
  id: string
  title: string
  prompt: string
  status: TaskStatus
  target: TaskTarget
  sessionId: string | null
  result: string | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}
```

`sessionId` 是执行器返回的真实会话 id；`target.sessionKey` 是请求复用的键。

### 存储状态

所有任务都写 `qm_task_run`。`qm_device_task` 已迁移并清空，代码中不再读取。

### 当前执行路径

```text
target.executorId = local
  → qm-task TaskRunner
  → provider-dsh-acp

target.executorId = device:<id>
  → qm-device claim
  → 设备 companion（DSH Host）
```

两条路径共享同一个 Task 账本和 TaskView，但调度/审批/上下文仍有两套实现差异；后续要收敛到统一 ExecutorRegistry/TaskDispatcher。

## 5. 数据流

### 对话

```text
channel adapter
  → qm/inbound
  → qm-agent
  → memory.recall
  → local DSH harness / llm
  → qm/turn/chunk
  → channel.send
  → qm/outbound
  → qm-history
  → qm/turn/end
```

### 任务

设备任务也走 `POST /api/v1/tasks`，target 为 `device:<id>`；`/api/v1/devices/tasks` 只保留列表查询，不再创建任务。

```text
POST /api/v1/tasks
  → local: qm-task TaskRunner
  → device: qm-device TaskTargetService 解析，qm-device claim
  → TaskService.create 写 qm_task_run

执行器
  → progress / usage / session
  → TaskService.reportProgress / finish
  → qm/task/finished
```

渠道插件不直接调用 memory/task；任务插件不直接发渠道消息；审批通过 approval service 和事件工作。

## 6. 目标插件图

```text
core
service-store / service-memory / service-llm
service-channel / service-gateway
service-schedule / service-approval
service-conversation / service-task
service-device / service-harness

provider-store-sqlite / provider-memory-sqlite
provider-task-sqlite / provider-approval-sqlite
provider-schedule-sqlite / provider-dsh-acp
provider-llm

channel-web / channel-feishu / channel-qq

qm-assistant / qm-tasking / qm-proactive
qm-identity / qm-conversation
qm-device-bridge

apps/server / web / desktop / mobile
apps/dsh-companion / dsh-worker
```

目标是约 20 个包，不再继续增加平级业务插件。

## 7. 迁移检查

```bash
node scripts/check-architecture.mjs
```

默认输出基线；`--strict` 在出现新增违规时返回非零。
