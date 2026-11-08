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
  target: { deviceId?, workspaceId?, harness? }
  sessionId?: string
  status
```

## 4.1 TaskTarget

服务器任务和设备任务共用：

```ts
interface TaskTarget {
  deviceId?: string
  workspaceId?: string
  harnessId?: string
  sessionId?: string
  cwd?: string
}
```

`TaskRun.target` 和 `qm_device_task` 的 API 现在都输出 `target`。旧字段保留一段时间兼容，但新代码优先读 `target`，不再分别解释 `deviceId/harness/workspaceId`。

最终目标是删除 `DeviceTask` 这个独立业务概念，设备只是 `TaskTarget.deviceId`。
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
  source: 'server' | 'device'
}
```

服务器任务 `source = server`，设备任务 `source = device`。UI 只按 `TaskView` 渲染，不再分别判断两种任务对象。

## 5. 数据流

### 对话

```text
channel adapter
  → qm/channel/inbound
  → assistant/conversation plugin
  → memory.recall
  → llm / harness
  → qm/assistant/reply
  → channel.send
  → qm/history
```

### 任务

```text
TaskService.dispatch
  → task queue
  → HarnessService.run
  → progress / approval
  → qm/task/finished
  → memory / history
```

渠道插件不直接调用 memory/task；任务插件不直接发渠道消息；审批插件通过 approval service 和事件工作。

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
