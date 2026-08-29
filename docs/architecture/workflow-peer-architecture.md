# Workflow 对等多节点架构方案

状态：已确定，作为后续重构与实现的基线。

## 1. 目标与范围

Workflow 是一个以 DeepSeek Harness（DSH）为 Agent Runtime 的个人助手与任务编排系统。系统需要同时支持服务器和多个个人设备运行完整 Workflow，并允许任意节点发起任务、执行任务、查看同步后的任务和 Workflow 数据。

本方案解决以下问题：

- 每个设备如何成为可独立运行的 Workflow 节点；
- 节点之间如何同步任务、会话、执行事件和业务数据；
- 如何根据项目归属确定唯一执行节点；
- 如何避免同步后的任务被其他节点重复执行；
- 如何在不引入传统主从 Worker 的前提下使用 DSH；
- 如何隔离凭据、本地路径和高风险工具能力。

本方案不把 DSH Session 直接当作业务 Task，也不把 DSH 的 Workspace/Group 名称直接当作分布式权威。Workflow 负责定义稳定的业务模型和路由规则，DSH 负责 Agent 会话、模型调用、工具生命周期和运行时扩展。

## 2. 核心决策

### 2.1 所有节点都是完整 Workflow

每个注册节点都包含完整的 Workflow 能力：

- DSH Agent Runtime；
- Workflow Task Store 和投影；
- Project Registry；
- Session Store；
- Task Event Log；
- Peer Sync；
- 冲突检测与幂等处理；
- Gateway/API/UI；
- 本地工具运行时和设备适配器。

节点之间是对等关系，没有固定 Master、Worker 或任务抢占者。服务器节点也是一个完整 Peer，只是可以额外提供稳定入口、Web UI、外部 API、Peer Discovery、同步中继、断线转发和备份能力。这些基础设施职责不赋予服务器对业务任务的天然主权。

### 2.2 取消传统 dshworker 从属模型

不再采用以下模型：

```text
Core -> Worker -> 抢任务 -> 执行
```

也不再使用多节点竞争领取同一个任务作为正常调度机制。可以保留 `run_id`、执行记录和人工或策略驱动的重试，但它们用于审计、恢复和重试，不用于节点之间竞选执行权。

“Worker”如果在实现中仍作为名称存在，只能表示本地受控工具执行组件或子进程边界，不能表示一个受 Workflow 主节点派发的从属节点。

## 3. 领域模型

### 3.1 Task

Task 是 Workflow 的业务任务，独立于 DSH Session。建议字段：

```text
Task
├── task_id                         稳定的全局任务 ID
├── origin_node_id                  创建任务的节点
├── project_id                      项目 ID；缺省时为 default
├── creator_id                      创建者或调用方
├── goal                            任务目标
├── input_ref                       非敏感的逻辑输入引用
├── status                          业务状态
├── session_id                      关联的 DSH Session，可为空
├── executor_node_id                根据规则确定的执行节点
├── execution_policy_snapshot       创建时固化的路由策略
├── created_at / updated_at
└── version                         用于投影和同步
```

Task 状态由事件投影得到，而不是由任意节点直接覆盖最终值。涉及执行的状态变更必须携带 `executor_node_id` 和来源事件，便于其他节点验证权限和幂等应用。

### 3.2 Project

Project 是 Workflow 自己定义的任务路由和执行域。建议字段：

```text
Project
├── project_id                      稳定 ID
├── name / slug                     展示名和人类可读标识
├── owner_node_id                   项目所属执行节点
├── execution_policy                owner 或 origin
├── workspace_ref                   逻辑工作区引用，不是本机绝对路径
├── dsh_group_ref                   可选的 DSH Workspace/Group 映射
├── capabilities                    允许使用的能力声明
├── permissions                     项目成员和操作权限
├── version
└── created_at / updated_at
```

`project_id` 是 Workflow 的稳定权威标识。`dsh_group_ref` 只是与 DSH 概念的映射，不能单独承担任务归属、授权或冲突解决职责。

系统必须包含一个全局特殊项目 `default`。它不是某个固定设备的项目，而是“由任务发起节点执行”的默认执行域。

### 3.3 DSH Session

DSH Session 表示一次 Agent 会话和运行事实，可能包含多个 Turn、Step、模型请求和工具调用。它可以与一个 Task 关联，但两者生命周期不同：

- Task 描述用户或系统要完成的业务目标；
- Session 描述 DSH Agent 实际如何完成目标；
- 一个 Task 可以因重试或恢复产生多个运行记录，但应明确当前有效 `session_id`；
- Session 事件不得替代 Task 领域事件。

建议在 DSH Session Context 中保存 `task_id`、`project_id`、`origin_node_id` 和 `executor_node_id` 等非敏感关联元数据。

### 3.4 Task Event

同步的基本单位是追加式事件，而不是各节点之间直接覆盖 Task 最终状态。事件建议包含：

```json
{
  "event_id": "event-123",
  "event_type": "tool.completed",
  "task_id": "task-001",
  "project_id": "proj1",
  "origin_node_id": "node-b",
  "executor_node_id": "node-a",
  "session_id": "session-001",
  "sequence": 42,
  "occurred_at": "2026-01-01T00:00:00.000Z",
  "payload": {}
}
```

事件必须具备全局幂等键。节点收到重复事件时只确认已处理，不再次运行 Agent 或工具。对外同步的 payload 只包含逻辑值和必要的非敏感引用，不包含凭据、本机绝对路径、Core/Worker token 或环境变量值。

## 4. 任务路由与执行规则

### 4.1 明确指定项目

当任务明确指定 `project_id`：

1. 创建节点读取本地 Project Registry；
2. 根据项目的 `owner_node_id` 和 `execution_policy` 固化 `executor_node_id`；
3. Task 和创建事件同步给所有可达 Peer；
4. 只有 `executor_node_id` 对应节点可以启动该 Task 的 Agent Run；
5. 其他节点只建立本地投影、展示状态、提供观察和交互能力，不执行相同工具调用。

默认策略为 `owner`：项目的任务由项目所属节点执行。如果未来引入 `origin` 策略，必须在 Task 创建时写入 `execution_policy_snapshot`，避免项目后来变更导致历史任务改道。

### 4.2 未指定项目

当任务没有明确的项目或分组目标：

1. 系统将 `project_id` 归一化为全局 `default`；
2. `executor_node_id` 设置为 `origin_node_id`；
3. Task 仍然同步到其他节点；
4. 只有发起节点启动 Agent Run；
5. 其他节点接收执行事件并更新本地投影，不重复执行。

因此，“任务同步”与“任务执行”是两个独立动作。同步保证多设备可见和可恢复，路由规则保证每个任务在正常情况下只有一个执行点。

### 4.3 执行权验证

执行节点在启动前必须重新验证：

- Task 的事件是否已应用且未被撤销；
- Project 归属、权限和策略快照是否允许本节点执行；
- 当前节点身份是否仍有效；
- 是否已经存在相同 `task_id`/`run_id` 的已启动或已完成运行；
- 所需本地能力和凭据引用是否可用。

Agent 自身的判断不能替代 Workflow 层的执行权检查。未通过检查的节点必须拒绝启动并生成可同步的拒绝事件。

## 5. 同步、离线与冲突

### 5.1 同步内容

默认同步以下内容：

- Task 元数据和状态事件；
- Project 元数据、版本和路由策略；
- Session 的可共享事件和投影；
- 工具执行开始、进度、结果和错误事件；
- 同步游标、确认信息和审计元数据。

大附件、设备私有数据和敏感上下文使用受控引用或按权限同步，不默认全量复制。节点本地可保留不出设备的原始凭据和私有文件。

### 5.2 传输与存储

Peer 之间应使用经过认证和加密的连接。事件需要节点身份签名或等价的来源认证，以便接收节点判断事件来源、撤销节点权限并防止伪造执行结果。离线节点将事件写入本地追加日志，恢复连接后按事件 ID 和游标补发，服务端可承担 store-and-forward 中继。

### 5.3 幂等和冲突

- 事件按 `event_id` 去重；
- 同一 Task 的执行启动按 `task_id` + `run_id` 建立幂等约束；
- 项目归属变更只影响新任务，历史 Task 使用已固化的策略快照；
- 对同一逻辑对象的并发修改保留事件来源和版本，不静默覆盖；
- 无法自动合并的冲突进入可审计的冲突记录，由明确的恢复策略处理。

正常路由不依赖多节点抢占。只有在明确的故障转移或人工重试流程中，才允许创建新的执行尝试，并且必须产生新的 `run_id` 和审计事件。

## 6. DSH 集成边界

DSH 是每个节点的 Agent Runtime，负责：

- Profile、Bundle 和 Patch 的插件组合；
- Agent Loop、Turn、Step 和工具生命周期；
- Session 持久化；
- 模型/Provider 调用；
- 本地工具和设备能力的受控接入；
- DSH Gateway 与客户端交互。

Workflow 负责：

- Task 和 Project 的业务模型；
- Project 到执行节点的确定性路由；
- 对等节点身份和权限；
- Task Event 同步、幂等和投影；
- 执行权验证、审计、离线缓存和冲突处理；
- 敏感数据边界。

推荐映射：

```text
Workflow Project
    -> dsh_group_ref / DSH Workspace
Workflow Task
    -> DSH Session Context + task_id
Workflow Task Event
    -> DSH Session/Agent 事件的外层业务关联
```

不能只依据当前 DSH 的分组名称推断分布式所有权，必须通过 Workflow Project Registry 和同步事件验证。

## 7. 安全与隐私约束

- 凭据只在节点本地受控认证流程中处理，事件和 Session 只保存非敏感引用；
- 本机绝对路径、可执行路径、环境变量值和 token 不进入任务 payload、同步事件、日志或知识库；
- Core token 只从进程环境或系统凭据读取；
- 项目权限由 Workflow 强制执行，不交给 Agent 自主决定；
- Shell、文件系统、浏览器和其他高风险工具应通过受控子进程或沙箱执行；
- 节点注销、撤销和凭据轮换必须能阻止后续执行；
- 同步接口按项目和数据分类授权，不默认把私有文件、凭据或完整上下文广播给所有 Peer；
- 所有执行拒绝、重试、故障转移和冲突解决都应留下可审计事件。

## 8. 当前实现与迁移顺序

### 阶段 A：运行时依赖基线

将 `dsh-workflow` 中的 DSH 依赖升级到 npm 当前最新可用版本，并重新生成锁文件。当前确认：

- `@deepseek-ai/dsh`：`0.1.1-rc.2`；
- Session/Storage 相关包当前分别发布为 `0.0.1-rc.1`，不能机械套用主包版本号；
- 仓库其他项目未声明 `@deepseek-ai/dsh` 依赖，客户端的 `dsh-neotui` fork 暂不随本次升级修改。

升级后必须检查：

- Session 和 Storage 的导出、插件生命周期及读写 API；
- SQLite schema/application ID/user version；
- DSH domain descriptor 导出；
- server/patch overlay 的插件 ID、配置和 hook；
- 现有迁移工具的只读和幂等不变量。

### 阶段 B：单节点领域模型（已完成）

已完成 Core 本地稳定 `node_id`、Task 的 origin/executor 路由字段、`default -> origin` 归一化、项目执行节点快照，以及 Worker WebSocket/Bridge pull 的本地节点过滤。当前仍是单 Core 的本地执行适配，不是 Peer 事件同步。

### 阶段 C：对等同步（进行中）

第一批已落地 core.db schema v16：`peer_nodes`（Peer 注册/撤销）、`peer_sync_outbox`（本节点决策的单调事件日志，随任务事务原子写入）、`peer_sync_inbox`（按 `event_id` 幂等的收件日志）、`peer_sync_cursors`（每 Peer 的入站/出站游标）。HTTP 契约为 `POST /api/v1/peer/sync/handshake|pull|push|ack`，调用方身份取自 `peer` 角色机器 token 的 subject，不信任 body。任务创建仅由 origin 节点发布；执行状态更新由 origin 或 executor 节点发布；ingest 通过终态吸收的投影写入应用远端事件，重放事件只计 duplicate，不会重复投影或回环。

第二批已落地节点间拉取连接器 `src/sync/client.js`：每个节点按 `WFC_PEERS_JSON`（node_id、endpoint、远端签发的 peer token；token 只经环境配置通道）周期性从各 peer 拉取事件、本地 ingest、并回 ack；游标持久化在 core.db，节点离线或远端故障恢复后从断点续传；远端丢失数据库时对 `PEER_UNKNOWN` 自动重新握手。并发 `tick()` 加入进行中的一轮而不是跳过；peer 确认过的 outbox 事件按最慢活跃 peer 的 ack 游标清理（`pruneAcked`），且序列号不回绕。

第三批已落地项目注册表同步：knowledge 仓库提供 `onChange` 观察者与 `createProjectFromSync` 投影写入；项目 create/update 通过同一事件管道传播（entity_type `project`），仅 owner 节点发布，payload 只含 name/type/goal/status/metadata，机器本地 locations 不出节点。ingest 规则：payload 的 owner 必须等于事件来源节点；已归属项目不能被其他节点接管；update 遇到缺失投影时自愈补建。由此形成跨节点路由闭环——peer 拿到项目 owner 后，本机创建的项目任务经路由 facade 自动指向 owner 节点执行，完成状态再同步回发起节点（双节点真 HTTP 端到端测试覆盖）。

第四批：撤销改为粘性语义——已撤销 peer 的握手（registerPeer）不再复活它，只有显式 `activatePeer` 管理动作可恢复；服务端以 `PEER_REVOKED` 区分撤销与未注册，pull 客户端收到 `PEER_REVOKED` 后永久退出该 peer 的轮询。同时 claimed/progress 事件现在也投影到 peer（dispatched/running 与最近一条 note/percent），peer 任务列表可见实时执行状态，非终态更新不覆盖已有 result。

第五批：push 型传输补齐——peer 配置新增 `pull`（默认 true）与 `push`（默认 false）标志。推送方以本方记录的 outbound ack 游标为起点分页推送 outbox，接收方在 push 响应里回显其 inbound_cursor 作为回执 ack，推送方据此本地记账并支持清理——全程只需推送方发起连接，适配"一方在 NAT 后不可被连接"的拓扑。registry-only peer（pull:false 且 push:false）仅注册不传输。双节点 e2e 验证：beta 不可被 alpha 连接时，alpha 的决策经 pull 到达 beta，beta 的执行结果经 push 回到 alpha。

尚待实现：事件签名（HMAC/非对称）、store-and-forward relay（服务器中转，复用同一事件契约）。

### 阶段 D：执行路由（已完成）

实现 `project.owner_node_id` 路由和 `default -> origin_node_id` 规则，启动 Agent Run 前执行权校验，并确保非执行节点只投影事件。

### 阶段 E：客户端与运维

在不改变 DSH Gateway 协议的前提下，让已有终端客户端显示 Task/Project/Peer 状态；必要时再单独升级本地 NeoTUI fork。增加节点注册、撤销、权限管理、审计和故障恢复操作。

## 9. 验收标准

- 任意节点都能创建 Task，Task 能同步到所有授权 Peer；
- 指定项目的 Task 只在项目所属节点执行；
- 未指定项目的 Task 进入 `default`，只由发起节点执行；
- 其他节点重复收到 Task 或执行事件时不会重复运行工具；
- 节点离线期间产生的事件在恢复连接后可补发且不丢失；
- Project 变更不会改写历史 Task 的执行节点；
- Session、Task 和 Event 的数据边界清晰，敏感信息不被广播；
- DSH 升级后迁移、schema、overlay 和 workflow-context 测试全部通过；
- 迁移失败或 schema 不兼容时不覆盖源数据或已有目标数据。
