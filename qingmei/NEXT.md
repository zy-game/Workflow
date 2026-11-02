# NEXT · 下个会话从这里开始

> 写于 2026-11-02。**先读 `docs/00`（七段路线）+ `docs/05`（里程碑）再看本文件**：
> 本文件只是「现在走到哪、下一步为什么是它」，不是任务清单。
> 仓库全量测试 172/172（`node --test`），端到端 `node scripts/smoke.mjs` 通过。
> 新会话第一句建议：「读 qingmei/NEXT.md，按整体方案继续」。

## 1. 现在是什么状态

```text
Web/QQ ─▶ gateway ─▶ qm-agent ─┬─▶ harness（DSH 0.2.1 / ACP）  对话车道
                                └─▶ llm（OpenAI 兼容 / sub2api） 降级 + 后台抽取
qm-task ─▶ harness（run 目录 + 任务会话）                      执行车道
memory（事实）· mcp（对话工具 + 任务上报工具）· schedule（at/everyMs/cron/暂停）
task（qm_task_run 账本）· permission（静态策略）· audit（qm_audit）· channel · store
qm-history（qm_message 的唯一写入方）
```

已可用的能力：

- 说一句话 → 抽取事实 → 重启后仍能召回；DSH 也会主动调 `memory_recall`
- 建提醒：一次性（`at`）、固定间隔（`everyMs`）、cron（`cron` + `timezone`）
  - `schedule_create` 的 `seconds` 会换算成一次性绝对时间，不会变成无限重复
  - cron 未带时区时用 provider 的 `defaultTimezone`（生产配的是 `Asia/Shanghai`）
- cron 语义：`*` `n` `a-b` `a,b` `*/n` `a-b/n`；周 0/7 都是周日；日与周同时限定时取「或」
  - 时区换算用 `Intl.DateTimeFormat` 反推 UTC：夏令时跳过的本地时间不触发，
    重复的本地时间只触发一次
- 停机错过的：默认补发一次后重排；`missedPolicy: 'skip'` 则直接跳到下一次
- **暂停 / 继续**：`schedule_pause` / `schedule_resume`（服务 `pause(id)` / `resume(id)`）
  - 暂停只保留 `nextAt`，tick 跳过；继续时周期日程从「现在」重排，一次性保持原时间
  - 已触发的一次性提醒不会被 resume 复活（返回 false）
  - 接口 `POST /api/v1/schedules/<id>/pause|resume`，面板上每行「暂停/继续」+「取消」
- **编辑**：`schedule_update`（服务 `update(id, patch)`）
  - 只给 `text` 就只改文案，`nextAt` 不变；给了 `cron` / `at` / `everyMs` 就整体替换规则并重排
  - 接口 `PATCH /api/v1/schedules/<id>`；面板行内编辑：内容 + 规则（cron 表达式与时区 / 间隔秒数 / 本地时间）
- 提醒到点后投递到 Web 并自动进会话历史（走 `qm/outbound`，不需要自己落库）
- **Web 日程面板**：顶栏「日程」→ 列出全部提醒（按 nextAt 排序、按各自时区显示时间、
  带 cron 规则与 id），可逐条取消，已触发的一次性提醒保留最近 5 条
  - 接口 `GET /api/v1/schedules`、`DELETE /api/v1/schedules/<id>`
- **消息落库只有一个写方**：`qm-history`
  - `qm/turn/start` → 用户消息；`qm/outbound`（渠道投递成功后）→ 助手消息
  - `qm-agent` 只读 `qm_message` 组装上下文，`qm-reminder` 只投递不落库
- **工具准入与审计**：每次 `tools/call` 先过 `permission` 再执行
  - 判定：显式 deny > 显式 allow > 群聊默认 > 工具风险 > 全局默认 deny
  - 工具分 `read` / `write` / `dangerous`；群聊拒绝改日程/写记忆，理由是可读中文
  - `dangerous` 或 `ask` 一律先拒（渠道确认链路未做）；被拒绝的调用也写审计
  - 审计落 `qm_audit`（只追加），列名按 docs/04；每次调用一条，带 `trace_id`
- 人格白名单 + 输出卫生（内部工具名/路径不外泄）
- **主动循环（A1 骨架）**：每 5 分钟快照 → 规则候选（待确认审批 / 临近日程 / 失败任务）→ 过滤
  （静默时段 / 每日 3 条预算 / 4 小时冷却）→ 建议 + decision trace；Web「主动」面板可回看理由
- **记忆（M1 语义收口）**：同一 `subject+predicate` 的新值让旧值 `valid_to` 置位（不删除）；
  `audience` 区分 owner 与群，群聊只注入该群 public 事实（private/secret 零注入）；
  `qm-agent` 把 memory 列为必需依赖（缺了不启动，不再静默降级）
- **派任务给 DSH**：对话里说「派个任务」→ DSH 调 `qm_dispatch_task` → `qm-task` 建 run、
  分配 `data/workspaces/<runId>`、调 `harness.run`；子 agent 经 `qm_report_progress` /
  `qm_finish_task` 回报，账本落 `qm_task_run`
  - H1（ACP 拉起）、H2（子 agent 主动上报）、H 验收第 1/2 条 2026-11-02 已在生产验证
  - Web 顶栏「任务」面板：状态 / 进度 / 结论，订阅 `task-started|progress|finished` 自动刷新
  - 也可以绕开对话直接 `POST /api/v1/tasks`

- **审批桥**：工具被判 `ask`、或子 agent 发 ACP `session/request_permission` 时落 `qm_approval`，
  Web「任务」面板顶部「待确认」区批准/拒绝；批准后调用方继续，拒绝/超时按拒绝处理
  - `GET /api/v1/approvals`、`POST /api/v1/approvals/decide`；状态推 SSE
  - 生产实测：工具被拦 → 批准 → 1.2s 内继续执行，审计记 `allow` + approvalId

## 2. 下一步（按整体方案排，不按清单）

整体方案的分段（docs/00 §8）：P1 地基 = M0+M1+M2；P2 手与口 = M3+M3 的渠道 + H；
P3 贾维斯感 = A1–A3；后面是 N/N+/G/W/S。现在的实际位置：

- **P1**：M0 完成；M2 日程侧完成（差渠道确认）；**M1 只做了事实子集**（没 audience / validTo / 画像）
- **P2**：H 已通 H1/H2（任务账本、派发、上报），差任务面板 / H3 审批桥 / resume / 预算；
  M3（QQ/飞书）**没有硬件条件**——需要账号、可能需要公网/长连接，先不碰
- **P3**：A1 自主循环的前置（任务账本 + 日程 + 权限）已经具备

按这个位置，下一步按价值排：

1. **H 收尾**：任务面板 ✅、H3 审批桥 ✅、`session_id` 回填 ✅、`qm doctor` 的 harness 段 ✅、
   产物（`qm_publish_artifact`，先记引用）✅、token 用量记录 ✅、ACP 文件/命令能力 ✅；
   还差 resume（拿 session_id 调 `session/resume`）与 token 预算的硬拦截
   （DSH 目前不返回 usage，可能得等 harness 支持）。
2. **M1 剩余**：`audience` + `validTo` + 群聊零注入 ✅、memory 必需化 ✅；
   还差画像最小版（docs/05 M1 交付物）、`summarize`、情节/决策/教训类型、断网抽取补偿队列。
3. **历史表的列级迁移**（接 M3 平台前）：索引与查询下推已完成；`steps` / `tokens_*` / 
   `error_code` 还没采集，也仍没有真正的列级表结构（字段语义靠代码保证）。
4. **A3 收尾**：QQ/飞书渠道等 M3；盘点结论的追问闭环（「那个盘点结果呢」直接回最近的 inventory run）。
   自动盘点与结论回推已完成。
5. **A5 剩余**：回滚/投诉信号。
   采纳/忽略记账、忽略降频、可选自动升级、显式级别入口、只进摘要都已完成。
6. **A2 后半**：排期器的优先级/时间窗/依赖/抢占（并发容量、FIFO 排队、重启恢复已完成）。
7. **渠道联调（M3）**：飞书/QQ 适配器已实现，等真实凭据；要做群策略（@ 才回）、
   审批回复映射、平台重投演练。审批目前只有 Web 入口。
8. 工程侧：路由挪回插件、`cron.ts` 拆包（`GET /api/v1/audit` 已完成）。

## 3. 已知技术债（按优先级）

1. **没有 tsc**：仓库只有 cordis 依赖，类型正确性靠审阅；若要补，加 typescript 并跑 `tsc --noEmit`。
2. **tick 是全表扫描**：每秒 `find()` 一遍 `qm_schedule` 再在 JS 里比时间，日程多了要按 `next_at` 建索引或缩小查询。
3. **前端没有构建与类型检查**：`apps/web/public/app.js` 是零构建原生模块，只靠
   `apps/web/test/ui-contract.test.ts` 守 DOM id 与接口路径。
4. **历史表没有索引**：`qm_message` 每次 `find()` 都是全表扫（store 是通用 JSON 表），
   长对话后要按 `session_id + created_at` 建真实列或加二级索引 —— 与第 2 节第 3 条一起做。
5. **MCP 工具命名未统一**：对话车道是 `memory_*` / `schedule_*`，任务数据面已经是 `qm_*`；
   两套并存，接更多 harness 前要统一。
6. **任务执行侧还缺**：resume（session_id 有了，但没接 `session/resume`）、token 预算、产物；
   被 kill 的 run 依赖 harness 抛错记 failed，没有进程级兜底（`qm doctor` 能看到最近失败）。
7. **审计没有查询接口**：只能查库或写脚本；等路由挪回插件时一起给 `GET /api/v1/audit`。
8. **部署不是自动的**：改完要手动 tar/scp/install/restart，见下。

## 4. 运维速查（139.155.78.241，用户 ubuntu，密钥 company.pem）

```bash
# 本地
cd E:/Workflow/qingmei && node --test          # 全量测试
node scripts/smoke.mjs                        # 端到端：起服务→发消息→落库→重启后还在
tar -czf ../qingmei-m2.tgz -C . --exclude=node_modules --exclude=data --exclude=.git .

# 上传 + 部署
scp -i ~/.ssh/company.pem ../qingmei-m2.tgz ubuntu@139.155.78.241:/tmp/q.tgz
ssh ... "cd /opt/qingmei && tar -xzf /tmp/q.tgz && cp qingmei.prod.yml qingmei.yml
  && PATH=/opt/dsh/bin:/opt/node24/bin:\$PATH corepack pnpm install --prod --frozen-lockfile
  && sudo systemctl restart qingmei"

# 健康
curl -s http://127.0.0.1:7410/healthz
sudo journalctl -u qingmei -n 50 --no-pager
```

密钥都在 `/etc/qingmei/env`（0600）：`QM_TOKEN` / `QM_LLM_*` / `QM_DSH_API_KEY` / `QM_MCP_TOKEN`。
访问地址：`https://139.155.78.241:8710/?token=<QM_TOKEN>`。
服务器时区是 `Asia/Shanghai`，Node 在 `/opt/node24/bin`（默认 PATH 里的 node 是 20，跑不了 `node:sqlite`）。

## 5. 本次改动的落点

### 审批按钮：QQ keyboard + 卡片点后失效

| 文件 | 改了什么 |
| --- | --- |
| `packages/channel-feishu` | 点击后按 `editTarget` 更新原卡片（`im/v1/messages` PATCH），按钮消失 |
| `packages/channel-qq` | 出站带 `actions` 时发 `msg_type=2` + `keyboard`；`INTERACTION_CREATE`(type=11) → `qm/action`，`PUT /interactions/{id}` 应答；intents 加 `1<<26`；按钮未开通自动退回文本 |
| `packages/qm-approval` | 推送记录每个目标的 `messageId`；决定后按目标逐条 `editTarget` 更新（文本回复也会把卡片置为已处理） |
| `packages/qm-history` | `editTarget` 更新原消息行（blocks/text），不新增、不被幂等索引吞掉 |
| 测试 | 277 全绿 |

### 审批卡片按钮与推送渠道标记

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | 事件 `qm/action` + `ActionEvent` |
| `packages/channel-feishu` | 出站遇到 `actions` 块渲染成交互卡片（按钮 value 带 `actionId`）；`card.action.trigger` 事件转成 `qm/action`；`sendCard` |
| `packages/qm-approval` | 推送带「同意/拒绝」按钮；监听 `qm/action` 直接决定并回执；记录 `qm_approval_push`，`GET /api/v1/approvals` 返回 `notifiedTo` |
| `apps/web` | 待确认条目显示「已推送 飞书/QQ」 |
| 测试 | 272 全绿（卡片渲染、按钮动作、推送渠道标记） |

> QQ 暂不支持按钮，收到的是文本 + 回复「批准/拒绝」。

### 审批推送渠道### M3 渠道骨架：飞书与 QQ 机器人

| 文件 | 改了什么 |
| --- | --- |
| `packages/channel-feishu`（新） | 官方机器人 WebSocket 长连接；入站 `im.message.receive_v1` → `qm/inbound`；出站 `im/v1/messages`；同一 message_id 去重；`allowedChatIds` 白名单；凭据缺失不注册 |
| `packages/channel-qq`（新） | QQ 开放平台机器人：token → `/gateway` → identify（`GROUP_AND_C2C_EVENT`）→ 心跳/重连；入站 C2C 与群 @；出站 `/v2/users|groups/.../messages`；会话 id 带 `dm:`/`group:` 前缀 |
| 配置 | dev/prod 注册两个渠道（无凭据时 info 日志跳过）；`apps/server` 依赖 |
| 测试 | 飞书 7 条（入站归一化/去重/过滤/出站/失败/凭据缺失）+ QQ 8 条（编码、入站、出站、帧解析、凭据缺失）；全量 248 → 263 |

> 两地实现参考了 workflow-core 历史提交里的 `feishu/client.js` / `feishu/service.js`（WebSocket 长连接、事件去重、审批回复），按青梅的渠道契约重写。

### 历史表索引与查询下推

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` / `provider-store-sqlite` | `StoreService.ensureIndex`（表达式索引/部分唯一索引）；`find`/`count` 的 `where`（标量等值）与 `order`/`limit`/`offset` 下推成 SQL（`json_extract`），不安全字段退回 JS |
| `packages/qm-history` | 启动时建 `qm_message(session_id, created_at)`、`qm_message(session_id, platform_message_id)` 唯一、`qm_turn(session_id)`；唯一冲突视作幂等成功（含 cause 链识别） |
| 测试 | 2 条 store（唯一索引、null 只匹配显式 null）+ 全量通过；242 → 248 |

### 审计查询接口

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` / `provider-audit-sqlite` | `AuditService.query` 支持 `decision` 过滤 |
| `packages/qm-audit`（新） | `GET /api/v1/audit?limit=&action=&actor=&decision=&since=`；只读，非法 `decision`/`since` 返回 400，limit 上限 200 |
| 配置 | dev/prod 注册 `qm-audit`；`apps/server` 依赖 |
| 测试 | 4 条（倒序与 limit、过滤、400）；全量 242 → 246 |

### 历史表结构化（M3 前置）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `TurnStart.traceId` / `TurnEnd.traceId` + `latencyMs` / `OutboundEnvelope.traceId` |
| `packages/qm-agent` | 每回合生成 `turn_*` id，带进 turn/start、出站消息与 turn/end |
| `packages/qm-history` | `qm_message` 落 `direction` / `blocks_json` / `trace_id` / `platform_message_id`；`qm_turn` 在 turn/end 写状态与耗时；写入串行化 + 同一 `session_id + platform_message_id` 幂等 |
| 测试 | 4 条（结构化字段、重投幂等、qm_turn 状态/耗时、重复事件只写一行）；全量 238 → 242 |

### A2 排期器最小版：并发容量与重启恢复

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-task` | `maxConcurrent`（默认 2）限制同时执行，超出的 FIFO 排队，一个结束补下一个；启动时把 `queued` 重新排队，`running`/`needs_approval` 记 failed（resume 未实现） |
| `qingmei.prod.yml` | `maxConcurrent: 2` |
| 测试 | 3 条（容量与 FIFO、排队恢复、中断记 failed）；全量 235 → 238 |

### A5 收尾：只进摘要

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `AutonomyState.digest`（`day` + 待发条目） |
| `packages/qm-autonomy` | 同一规则被忽略 `digestAfter`（默认 6）次后不进即时消息，改入摘要队列；每天 `digestHour`（默认 20 点）后最多发一次「📥 今日摘要」；`POST /api/v1/autonomy/digest` 手动发；摘要不消耗即时预算 |
| `apps/web/public/*` | 面板显示「摘要 N 条」，有积压时「发摘要」按钮可用 |
| 测试 | 3 条（降级入队、手动发送与 400、到点自动发一次）；全量 232 → 235 |

验证：本地把 `ignoredByRule` 置为 2、`digestAfter: 2` → tick 不再发 💡，GET 显示 `digest.count=1`；
点「发摘要」→ 收到「📥 今日摘要（1 条）」，按钮变灰。

### A5 收尾：显式级别入口与锁死

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `AutonomyState.locked`（锁死标记，落库） |
| `packages/qm-autonomy` | `POST /api/v1/autonomy/trust`：设置 A0/A1/A2/A3 或 `locked`；非法级别 400；tick 改用落库的 `state.mode`（不再每轮用配置覆盖），自动升级需 `!locked` |
| `apps/web/public/*` | 主动面板加 A0/A1/A2 三个级别按钮 + 锁死开关，`aria-pressed` 反映当前状态 |
| 测试 | 2 条（接口校验、锁死后不自动升级）；全量 230 → 232 |

### A5 前半：采纳/忽略记账与忽略降频

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `AutonomyState` 加 `accepted` / `ignored` / `streak` / `pending` / `ignoredByRule` |
| `packages/qm-autonomy` | 建议发出后进入「等回应」（`acceptWindowMinutes`，默认 30）；窗口内有入站消息算采纳；过期记忽略并中断 streak；同一规则被忽略 `ignoreBeforeSlowdown`（3）次后冷却翻倍；`autoUpgrade`（默认关）连续采纳到 `upgradeAfter`（10）才升 A2 并通知；状态读改写串行化，避免 tick 与入站互相覆盖 |
| `apps/web/public/app.js` | 主动面板显示「采纳 / 忽略 / 连续」 |
| `GET /api/v1/autonomy` | 返回 `trust: { accepted, ignored, streak }` |
| 测试 | 5 条（采纳、忽略、降频、自动升级、默认不升级）；全量 225 → 230 |

### A3 收尾：过期自动盘点与结论回推

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` / `provider-task-sqlite` | `TaskRun.kind`（`task` / `inventory`，老数据读作 task） |
| `packages/host-mcp` | `qm_project_status` 数据超 2 小时且 harness 可用时，派 `kind: 'inventory'` 的只读盘点 run（沿用上一次 cwd）；harness 不可用降级成快照 |
| `packages/qm-autonomy` | 订阅 `taskFinished`：盘点 run 收尾后把结论（📋）回推到主人私聊 |
| 测试 | 3 条（过期派单、harness 不可用降级、新鲜不派单）+ 1 条回推；全量 221 → 225 |

### A3 读取面：项目审问

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` / `provider-task-sqlite` / `qm-task` | `CreateTaskInput.project`、`TaskRun.project`（老数据读作 null）；`POST /api/v1/tasks` 接受 `project` |
| `packages/host-mcp` | 新工具 `qm_project_status`：按项目汇总最近 run、进度、产物、阻塞、失败，标注数据截止；>2 小时提示「可能不是最新」，无记录时列出最近任务并问要不要盘点 |
| `apps/web/public/app.js` | 任务行显示项目名 |
| 测试 | 4 条（project 透传、项目过滤、无记录、过期/阻塞提示）；全量 217 → 221 |

> 后续：过期时自动派盘点在「A3 收尾」一节，qm_project_status 的输出会带上盘点 run 的 id。

### A2 前半：行动白名单与执行回执

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `AutonomyLevel` / `AutonomyActionSpec` / `AUTONOMY_ACTIONS`（7 个动作带风险、可逆、最低级别）；`AutonomyTrace.execution` |
| `packages/qm-autonomy` | 选中后过两级闸：白名单外拒绝、不可逆不执行、级别不够降级成建议；`notify.self` 真发消息（进 `qm_message`）、`task.retry`（A2 起）重建 run 并派发；回执写进 trace |
| `apps/web/public/app.js` | 主动面板显示回执（已执行 / 已发建议 / 跳过 / 失败 + 详情） |
| 测试 | 4 条执行语义（A1 降级、A2 重试、发送失败、A0 无回执）；全量 212 → 217 |

验证：本地 A1 + 失败任务 → `suggested` 且私聊收到「💡 …」；A2 → `executed` 且 `runId` 指向新 run。

### 自主循环（A1 骨架）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `AutonomyCandidate` / `AutonomySnapshot` / `AutonomyTrace` / `AutonomyState` + `AutonomyService`；事件 `qm/autonomy/tick` |
| `packages/qm-autonomy`（新） | 每 5 分钟 tick：快照 → 规则候选（待确认审批 95 / 60 分钟内日程 80 / 24 小时内失败任务 70）→ 过滤（静默 23–08、每日 3 条、4 小时冷却）→ 选择 → 写 `qm_autonomy_trace` / `qm_autonomy_state`；`GET /api/v1/autonomy`、`POST /api/v1/autonomy/tick`，推 SSE `autonomy-tick` |
| `apps/web/public/*` | 头部第三个开关「主动」：预算、决策记录、选中理由、被压制的候选与原因、「立即巡一次」 |
| `qingmei.yml` / `qingmei.prod.yml` | 注册 `qm-autonomy`（dailyBudget 3、静默 23–08） |
| 测试 | 9 条（规则、预算、静默、A0、冷却、HTTP、重启后状态保留）；全量 202 → 212 |

验证：本地建一个 10 分钟后的日程 → tick 选中 `schedule.upcoming` 并给出理由；
连按两次第二次显示「候选都在冷却中」；Web「主动」面板展示预算 1/3 与三条 trace。

### 产物与 token 用量

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `TaskArtifact` / `TaskUsage`；`TaskRun` 加 `artifacts` / `usage`；`TaskService.addArtifact` / `reportUsage`；`HarnessEvent` 加 `usage` |
| `packages/provider-dsh-acp` | `prompt` 返回 ACP 的 usage（实验字段），转成 `usage` 事件 |
| `packages/provider-task-sqlite` | `artifacts_json` / `usage_json`；产物追加（结束前）、用量累加（收尾后仍可补记） |
| `packages/qm-task` | 收到 `usage` 事件写回账本 |
| `packages/host-mcp` | 新工具 `qm_publish_artifact`（runId + name + url/path/summary），登记为 `write` |
| `apps/web/public/*` | 任务行显示产物（链接可点）与 token 数 |
| 测试 | 账本 2 条、MCP 1 条、ACP usage 断言；全量 192 → 195 |

### 审批桥（H3）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `ApprovalRequest` / `ApprovalStatus` / `ApprovalService`；事件 `qm/approval/requested|decided` |
| `packages/provider-approval-sqlite`（新） | `qm_approval` 队列：create/get/list/decide/wait（轮询，重启后 pending 仍在） |
| `packages/qm-approval`（新） | `GET /api/v1/approvals`、`POST /api/v1/approvals/decide`，状态推 SSE |
| `packages/host-mcp` | `guardToolCall` 的 `ask` 改为落审批并阻塞等待；批准继续，拒绝/超时抛可读原因并记 deny |
| `packages/provider-dsh-acp` | `AcpClient` 处理 `session/request_permission`（按 optionId 回 selected/cancelled）；`DshHarness` 接到审批队列，等待期间任务 run 标 `needs_approval`；没有审批服务一律取消 |
| `apps/web/public/*` | 任务面板顶部「待确认」区：批准/拒绝，订阅 `approval-*` 刷新 |
| 测试 | 审批队列 4 条、HTTP 2 条、ACP 权限 5 条、guard 4 条；全量 174 → 191 |

验证：本地 CDP 点「批准」→ 待确认区消失；生产临时把 `schedule_list` 标成 dangerous →
调用被拦、审批可查、批准后 1.2s 内继续，审计记 `allow` + approvalId。

### 任务派发工具与 Web 任务面板

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `TaskRunnerService`：`dispatch(run)`，把「派发」从「记账」里拆出来 |
| `packages/qm-task` | 提供 `taskRunner`；harness 改成每次派发现取（不再在建插件时捕获，避开加载顺序）；POST 路由复用 runner |
| `packages/host-mcp` | 新工具 `qm_dispatch_task`（对话车道可以直接把活派给 DSH），`inject` 加 `taskRunner` |
| `apps/web/public/*` | 顶栏「任务」面板：状态/进度/结论，订阅 `task-started/progress/finished` 自动刷新，与日程面板互斥 |
| 测试 | `qm_dispatch_task`、runner、面板契约；全量 172 → 174 |

### 任务账本与派发（H1/H2）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `TaskStatus` / `TaskProgress` / `TaskRun` / `CreateTaskInput` / `TaskService`；事件 `qm/task/run-started`、`progress`、`finished` |
| `packages/provider-task-sqlite`（新） | 账本 `qm_task_run`：create/get/list/start/setStatus/reportProgress/finish，状态机不允许跳步，已结束的 run 幂等 |
| `packages/qm-task`（新） | 派发：`POST /api/v1/tasks` 建 run → mkdir 工作目录 → `harness.run`（prompt 里带 runId 与上报方式）→ 正常结束收尾；超时 abort 记 cancelled；没有 harness 时 503。`GET /api/v1/tasks[?id=]` |
| `packages/host-mcp` | 新增任务数据面工具 `qm_report_progress` / `qm_finish_task`（后者可顺带写结构化记忆）；`inject` 加 `task` |
| `packages/provider-permission-static` | 两个新工具的 risk = `write`（漏登记会被默认拒绝） |
| 配置 | `provider-task-sqlite` + `qm-task` 进开发/生产清单；`apps/server` 依赖 |
| 测试 | 账本 8 条、派发 6 条、MCP 工具 3 条；全量 154 → 172 |

验证（2026-11-02，生产）：`POST /api/v1/tasks` → 约 1.5s 后 run `done`，
`progress={phase:"连路验证"}`、`result="H2 通"`，`qm_audit` 里能看到子 agent 的两次工具调用。

### 工具准入与审计

| 文件 | 改了什么 |
| --- | --- |
| `packages/provider-permission-static`（新） | 静态策略 + 工具风险分级；群聊默认拒绝；未登记工具默认拒绝 |
| `packages/provider-audit-sqlite`（新） | `qm_audit`，只追加 |
| `packages/host-mcp` | `guardToolCall`：permission → 审计 → 拒绝抛可读原因 |

### 日程编辑

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | 新增 `SchedulePatch`；`ScheduleService.update(id, patch)` |
| `packages/provider-schedule-sqlite` | `update` 实现：只改文本不动 nextAt；给规则就整体替换（清掉旧 cron/timezone/every_ms）并从「现在」重排；已结束的行拒绝修改 |
| `packages/host-gateway` | `PATCH /api/v1/schedules/<id>`；空 patch / 非对象 body / 非法 cron 返回 400（`InvalidScheduleError` → `HttpError(400)`） |
| `packages/host-mcp` | 工具 `schedule_update`（id + text / cron / timezone / at / seconds / missedPolicy） |
| `apps/web/public/*` | 行内编辑表单（内容 + 规则）；「编辑 / 暂停·继续 / 取消」三个动作 |
| 测试 | provider 3 条（文本不动 nextAt、换规则重排、非法/未知/已结束）、gateway 5 条、MCP 2 条 |

### 日程暂停 / 继续

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `Scheduled` 加 `pausedAt`；`ScheduleService` 加抽象 `pause` / `resume` |
| `packages/provider-schedule-sqlite` | 行加 `paused_at`；`pause` 幂等、`resume` 按规则重排（cron 用 `nextCronTime`，一次性保持原时间，已触发的不可复活）；tick 跳过暂停行 |
| `packages/host-gateway` | `POST /api/v1/schedules/<id>/pause`、`/resume`（返回 `{ ok, state }`） |
| `packages/host-mcp` | 两个新工具 `schedule_pause` / `schedule_resume`；`schedule_list` 标出「（已暂停）」 |
| `apps/web/public/*` | 每行「暂停/继续」+「取消」；暂停行虚线边框 + 黄色「已暂停」 |
| 测试 | provider 4 条（暂停不触发、幂等、恢复重排、已结束不复活）、gateway 3 条、MCP 2 条 |

### MCP 工具注册表（技术债 2）

| 文件 | 改了什么 |
| --- | --- |
| `packages/host-mcp/src/index.ts` | `createTools({ memory, schedule })` 返回 `HostTool[]`（name/description/inputSchema/call）；`tools/list` 与 `tools/call` 读同一份；未知工具按查表报错 |
| `packages/host-mcp/test/mcp.test.ts` | 用假服务直接测每个工具的入参、话术与副作用（不再只测 `scheduleInputFrom`） |

新增工具的做法：在 `createTools` 里加一项，不再需要同步三处。工具定义是纯数据，
handler 只通过 `deps` 访问服务，所以测试可以 `createTools({ memory: fake, schedule: fake })`。

### 落库统一（技术债 1）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/index.ts` | `EVENTS` 加 `turnStart` / `outbound`；新增 `TurnStart`、`OutboundRecord` |
| `packages/service-channel` | `send` 成功后 `await events.parallel(qm/outbound, …)`，订阅者写完才返回；订阅者抛错不影响发送结果 |
| `packages/qm-history`（新） | `qm_message` 唯一写方：`turn/start` 写用户消息、`outbound` 写助手消息；时间戳在收到事件时定序 |
| `packages/qm-agent` | 删掉落库与事务，只读历史；`loadHistory` 按当前消息的 `platform_message_id` 截断到「本轮之前」 |
| `packages/qm-reminder` | 只投递，不再依赖 store |
| 配置 | `qingmei.yml` / `qingmei.prod.yml` / `apps/server/package.json` 加 `@qingmei/qm-history` |
| 测试 | `qm-history`(5)、`qm-reminder`(4)、`service-channel`(6)；`qm-agent` 改用真实 ChannelHub + 假适配器 |

语义变化（有意为之）：

- 助手消息只在**投递成功**后落库。发送失败时历史里只剩用户消息，不再记录用户没看到的回复。
- 落库失败不再算回合失败（`turn/end.ok` 仍为 true），由 `service-channel` 记 warn 日志。
- 用户消息在**回合真正开始**（排队轮到它）时落库，而不是到达时——否则连发两条消息时，
  第二条的用户行会排到第一条的回复前面。

### 之前两轮（M2-cron / Web 日程页）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/cron.ts` | `parseCron` / `nextCronTime` / `systemTimeZone` |
| `packages/provider-schedule-sqlite` | 三类规则统一推进；cron 到点重排；`skip` 策略；`defaultTimezone` |
| `packages/host-mcp` | `schedule_create` 加 `cron` / `timezone` / `missedPolicy`；`schedule_list` 带 id |
| `packages/host-gateway` | `GET /api/v1/schedules`、`DELETE /api/v1/schedules/<id>` |
| `apps/web/public/*` | 顶栏「日程」面板：列出/刷新/取消，跨时区显示 |

`Scheduled.firedAt` 的语义：一次性行到点后写入（退休标志）；周期行恒为 `null`，
否则 `schedule_list` 与日程面板按 `firedAt === null` 过滤时会把周期提醒过滤掉。

## 6. 环境里踩过的坑（别再踩）

1. `ctx.plugin()` 是异步的：必须 `await`，否则服务是 `undefined`
2. `node --test <目录>` 不展开目录；仓库根直接 `node --test`
3. **`test/` 目录下任何 `.mjs` 都会被当成测试执行**，辅助脚本放 `fixtures/`
4. DSH 的 `settings.yaml` 只导入一次，随后改名 `settings.yaml.imported`，改完要再启动一次
5. ACP 的 `cwd` 必须是绝对路径
6. `service-*` 门面包也必须有 `apply`，否则 cordis 拒收、服务重启循环
7. GitHub 直连会被重置，推送要加 `-c http.proxy=http://127.0.0.1:7897`
8. **注释里不能直接写 cron 的 `*/n`**：`*/` 会提前闭合块注释，TS 报
   `ERR_INVALID_TYPESCRIPT_SYNTAX`。写成「区间接步长」绕开
9. **store 是无 schema 的 JSON**：新增字段后，老记录里是 `undefined` 而不是 `null`，
   读的时候一律 `row.x ?? 默认值`
10. 跨包测试要真的用上别的 provider，得先把它写进 `devDependencies` 再
    `pnpm install --offline` —— workspace 链接来自 lockfile，手建 junction 不算数
11. **本地组合根漏了服务会 15 秒后退出**：`host-mcp` 的 `inject` 含 `memory`，
    只配 `host-mcp` 不配 `service-memory`/`provider-memory-sqlite` 会一直 PENDING，
    然后 `[qm] 启动失败：插件未在 15000ms 内就绪`
12. **前端验证**：浏览器扩展经常没连（`browser.py tabs` 返回空），可以直接用
    `chrome.exe --headless=new --remote-debugging-port=9333` + CDP（`/json/new` 要 PUT，
    然后 `Runtime.evaluate` 点按钮、`Page.captureScreenshot` 截图）来验证；
    本机 Chrome 在 `C:\Program Files\Google\Chrome\Application\chrome.exe`
13. **改语义前先看历史数据**：上一版的 `every_ms` 行发过一次就会写 `fired_at`；
    把周期行改成「不写 `fired_at`」之后，这些老行被当成活跃周期行复活，
    生产上每 5 秒发一条提醒（106 条垃圾消息）。现在 `advance()` 第一条就是
    「`fired_at` 有值就退休」——新周期行从不写它，所以不会误伤重排。
    再遇到类似问题：先 `DELETE /api/v1/schedules/<id>` 止血，再改代码部署，
    最后停服务清 `qm_message` 里的重复消息。
14. **部署验收要看数据，不只看 healthz**：这次 healthz 200、日志干净，
    但库里在每秒滚动。验收至少加一条：`GET /api/v1/schedules` 与
    `qm_message` 计数在 10 秒内不变。
15. **事件顺序 ≠ 到达顺序**：入站就落库会让「连发两条」的第二条排在第一条的回复前面。
    用户消息要等回合真正开始（`qm/turn/start`）再写；读历史时再按 `platform_message_id`
    截断到本轮之前，才能兼容「本轮消息已经在库里」的情况。
16. **`ctx.events.parallel()` 是唯一能等监听器跑完的派发方式**：`emit` 不等 promise，
    想让「发送成功 → 落库完成」有先后保证，必须 `await parallel`。
17. **前端验证脚本要自己重置状态**：CDP 脚本跑第二遍时，上一遍的暂停/编辑都还在库里，
    断言会莫名其妙地失败。要么每轮重建临时库，要么开头先 `DELETE` 清干净。
18. **`qm doctor` 会占用清单里的端口**：生产上跑 doctor 要先停服（host-mcp 的 7420 是写死的），
    跑完再起；否则插件会因 EADDRINUSE 报 FAILED。
19. **ACP 的文件/命令工具需要两端都打开**：客户端要在 `initialize` 里声明
    `fs`/`terminal` 能力并实现 `fs/*`、`terminal/*`；DSH profile（`~/.dsh/profiles/acp/cordis.patch.yml`）
    里不能 `disabled` 掉 `tool-fs` / `tool-bash`。任一处没配好，模型会一口咬定「我没有文件权限」，
    而且这个说法听起来像权限问题，实际是能力没声明。仓库里有现成的 patch：`deploy/`。
20. **关键词召回必须切到单字**：只切二元词时，「我养什么」切出「我养/养什/什么」，
    一个都命中不了事实「主人养狗」，M1 验收里的自然问法会直接失败。
21. **同一毫秒创建的行排序不稳定**：`qm_task_run` / `qm_approval` 的列表按时间倒序，
    连续创建要单调递增（`max(now, last+1)`），否则测试与 UI 顺序会随机。
22. **`store.find` 不支持 `orderBy`**：账本类列表（autonomy trace）要取回来自己排序再截断，
    否则 `limit` 先于排序生效，顺序就是插入顺序。
23. **主动消息也要走 `channel.send`**：这样 qm-history 才能落库、Web 与渠道才一致；
    绕过它直接写 `qm_message` 会让建议在会话历史里凭空出现或消失。
24. **用 PowerShell 改含模板字符串的代码会吃掉变量插值**：反引号在 double-quoted 字符串里是转义符，
    替换后变量变成空串（盘点 prompt 的项目名、回执文案都踩过）。这类改动优先用编辑工具，别用 `-replace`。

## 7. 2026-10-30 文档对齐（已做，别重复做）

审计「实现是否偏离方案」后，先改文档而不是改架构，因为偏离大多来自文档没跟上 ADR-013。

| 文档 | 改了什么 |
| --- | --- |
| `docs/00` §8 | 实施状态：M0 完成、M1 只有事实子集、M2 日程侧完成、审批/审计未开始；测试数 136 |
| `docs/01` §3 / §5 / §11 | 编排层改成「上下文 + 调 harness」；记录「core 是契约真源、service-* 是门面」的当前妥协；补实际包清单（`host-mcp` = 目标形态里的 `harness-mcp`） |
| `docs/02` schedule | 契约改成实现的形状：`ScheduleInput` / `SchedulePatch` / `Scheduled(pausedAt, firedAt)` / `create|list|cancel|pause|resume|update`，并写明 cron 语义与 `InvalidScheduleError → 400` |
| `docs/02` memory | 标注当前只做 fact 子集、`qm-agent` 把 memory 当可选的偏离 |
| `docs/02` 事件表 | `qm/schedule/due` 的消费者改成 `qm-reminder` |
| `docs/02` 服务清单 | 标注 11 个服务已实现（含 `task` / `permission` / `audit`），其余未实现 |
| `docs/02` task | 新增 `task` 契约（`TaskRun` / 状态机 / `TaskService`），标注当前实现与缺口（resume / 预算 / 产物） |
| `docs/02` permission / audit | 标注实现口径：静态策略 + 工具风险分级、群聊默认拒绝、`ask` 先拒；审计落 `qm_audit`、只追加、记工具调用 |
| `docs/03` §8 | 标注当前 HTTP 面只实现了 messages/events/schedules/healthz，会话资源与幂等键未做 |
| `docs/05` M2 | 按 ADR-013 重写交付物与验收：工具面 = MCP 注册表 + 白名单/审批，删除「自研工具循环 6 步/90s」这类已作废的验收；状态更新为「静态准入 + 审计已完成，渠道确认未做」 |
| `docs/07` §4 | 标注目标工具集（`qm_*`）未实现，当前只有对话车道的 `memory_*` / `schedule_*` |
| `README-P1.md` | 标明它是 M0 的历史验收记录，当前状态看 NEXT |

还**没**对齐（属于代码要改，不是文档要改）：渠道确认链路（`ask` 目前等于拒绝）、
`qm_turn` 账本、`gateway.route` 无生产使用者、MCP 命名统一、memory 必需化、`cron.ts` 拆分。
这些都在第 2 节里排了序。
