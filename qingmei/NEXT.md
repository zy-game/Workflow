### 记忆图谱 3D + 铺满（2026-11-13）

- 记忆页画布改为 3D 力导向：节点在三维空间受力，透视投影到 canvas，自动缓慢旋转；
- 拖动旋转、滚轮缩放、「复位」恢复视角；点节点聚焦并加载它的事实；
- 画布铺满内容区（`max(460px, calc(100vh - 250px))`），详情浮层在右上角，可隐藏；移动端浮层移到底部；
- 不引入 three.js/新依赖，保持纯 canvas + 手写投影。

### 任务模型收口：日程/主动/审计/复盘并入（2026-11-13）

- 群画像兜底：群里不再走确定性的项目派发（避免命令回复绕过画像直接发群）；命中禁提词的回复转 `group.send` 审批，批准后才发；未命中才正常发群（测试覆盖）；

- 日程 = 带 trigger 的任务：创建日程时同步创建 `scheduled reminder` 任务，到点由调度器 `enqueue`，旧日程启动时自动补建任务；验证：POST /schedules 后任务列表出现 `scheduled reminder schedule at 日程任务验证`；
- 主动建议 = `proposed suggestion` 任务：autonomy 发出 `notify.self` 时落一条 proposed 任务，A1 仍不建可执行任务（测试已调整）；
- 失败任务挂故障：`qm_incident.task_id` 记录失败任务 id，故障与任务共用账本；
- 复盘 = `kind=review` 任务：生成月报时落一条 done 任务，结果为报告摘要；验证：任务列表出现 `done review review 复盘 2026-11`；
- 任务事件流：`GET /api/v1/tasks/events?id=` 可查 created/updated 等事件（生产已验证）；
- 工作台任务页加状态/来源/触发筛选；导航仍是 对话/工作台/画像/记忆/用量/设置。

### 统一任务模型 / 工作台 / 图谱 / 画像（2026-11-13）

- Task 模型扩展：kind（task/suggestion/review/inventory）、status（新增 proposed/scheduled）、origin、trigger、schedule、approvalId、parentId、depth；`qm_task_event` 记录创建与状态变更；新增 `GET /api/v1/tasks/events`；
- Web 导航收敛为 对话 / 工作台 / 画像 / 记忆 / 用量 / 设置；工作台把任务、定时、建议、记录、失败、复盘收进一个页面（旧路由重定向）；
- 记忆图谱：`GET /api/v1/memory/graph`（全局或 focus+depth），前端力导向画布，点节点看事实，保留列表切换；图谱会过滤路径/引号等噪声节点；
- 画像：新插件 `qm-portrait`（self/person/group），self 默认从 persona 迁移；qm-agent 注入 self 人格、主人画像特质、群规则；群里命中禁提词不再直接发，转 `group.send` 审批，批准后才发；
- 生产验证：`/api/v1/portraits` 返回默认 self；`/api/v1/memory/graph` 返回节点/边/事实；gate 460 绿。
- 待续：日程/主动/审计/故障/复盘的后端写入仍走旧插件，下一步把它们写进任务账本与 task_event。

### 单脑 + 意图行动（2026-11-13）

- **`qm-planner` 插件已删除**：规划并入 `qm-agent`，任务结束后用同一个 `s_owner` 会话做一次内部思考（每天最多 3 次、间隔 5 分钟、内部自建任务不递归），人格自己决定要不要下一步；
- 规则只保留限额与去重，不再有独立的 planner 提示词/JSON 协议；
- 聊天回合加入行动协议：模型可在末尾输出 `<qm-action>` 块（不展示给用户），支持
  - `task.create`：明确要求（「审查一下三国项目的进度」）直接建任务，工作区唯一命中时派到对应设备；
  - `approval.request`：模糊愿望（「想看演唱会又想看电影」）先发审批，问"要不要我帮你规划…"；
- 明确动作（审查/检查/排查/盘点）命中项目工作区时直接派任务，不再多问一句；纯问句仍先确认；
- 审批通过后自动建「规划」任务，完成后把结论回投 owner 会话；
- 流式过滤：`<qm-action>` 即使被拆到多个 chunk 也不会漏给用户；DSH 与 LLM 两条路径都过滤；
- 生产实测：发「明天想去看演唱会，但又想看电影」→ 回复结合仲裁委/法院日程给出取舍，并生成 `qm.plan` 审批；同意后自动建「规划：…」任务。

### 记忆细节保留策略（2026-11-13）

- 逐轮会话 episode 上限 20 → **100**；salience 0.45 → **0.85**（≥0.8 不参与退化，原文长期可召回）；
- 退化阈值 7/28/90 天 → **30/90/365 天**（日/周/月摘要），决定/承诺类与高显著原文仍跳过；
- 生产验证：提交 25 轮会话，`qm_episode` 落下 25 条逐轮原文，salience 全为 0.85；
- 文档 `docs/04` 的生命周期与过期规则同步更新；测试覆盖「30 天内不压缩」「高显著永不压缩」。

### 桌宠瘦身：移除 worker，会话细节直报（2026-11-13）

- 桌宠只保留形象/聊天入口/控制/提示；聊天一律 `POST /api/v1/messages`，不再先试本地 `127.0.0.1:7431`；
- 删除 worker 运行时、IPC、设置里的「写配置/启动 Worker」、打包资源与 `scripts/harness-worker.mjs`；
- `dsh-hook` 改为直接 `POST /api/v1/devices/ingest`（api/token/deviceId），逐轮原文 + 工具事件，不再经 worker 转发；
- `qm-distill` 收到会话后按「user 轮次 + 对应 assistant 回复」逐条落 episode（最多 20 条），摘要只在无轮次时兜底——细节不再被一句摘要覆盖；
- 生产验证：向 `/devices/ingest` 提交两轮会话，`qm_episode` 里出现逐轮原文「主人：我周三要去上海出差，住静安 / 青梅：…」；
- 桌面 0.1.9 已发布（无 worker）；gate 459 绿。

### 修复：派发任务跑错工作区（2026-11-13）

- `dsh-companion` 之前只读 `task.cwd`（服务端给的是 `task.target.cwd`），找不到时回退到 `workspacePath`（E:\Workflow），导致三国任务在 Workflow 里开会话；
- 现在优先用 `target.cwd`，其次 `task.cwd`，再按 workspaceId 找；**两者都没有且 workspaceId 找不到时直接失败**，不再在错误目录执行；
- 新增两条回归测试（cwd 优先、错误配置拒绝执行），gate 461 全绿；
- 桌面 0.1.8 已构建/发布，并把修好的插件复制进本机 DSH 的 desktop/web profile；重启 DSH 后生效。

### P2：自规划循环 + 目标账本（2026-11-12）

- 新插件 `qm-planner`：监听 `taskFinished`，用独立 `planner:owner` 会话让模型输出 JSON（后续任务 / 提醒 / 研究申请 / 跳过）；
- 目标账本 `qm_goal`：`GET/POST /api/v1/goals`、`POST /api/v1/goals/update`；
- 约束：自建任务每天最多 3 个、深度最多 1 层、24h 同标题去重、30 分钟冷却；到顶后只允许提醒/申请；
- 研究申请走审批：`qm_planner_request` 记录 approval，批准后自动建「资料研究」任务；
- `GET /api/v1/planner/stats`：runs / tasksCreated / tasksDone / reminders / skips / research 与接受率；
- 生产实测：`POST /api/v1/planner/run` 读目标后产出「跑通自规划循环（端到端）」任务并排入执行；
- 任务完成回投改为落库 `qm_pending_result`，服务重启后仍能通知；
- 真实问法评估集：`scripts/export-real-eval.mjs` 从生产导出 + 人工标注 8 题，`scripts/eval-real-questions.mjs` 7/8（embedding off），放宽“项目约定也算相关”后 8/8；
- P3：桌面 0.1.7 发布（设备统一 + 自动启 worker + 项目派任务）；CI 改为 `pnpm gate --with-smoke`，本地 smoke 通过。

### P0/P1 第一轮：设备/工作区闭环 + 向量元数据（2026-11-12）

- 桌宠与 worker 共用 deviceId（worker.json 稳定 id，renderer 通过 IPC 读取）；worker 随桌宠自动启动；
- worker 的 workspaces 从 DSH 工作区状态自动发现（`~/.dsh/storages/workspace.json`），无需手工打标签；
- `qm-device` 新增只读 `devices` 服务；聊天按“用户简称 ↔ 工作区全名”双向匹配（「三国」↔「重生三国之修仙传」），歧义/未命中不猜；
- 唯一命中先问「要派任务吗？回复派」，确认后创建 device+workspace 任务；完成后把结论回投原会话；
- 上下文块补「进行中/排队任务」「今日日程」；
- 向量加 `vector_model`（模型变更自动失效）、查询 embedding 缓存（30 分钟/200 条）、episode 也做向量化、关系图实体别名合并；
- 生产实测：发「三国项目进度怎么样，有 bug 吗」→ 命中 `E:\重生三国之修仙传` 并询问；回「派」→ 任务创建并**在设备上 running**。

### 用量可视化：余额 / 花费 / embedding（2026-11-12）

- `provider-embedding-http` 每次调用记录 `usage.total_tokens` 到 `qm_embedding_usage`（按天）；
- `qm-cost` 暴露 `cost` 服务与 `GET /api/v1/cost`：余额、今日花费（余额差）、embedding 今日/本月；
- 聊天命令「今日用量 / 余额 / 成本 / 花费」直连服务，不调模型；
- Web 新增「用量」面板（菜单 11 项）；Windows 托盘与桌宠右键加「今日用量」弹窗；
- 客户端：桌面 0.1.6（Inno）与 Android 0.1.13（versionCode 14，debug 证书与 0.1.12 一致，可直接升级）已发布；
- 实测：普通消息后 `embedding 8 tokens / 1 次`；命令返回余额 78.63 CNY + 该数字。

### 语义召回上线：智谱 embedding-3（2026-11-12）

- 装配 `provider-embedding-http` → 智谱 `https://open.bigmodel.cn/api/paas/v4/embeddings`，
  模型 `embedding-3`（2048 维），key 放 `/etc/qingmei/env` 的 `QM_EMBEDDING_KEY`；
- 事实入库时只嵌 `object`（整句里的「主人/喜欢」会稀释语义，实测区分度更差）；
- 生产回填 170 条事实：`embedded=170 skipped=0 failed=0`；
- 评估（同一套 40 题，生产环境跑 `--embedding`）：

```text
overlap 95% | near 90% | zero 20% → 70%
```

- 代价：每条消息多一次 embedding 调用（约 200–500ms）；token 成本可忽略（按我们的量一年几毛钱）；
- 剩余 3/10 是模型区分度问题（「黑色苦饮料」对「手冲咖啡」0.55、对「龙井茶」0.59），
  换更强模型或 query 改写才可能继续提升。

### 意图与成本 C：自省、task.create、余额、watchdog（2026-11-12）

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 每日自省 | `qm-autonomy` 在 9 点后生成一条「想法」候选：今天失败的任务 → 补救建议（`task.create`，value 72）、临近日程、可沉淀技能、久未使用；`reflection` 可关，冷却 20 小时 | 3 条单测（A1 只发建议 / A2 建任务 / 静默不打扰）；生产 tick 真的选出 reflection 并发给主人 |
| A2 `task.create` | 动作白名单新增，A2 才执行；A1 降级为建议；同一天同名任务不重复建 | 单测断言 `补救：…` 任务被创建且带失败原因 |
| 成本观测 | 新插件 `qm-cost`：`POST /api/v1/cost/refresh` / `GET /api/v1/cost`，每日余额快照 + 与昨日差额 | 生产 refresh 返回 `total=78.63 CNY`，GET 正常；单测覆盖快照与无 key 503 |
| 看门狗 | `scripts/watchdog.mjs --restart`：5 分钟检查 healthz，失败记录 + 重启 + 可选 webhook | 坏 URL 用例：`ok:false`、退出 1；正常：`ok:true`、退出 0；cron 已装 |
| 备份异地 | `backup.mjs --remote`：rsync 同步，失败明确报错；未配置打印警告 | 本地跑 `--out tmp-bk` 验证快照与警告文案 |

### 记忆质量 A：真实评估 + bigram + 可选向量（2026-11-12）

- 新评估集 `memory-real-eval.json`：20 条生产事实原句、10 条换词重述、10 条零字面重叠；
  脚本 `eval-memory-real.mjs` 已进 gate。
- 基线：overlap 95%、near 80%、zero 20%。
- 改进：召回打分加中文 bigram（near 80%→90%）；新增可选 `provider-embedding-http`，
  装了才存向量、算余弦（单测用假向量验证零重叠链路），默认不装。
- 结论：zero 组仍是 20%，没有真实向量服务就解决不了；缺口已量化。

### 自动化：去掉每日预算（2026-11-12）

按主人要求取消「每天最多 N 条」：`dailyBudget: 0` 表示不限量（`qm-autonomy` 里 `dailyBudget > 0` 才做预算拦截）。
生产已改为 0，tick 立即验证：A1 下把「2 个任务失败」作为建议发出（`execution.status=suggested`）。
仍然保留的节流：静默时段 23–8、单规则冷却 4 小时（被忽略翻倍）、opener 自己的每日上限。

### 自我进化收尾：复盘提案效果跟踪 + 回滚 + 重复率基线（2026-11-12）

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 应用留痕 | apply 记录 `applied_at`、`persona_history_id` | `review.test.ts`：应用后字段存在 |
| 效果跟踪 | 下期复盘生成时对比失败率，写 `effect_json`（improved/flat/worse/unknown） | 单测：11 月失败率 0.5 → 12 月 0 → `improved` |
| 回滚 | `POST /review/proposals/rollback` → `persona.rollback(history_id)` | 单测：回滚后人格 hash 恢复；生产路由 200/400 正常 |
| 验收基线 | `scripts/error-recurrence.mjs`：按 error_code 统计 7 天内重复率 | 生产跑过：`failedTurns=0`，基线为空（诚实记录） |

### 自我进化 P4：教训/决策 + 技能草稿（2026-11-12）

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 教训/决策抽取 | `qm-distill/learn.ts`：以后/下次不要、踩坑、决定/采用/选型；问句与假设跳过 | `learn.test.ts` 4 条 + 凝练端到端：候选 `kind=lesson`，采纳写入 `lesson` |
| 同一个复核队列 | 候选表加 `kind`/`text`；`/memory/candidates/decide` 按 kind 写记忆 | `distill.test.ts` 新增用例 |
| 技能草稿 | 新插件 `qm-evolve`：任务 `done` 且结果 ≥20 字 → `qm_skill_draft`（步骤/结果/产物），上限 20 | `evolve.test.ts` 3 条；生产 E2E：任务完成后草稿出现，已拒绝清理 |
| 采纳/回滚 | `/api/v1/skills/drafts/install|reject`；技能安装走 `qm-skill`，回滚走 `/skills/rollback` | 单测断言采纳才 install |
| 装配 | dev/prod 各 23 项；`apps/server` 依赖补齐；架构 owner 加 `qm_skill_draft` | gate 432 全绿 |

### 记忆 P2：关系图（2026-11-12）

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 实体/边 | `qm_entity`（人/项目/地点/组织/主题）+ `qm_edge`（predicate、kind、weight、first/last_seen、valid_to） | `neuron.test.ts`：事实落边、两跳可达、时间窗过滤、召回带【相关】 |
| 增量构建 | 事实入库建 `fact` 边；episode 里已知实体两两建 `cooccur` 边 | 生产 ingest 后自动落图 |
| 实体过滤 | object >16 字、带标点/括号、否定/「情况/的事」结尾不建实体 | 回填后从 297/170 降到 **164 实体 / 34 边** |
| 查询 | `GET /api/v1/memory/graph?name=主人&depth=2`，返回 entities/edges/text | 生产 200，返回主人 → 杭州出差/狗等 |
| 召回注入 | top 3 事实各查 1 跳邻居，追加【相关】块（≤6 行） | 单测断言 recalled.text 含「【相关】」 |

### 记忆 P1：分层退化 + 时间评估（2026-11-12）

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 分层退化 | `memory.consolidateEpisodes()`：7 天→日摘要、28 天→周摘要、90 天→月摘要；`salience ≥ 0.8` 或含决定/承诺/教训的原文不压 | `neuron.test.ts`：三类摘要各生成、决定类原文 `valid_to` 仍为 null、重复跑不重复建 |
| 软删与追溯 | 原文只置 `valid_to`；摘要 `origin_kind=summary`、`provenance` 存原始 id（≤20） | 同上断言 `provenance` 非空 |
| 每日任务 | 服务器 `/etc/cron.d/qingmei-memory`，04:00 跑 `scripts/memory-decay.mjs`，日志 `/var/log/qingmei/memory.log` | 手工跑过：`scanned 5 / groups 0 / merged 0`（当前没有 7 天前的 episode，符合预期） |
| 时间评估 | `scripts/eval-memory-time.mjs` + 30 条时间锚定问题，进 gate | recall@5 100%（问题保留对象关键词，只验证时间窗） |

### 记忆 P0 + 自动化开启（2026-11-12）

| 项 | 改动 | 证据 |
| --- | --- | --- |
| 时间维度 | `RecallQuery` 加 `since/until`；神经元召回按 `created_at`（尊重 `occurredAt`）过滤，并加近期加权 `1 + 0.25·e^(−age/30天)` | `neuron.test.ts` 时间窗用例：60 天前的事实不出现在「最近 30 天」里 |
| 时间解析 | `parseTimeRange()`：今天/昨天/前天/最近 N 天/本周/上周/本月/上月/去年/今年，解析不了返回 null | `activity.test.ts` 5 条 |
| 最近 7 天 | 聊天上下文注入【最近 7 天】：任务完成/失败 + 最近 5 条 + 未来 3 条日程，确定性生成，只对 owner | 同上 |
| 手动会话进记忆 | `devices/ingest` → `qm/session/ingested` → `qm-distill` 抽候选 **并落一条 episode**（origin=`doc:<device>:<session>`） | 生产实测：episode 从 4 变 5，最新一条 `text=smoke 会话摘要：讨论了记忆分层` |
| 自动化开启 | 生产 `modules: true`、`dailyBudget: 1`、切 A1 | `/api/v1/incidents` 与 `/api/v1/conversations/suggestions` 均 200；预算 `used=2/limit=1` 会拦截发送 |

回滚：`POST /api/v1/autonomy/trust {"level":"A0"}` 一条接口切回观察模式。

### 技术债 7：手动会话也能进记忆了（2026-11-12）

之前 `dsh-hook / worker ingest` 只把摘要写进 `qm_session_digest`，facts 恒空——你在 DSH GUI 里干的活，
青梅只知道「有过一段会话」。现在补上链路：

```text
DSH GUI / 手动 ACP 会话收尾
  → POST /api/v1/devices/ingest
  → 落 qm_session_digest + emit qm/session/ingested
  → qm-distill 取 user 轮次（最近 50 条）走规则抽取
  → 待确认队列（来源 session_id=device id，batch_id=ingest:<device>:<session>）
```

- 与对话回合共用同一套规则、查重、200 条待确认上限和审核接口；**手动会话默认不调模型**。
- 生产实测：ingest 后候选落库（`rule=allergy`，`session_id=devit`），验证完已拒绝清理，队列为空。
- 测试：`qm-distill` 新增 2 条（收尾抽取、重复上报去重），全套 415 条通过。

### 技术债 2/3/6：日程 tick 窗口、会话历史索引、每日备份（2026-11-12）

| 项 | 改动 | 证据 |
| --- | --- | --- |
| ② 日程 tick | 改成 `ORDER BY next_at LIMIT 500` + `next_at` 索引；超过 500 条同时到期分多次 tick 并打 warn | bench：2 万行 tick 窗口 0.56 ms（旧全表 12.2 ms / 1 万行） |
| ③ 会话历史 | `recent()` 改为按 `(session_id, created_at)` 索引各取最近 N 条再合并，不再全表扫 | bench：2 万行取最近 20 条 0.17 ms（旧 29 ms） |
| ⑥ 备份自动化 | 服务器 `/etc/cron.d/qingmei-backup` 每天 03:00 快照，保留 7 份，日志 `/var/log/qingmei/backup.log`；手动跑过一次 | `qm-20261112-144204.db`（142 MB），`integrity_check = ok` |

`scripts/bench.mjs` 增加了窗口查询两项，数字写进 [docs/32](docs/32-性能基线.md)。

### 技术债 1：qm-review 服务化 + 一次 17 分钟停机（2026-11-12）

**服务化**：

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | 新增 `HistoryOverview` 与 `HistoryService.overview({since,until,sampleLimit})`（回合统计 + 失败原因 Top + 消息抽样），默认返回空 |
| `packages/qm-history` | 实现 `overview()`（读自己的 `qm_turn/qm_message`），并加测试 |
| `packages/qm-autonomy` | 新增 `incidentStats` 服务（读自己拥有的 `qm_incident`），给复盘提供 `{total,open,fused}` |
| `packages/qm-review` | 从 `experimental/` 搬到 `packages/`；不再直接读别人的表，改用 `history.overview()` / `task.list()` / `incidentStats.stats()`；测试用 fake 服务 |
| `scripts/check-architecture.mjs` | owner 表补 `qm_turn/qm_incident/qm_memory_candidate/qm_session_digest`，去掉已删包 |

结果：架构门禁 **0 处跨插件 collection**，`experimental/` 目录彻底删除。

**停机与修复（14:19–14:36，约 17 分钟）**：

- 直接原因：包从 `experimental/` 搬到 `packages/` 后没重跑 `pnpm install`，`@qingmei/qm-review` 的 workspace 链接还是旧路径；
  部署又沿用了「默认不装依赖」，于是新 release 起不来，回滚到旧 release 也共用同一份坏链接。
- 修的过程还踩到：supervisor 回滚会把**旧根清单**合并回来，旧 lockfile 与新包目录不匹配 → `--frozen-lockfile` 失败；
  以及在服务器上 `pnpm install` 会因 root 属主目录报 EACCES。
- 已加的三道闸：
  1. `scripts/check-links.mjs`：按清单逐项 `require.resolve`，断了直接报；已进 `pnpm gate` 与部署后校验；
  2. 部署默认执行 `pnpm install`（`--skip-install` 才跳过），并在 supervisor 解包前先把 `package.json/pnpm-lock.yaml/各包 package.json` 同步到根目录；
  3. `release-desktop` 缺失时不再让整个部署失败。

### P2 收尾：依赖、文档、性能基线、升级清单、仓库清理（2026-11-12）

| 项 | 动作 | 证据 |
| --- | --- | --- |
| ⑪ 删 electron-updater | 从 `apps/desktop/package.json` 移除，只有 `updater.cjs` 注释还提到它作为背景 | `pnpm install` 通过；desktop 依赖变空 |
| ⑫ 修文档漂移 | `docs/20` 的数据所有权与目标插件图改成现状；`docs/24`、`docs/27` 顶部加归档说明（FTS/向量路线未采用） | 文档里不再出现 `service-store`/`provider-approval-sqlite` 这类已删包 |
| ⑬ 性能基线 | 新增 `scripts/bench.mjs`（`pnpm bench`）+ `docs/32` | 2 万行：下推查询 7.5 ms、全表 30 ms；日程 tick 1 万行 13 ms；2000 条事实召回 25 ms |
| ⑭ 上游升级清单 | 新增 `docs/33`：Cordis/DSH 升级步骤、必须回归的协议面、回滚路径、禁止事项 | 含 `tokenBudget 依赖 usage` 的提醒 |
| ⑮ 仓库清理 | 删 `apps/desktop/dist`（3.2G）、`tmp`、`updates` 暂存（310M）、根目录 68 个 `.tgz`、旧 APK/安装包、chrome profile | 根目录只剩 `.git/.github/.agents/.zcode/qingmei` + 最新 APK |

> 顺带：`releases/` 不再复制 `apps/mobile`，release 从 1.1G 降到 164M；再排除 desktop 产物后约 15M（下次发布生效）。

### P1-⑩ 群画像标签准确率 + 一次满盘事故（2026-11-12）

**标签评估**（`scripts/eval-group-tags.mjs` + `scripts/fixtures/group-tags-eval.json`，已进 gate）：

```text
28 组会话，accuracy 96.4%（27/28）
client 100/100  work 87.5/100  family 100/100  casual 100/90（precision/recall %）
```

改了一处：非吹水标签要求**至少命中两个不同关键词**（之前一个「项目」就把玩笑群贴成工作群）。
唯一漏判是反讽语气的吹水群（「项目又延期了，笑死」），关键词法处理不了——这正是「只建议、不自动打标签」的理由。

**满盘事故（生产 12:31–12:34 不可用）**：

- 根分区 50G 用满，`provider-store-sqlite` 报 `disk I/O error`，服务起不来；supervisor 回滚也失败（同样是满盘）。
- 根因：`releases/` 每次发布都把 `updates/`（789MB 安装包）复制一份 → 每个 release 1.1G，20 个 release 共 15G；
  再加 `/tmp` 里每次部署留下的 78MB tar 包。
- 处置：清 `/tmp`、删旧 release、裁 `updates/`（789M→103M），服务自动恢复；随后重新部署成功。
- 修复（已提交）：
  1. `releases.mjs` 不再复制 `updates/`、`apps/mobile/`、`apps/desktop/{dist,tmp}` → release 从 1.1G 降到 303M（下次约 15M）；
  2. `deploy.mjs` 部署前检查磁盘可用 < 5GB 直接中止；
  3. 部署成功后只保留最近 5 个 release。

### P1-⑨ 实验包二选一：复盘提升、内容删除（2026-11-12）

| 决定 | 依据 | 动作 |
| --- | --- | --- |
| `qm-review` **提升**进默认装配 | 报告由已有数据（回合/任务/故障）直接生成，不依赖外部平台；Web「复盘」页能用 | dev/prod 清单各加一项（22 项）；实测 `GET /api/v1/review` 返回 2026-11 报告、`/review/cards` 200 |
| `qm-content` **删除** | 平台连接器一个没实现，发布永远 409；默认装配不加载它，Web 控制台是 404——留着只是死代码 | 删 `experimental/qm-content`、`ContentView.vue`、路由/导航/ENDPOINTS/SSE 订阅、server 依赖；`docs/18` 归档为设计参考 |

副作用修正：

- `pnpm-workspace.yaml` 去掉再恢复 `experimental/*` 的过程中，`check-architecture` 用「packages/ 之外不扫」的方式漏掉 qm-review——
  这条**不是漏洞而是事实**：qm-review 直接读 `qm_message / qm_turn / qm_task_run / qm_incident`，搬进 `packages/` 会被门禁拦。
  结论写进 `docs/23 §7`，并记为技术债：补历史/故障的只读服务契约后再搬。
- Web 面板从 11 个减到 10 个（`ui-contract` 同步），打包产物 189.95 → 175.59 kB。

验证：gate 410 测试全绿；生产 release `2026-11-12T04-25-51-678Z`，装配 22 项，`/api/v1/content` 已 404。

### P1-⑧ A2 自主动作实测：会动手，但重试有两处缺陷（2026-11-12）

在生产上临时切 A2 跑 `scripts/verify-a2.mjs`，用「前置任务不存在」制造确定失败：
04:14:27 A2 直接重试并成功（新 run done，trace 带 runId），随后同一分钟再次 tick 转向概念提案
（`task.failed` 已进 4 小时冷却），04:20 两个候选都在冷却、`chosen=null`。

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `TaskRun.retryOf` / `CreateTaskInput.retryOf`：记录重试来源 |
| `packages/qm-task/src/store.ts` | 持久化 `retry_of`，老数据读作 null |
| `packages/qm-autonomy/src/index.ts` | 重试时带上 `target/priority/contract`（设备任务不会悄悄跑到服务器）；`retryOf` 的失败不再重试；同一原任务只重试一次（标题 + createdAt 双保险） |
| `scripts/verify-a2.mjs`（新） | 可重复的 A2 验证：记原级别 → 切 A2 → 造失败 → tick → 检查回执 → 再 tick → 回滚 → 恢复级别；「第二次 tick 执行别的动作」不算风暴 |
| `docs/13 §12.1` | 记录实测时间线、两条修复、冷却行为，以及「tokenBudget 当前无效（DSH 不回报 usage）」 |

### P1-⑦ 纠错复核与画像页（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `packages/host-gateway/src/index.ts` | 新增 `GET /api/v1/memory/profile`（owner 视角，memory.profile）；事实 PATCH/DELETE 写审计 `memory.fact.update / memory.fact.delete` |
| `packages/qm-distill/src/index.ts` | 新增 `POST /api/v1/memory/candidates/reopen`：误点忽略/撤回的候选可恢复为待确认，reopen 也写审计 |
| `apps/web/src/views/MemoriesView.vue` | 记忆页四个页签：事实 / 概念提案 / 待确认 / 画像；待确认里列出「最近忽略」（可恢复）与「最近采纳」（可整批撤回） |
| `apps/web/src/lib/endpoints.js` | `memoryProfile`、`memoryCandidateReopen` |
| 测试 | gateway：画像接口反映修正后的事实；qm-distill：忽略 → 恢复 → 采纳闭环；web 契约：四个页签与五个接口 |

### P1-⑥ 召回打分改进 + 是否上 embedding 的结论（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `packages/provider-neuron-memory/src/index.ts` | 召回打分加四项：IDF（高频词降权）、字段权重（object 1.6 / subject 1.3 / predicate 1.1）、命中词数、子串奖励；`flattenForMatch` 做匹配归一化 |
| `scripts/eval-memory.mjs` | 按生产默认的 limit 8 统计，同时报 recall@1/3/8；阈值从 80% 提到 **85%** |
| `docs/29` | 记录改进前后数字与**决策：暂不上 embedding**，并列了三条重新评估的触发条件 |

数字（同一 59 条回归集）：

```text
recall@1  76.3% → 78.0%
recall@3  88.1% → 89.8%
recall@8  —     → 94.9%
```

只剩 3 条（5%）是零词面重叠的语义查询；recall@8 已 94.9%，embedding 的收益只覆盖这 3 条，
而成本是模型 + 向量存储 + 延迟 + 迁移。结论是**先把词面打分做到位，不引入向量**；
触发条件写进 docs/29 §2.2，满足再试 sqlite-vec / Orama（不引入外部向量服务）。

### P1-⑤ 会话记忆凝练：规则抽候选，人采纳才进记忆（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-distill`（新） | `extract.ts` 11 条规则（叫/住/上班/喜欢/不喜欢/过敏/生日/作息/宠物/项目），问句、假设、代词、「记住」一律不抽；`index.ts` 订阅 `qm/turn/end`，只处理 owner 私聊成功回合，候选进 `qm_memory_candidate`（pending），**不直接写记忆** |
| 审批面 | `GET /api/v1/memory/candidates`、`POST .../decide`（采纳才 `memory.ingest`，origin.kind=distilled）、`POST .../rollback`（按 batch 撤回并 forget）；采纳/拒绝/撤回都写审计 |
| 并发 | 凝练串行化：两条并发回合同时查重会各插一条，已用 promise 链串起来 |
| LLM 可选 | `llmExtract` 默认 false；打开后按天限流（`llmDailyLimit`），解析失败静默放弃，候选置信 0.45 |
| `packages/core` | `TurnEnd.audience`（owner / group:<id>），供凝练过滤群聊；`MemoryRecord.origin.kind` 增加 `distilled` |
| `packages/qm-agent` | 回合结束时带出 audience |
| `apps/web` | 记忆页新增「待确认」页签：采纳/忽略 + 最近采纳可整批撤回 |
| 装配 | `qingmei.yml` / `qingmei.prod.yml` 各加一项（dev 21 项、prod 21 项），生产 `llmExtract: false` |

测试：`packages/qm-distill/test` 18 条（规则 11 + 插件 7：候选落库、群聊不抽、采纳/拒绝、重复去重、回滚、LLM 默认不调、LLM 配额）。

> 未做：候选的「编辑后采纳」、按主题自动归档、模型抽取提示词的评估集。

### P0-③ 首次启动向导：测试连接现在会验令牌（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop/electron/probe.cjs`（新） | `probeServer()`：`/healthz` 证明服务活着 + `/api/v1/session` 带 Bearer 证明令牌有效；`describeProbe()` 翻成人话（「令牌不对」「没有任何渠道在线」） |
| `apps/desktop/electron/main.cjs` / `preload.cjs` | 新增 `settings:probe` IPC 与 `probeServer` 桥接，在主进程里发请求（不受渲染进程 CORS 限制） |
| `apps/desktop/renderer/index.html` + `app.mjs` + `style.css` | 首启卡片从「一段说明 + 跳设置」改成真的向导：地址、令牌、「测试连接」、「开始连接」。测试只探测不保存；开始连接成功后才保存 → 建 SSE → 拉历史回填 |
| 设置页「测试连接」 | 同样走新探测：服务在线但令牌错会明确提示，不再只测 `/healthz` 就报「连接正常」 |
| `apps/desktop/test/probe.test.mjs`（新） | 5 条：健康+令牌有效、令牌错、连不上、地址非法、无渠道在线 |

版本 0.1.5（含向导）。验证：desktop 测试 31 条全绿；安装器静默安装/覆盖安装均通过。

> 修安装器时踩到一个坑并写进 `qingmei.iss` 注释：安装器里**不要做「扫描注册表找旧版并静默卸载」**。
> 那段 [Code] 会让 Setup 在静默模式下直接退出（exit 0、无日志、什么都没装），
> 0.1.4 之前能装纯属当时注册表里没有匹配项。现在只保留「安装前 taskkill 旧进程」；
> 旧 NSIS 版本请在「应用和功能」里手动卸载一次。

### P0-④ 恢复演练：备份能恢复，行数逐表对过（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `scripts/restore-drill.mjs`（新） | 备份 → 复制到临时库 → 逐表比较行数；源库只读。`--data` 指定库目录，`--out` 指定快照目录 |
| `scripts/restore-drill.test.mjs`（新） | 3 条用例：行数统计、差异检测、整条演练链路 |
| `docs/30` | 记录实操结果：本机 21 张表 / 888 行；生产 33 张表 / 30,021 行，完全一致 |

演练命令：

```bash
node scripts/restore-drill.mjs
ssh ubuntu@139.155.78.241 'cd /opt/qingmei && /opt/node24/bin/node scripts/restore-drill.mjs --data /opt/qingmei/data --out /tmp/qm-drill'
```

### P0-② 记忆评估集：6 → 59 条，有了可对照的基线（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `scripts/fixtures/memory-eval.json` | 59 条事实 + 59 条中文查询，按饮品/宠物/项目/日程/人物/健康/财务/设备/生活分簇，故意放近义干扰项（美式 vs 手冲、每周三次 vs 每两周一次） |
| `docs/29` | 记录基线：recall@1 **76.3%**、recall@3 **88.1%**（阈值 80%），并逐条列出 7 个漏召回及原因——这是后面「要不要上语义召回」的对照 |

验证：`node scripts/eval-memory.mjs` 两次运行结果一致；`pnpm gate` 全绿（387 测试 + 评估通过）。

> 说明：这是词面回归集，不是真实用户分布。数字不高是**有意的**——之前 6 条 100% 没有信息量。

### P0-① 故障注入：坏环境下的行为有测试了（2026-11-12）

| 文件 | 改了什么 |
| --- | --- |
| `scripts/fault-injection.test.mjs`（新） | 4 个跨包故障场景：SQLite 被别的连接锁住（快速失败、解锁恢复）、进程重启后待审批仍在、设备失联被租约收尾后迟到的 finish 不复活、重启时设备任务保持 running 等租约 |
| `packages/qm-agent/test/agent.test.ts` | 新增「DSH 不可用且没配 LLM」：回明确的「没有可用的执行器」，`turn/end.ok=false`，不静默假装成功 |
| `docs/31-故障注入清单.md`（新） | 已覆盖 15 类故障，每条指向具体测试；未覆盖 5 类（磁盘满、端口占用、DSH 半死、长稳、泄漏）写明补法 |

验证：`pnpm gate` 全绿（387 测试）。

> 未做：需要真进程/真环境的四类（见 docs/31 §2），留给 smoke 变体与长稳 cron。

### 发布链改造：Inno 安装包 + 跨版本更新 + 一键部署（2026-11-11）

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop/installer/inno/qingmei.iss`（新） | Inno Setup 安装脚本：`PrivilegesRequired=lowest`（装到 `%LOCALAPPDATA%\Programs\Qingmei`，不弹 UAC）、同 AppId 覆盖安装、`/VERYSILENT` 可被更新器调起、安装前 taskkill 并静默卸载旧 NSIS 版本。`Compression=lzma2/normal`——`max` 在 210MB payload 上会产出「双击没反应」的包 |
| `apps/desktop/installer/inno/ChineseSimplified.isl`（新） | Inno 6 不自带简体中文，从 issrc 取官方语言文件 |
| `apps/desktop/electron/updater.cjs`（新） | 自研更新器替代 electron-updater：读 `/updates/desktop/latest.json` → 版本比较 → 下载 → sha256 校验 → 静默安装。任意旧版本一步升级 |
| `apps/desktop/electron/main.cjs` | 接入新更新器：启动 8 秒后检查、托盘与右键菜单加「检查更新」、下载完弹框确认后安装并退出 |
| `apps/desktop/package.json` | 版本 0.1.4；`executableName: Qingmei`（exe 用 ASCII 名，快捷方式仍叫青梅）；删掉 NSIS 构建配置 |
| `scripts/build-desktop-installer.mjs`（新） | electron-builder 出 payload（`--dir`）+ ISCC 编译安装器；支持 `--skip-payload` |
| `scripts/release-desktop.mjs` | 改为生成 `latest.json`（sha256/size/notes），不再写 electron-updater 的 latest.yml |
| `scripts/deploy.mjs`（新） | 一键发布：gate → vite 构建 → 打 tar（排除 node_modules/data/desktop 产物）→ scp → sudo supervisor → healthz 校验 → 上传桌面/Android 更新源 |
| `package.json` | 新增 `desktop:installer`、`deploy` |

线上已执行：

```text
supervisor 部署 release 2026-11-11T04-47-06-089Z，healthz ok（web/feishu/qq 在线）
/updates/desktop/latest.json → 0.1.4（107,903,516 B，sha256 2268d872…），安装包 HEAD 200
更新器自测：currentVersion 0.1.3 → 返回 0.1.4（跨版本路径通）
Android 更新源仍是 0.1.12（versionCode 13），本来就按 versionCode 一步升，无需改
```

本地验证：静默安装 `Qingmei-Setup-0.1.4.exe` → `%LOCALAPPDATA%\Programs\Qingmei`，exe 版本 0.1.4，
HKCU 卸载项「青梅 0.1.4」；卸载后目录与注册表都清干净。

> 未做：0.1.2 / 0.1.3（NSIS）客户端需手动装一次 0.1.4 才能进入新更新通道；`electron-updater` 依赖暂留（代码已不用），等下次动 lockfile 时删。

### 可交付性收尾：清单门禁 / 生产清单 / 设备租约 / worker 权限 / 备份（2026-11-11）

| 文件 | 改了什么 |
| --- | --- |
| `scripts/check-config.mjs`（新） | 清单门禁：每个插件名必须对应工作区里真实存在的包，同名重复装配也报错；`--env` 额外核对 `{ $env }` 是否齐全。挂进 `gate.mjs` 第一步，也提供 `pnpm config:check` |
| `scripts/check-config.test.mjs`（新） | 6 条用例；「仓库自带的 qingmei.yml / qingmei.prod.yml 全部可解析」就是防止生产清单再次腐烂的回归 |
| `qingmei.prod.yml` | 重建：去掉 19 个已删除的包（`service-store` / `service-llm` / `qm-thread` / `provider-llm-openai`…）；不再装 LLM，对话与任务统一走 `provider-dsh-acp`；autonomy 打开 `modules`；`qm-task` 加 `leaseTimeoutMs: 3600000`；webRoot 指向 `current/apps/web/dist`。之前这份清单从 HEAD 部署会直接启动失败 |
| `qingmei.yml` | 删掉错挂在 `qm-audit` 名下的 autonomy 配置（YAML 合法但配置落错插件），以及指向不存在插件的注释 |
| `packages/provider-dsh-acp/src/acp-client.ts` | ① 接管子进程 `error` 事件：命令不存在/无权限时以前会把整个服务进程带崩，现在 reject 请求、`available=false`、原因进 stderr；② `harnessEnv()` 剔除青梅密钥（`QM_TOKEN` / `QM_ADMIN_PASSWORD` / `QM_LLM_KEY`…），保留 `QM_DSH_API_KEY` |
| `packages/qm-task/src/index.ts` | `leaseTimeoutMs`（默认 30 分钟，0 关闭）：设备任务 running 且超过该时长没有进展 → failed「设备失联」；本地 run 仍走自己的执行超时 |
| `scripts/harness-worker.mjs` | 权限请求默认落服务端审批队列（建单 + 轮询决定），发不出去/超时按拒绝，不静默放行；`--auto-approve true` 才自动批准；传给 dsh 的环境变量同样剔除青梅密钥 |
| `apps/server/src/cli.ts` | `qm doctor` 不再要求 `llm` 服务——生产本来就不装 LLM，之前 prod 清单会被误判「异常」 |
| `packages/host-gateway/src/index.ts` | CORS 预检放行 `HEAD/PATCH/DELETE`：服务端本来就处理日程、记忆事实的 PATCH/DELETE，之前跨源调用会被预检挡下 |
| `packages/qm-autonomy/src/modules/conversation-profile.ts` | 删掉 `conversations/suggestions*` 三个路由的重复注册（第二份整块是死代码，48 行） |
| `scripts/backup.mjs`（新） | `VACUUM INTO` 在线快照 + `integrity_check` + 保留最近 N 份；`--restore` 覆盖前先给现库留底。`pnpm backup` |
| `scripts/export.mjs`（新） | 账本导出成 JSON（事实/任务/日程/审批/审计），`secret` 事实默认剔除；`--all` 才含消息。`pnpm export` |
| `scripts/release-desktop.mjs`（新） | 生成 electron-updater 要的 `latest.yml`（sha512 base64 + ISO `releaseDate`）并暂存到 `updates/desktop/`；上一版 latest.yml 的 releaseDate 是没展开的 PowerShell 表达式 |
| `docs/30-备份与恢复.md`（新） | 备份时机、快照/恢复命令、换机器流程 |
| `docs/19`、`docs/23`、`apps/desktop/README.md`、`README.md` | 同步 worker 权限行为、插件/服务清单、更新源做法、备份文档入口 |
| `packages/provider-memory-sqlite`、`packages/provider-task-sqlite` | 删除：只剩 `node_modules` 的空壳，没有 package.json |

验证：`pnpm gate` 全绿（config → arch → 7 组 typecheck → memory eval → 370 测试 0 失败），`node scripts/smoke.mjs` 通过；`qm doctor --config qingmei.prod.yml` 结论「健康」（22 插件 / 78 路由 / harness 不可拉起时降级而不是崩溃）。

> 未做：生产部署与 `/updates/` 上传（`updates/desktop/` 已备好，等确认）；删空壳包后没有重跑 `pnpm install`，`node_modules` 里仍有旧链接。

### 账号运维内容层 + 前端迁移 Vue 3（2026-11-06）

| 文件 | 改了什么 |
| --- | --- |
| `apps/web/*` | 前端从零构建单文件迁到 Vue 3 + Vite：`src/App.vue` 壳（桌面侧栏 / 移动端抽屉导航）、hash 路由、11 个视图（含「账号运维」）、`src/lib/*`（endpoints / api / session / sse / format / bus）；登录门支持管理员密码与访问令牌；`?token=` 与 SSE、Capacitor 兼容保持不变。视图全部静态导入（避免服务重启后懒加载分包失败），hash base 只用 `pathname`（不能把 `?token=` 算进 base）。构建产物 `apps/web/dist` 由网关托管 |
| `packages/qm-content/*`（新） | 内容层账本：`qm_content_item` / `qm_content_variant` / `qm_content_action`；状态机（docs/18 §6）、四平台 render（blog / weibo / bilibili / zhihu，纯函数 + 截断与长度提示 + 跨平台重复句检查）、预算与静默闸门、`GET/POST /api/v1/content*`、SSE `content-updated`、审计留痕；发布接口一律 409「平台连接器未实现」，不假装成功 |
| `packages/host-mcp/src/index.ts` | 新增 `content_draft` / `content_variants` / `content_status` 三个工具（失败返回 `{ ok:false, reason, retryable }`） |
| `packages/provider-permission-static/src/index.ts` | 三个新工具登记风险等级（draft=write，variants/status=read） |
| `qingmei.yml` / `qingmei.prod.yml` | 挂载 `qm-content`；webRoot 改到 `apps/web/dist`；dev 清单补 `provider-schedule-sqlite` 与 `qm-reminder`（原本缺失导致 `qm-autonomy` 永久 PENDING、启动 15 秒后整体失败） |
| `apps/mobile/*` | 同步脚本改为同步 Vite 产物并保留 139 配置；测试改扫打包后的 js 块 |
| `apps/server/test/config.test.ts` | 清单计数与 webRoot 断言更新 |
| 测试 | 445 全绿（含 qm-content 10 条、ui-contract 8 条）；本地冒烟：创建 → 人审 → 批准 → 四平台 render → publish 409，动作流水 8 条 |

> 未做：平台连接器（微博 / B站 / 知乎 / 博客 publish 全未实现）、登录态检测、评论与 @ 回复、视频链路；账号接入前不进入发布。

**已部署（2026-11-06）**：生产 release `2026-11-06T03-00-40-971Z`（supervisor shell 切换，healthz 200，webRoot 指向 `apps/web/dist`，`qm-content` 路由已生效）。
Windows 0.1.1（NSIS + latest.yml）与 Android 0.1.1（versionCode 2，APK）已上传 `/opt/qingmei/updates/`，两端更新源外部可访问。
Android 没有应用内更新器，需要手动下载安装；桌面 0.1.1 无功能改动，属更新通道验证。
部署踩坑：打包时必须排除 `config-snapshots/`（root 解包会改属主，服务启动写快照 EACCES）。

**Android 应用内更新（2026-11-06 晚）**：新增 `QmUpdaterPlugin`（版本查询 / 下载 / sha256 校验 / 拉起安装器）
+ `REQUEST_INSTALL_PACKAGES`；前端 `updater.js` + `UpdatePrompt.vue` 在启动时比对
`/updates/android/latest.json`。已发布 0.1.2（versionCode 3，带更新器的引导包）与 0.1.3
（versionCode 4，更新目标）；`/updates/` 补了 CORS 头（WebView 跨域拉清单）。
旧版本需手动安装一次 0.1.2，之后才会自动提示。

**Android 0.1.4（2026-11-06 17:10）**：移动端顶部菜单改为左侧抽屉（青梅开关 / 遮罩点击 / 菜单项点击 / Esc 收起），
桌面侧栏不变；APK 与 `latest.json` 已上传更新源，外部下载 sha256 校验通过。

### MCP 记忆闭环：recall 带 id，新增盘点/修正/遗忘

| 文件 | 改了什么 |
| --- | --- |
| `packages/host-mcp/src/index.ts` | `memory_recall` 改为按 `facts` 渲染，输出带 id、置信度、来源；新增 `memory_forget` / `memory_update` / `memory_list`；`memory_list` 在工具层挡掉 secret |
| `packages/provider-permission-static/src/index.ts` | 三个新工具登记风险等级（list=read，update/forget=write）；群聊拒绝改/删记忆并给人话理由 |
| `packages/host-mcp/test/mcp.test.ts` | 假服务补 listFacts/updateFact/forget；新增 4 条用例（recall 带 id、forget 三种命中、update 三种校验、list 过滤 secret） |
| `packages/provider-permission-static/test/permission.test.ts` | 私聊放行全部新工具；群聊改/删记忆的拒绝理由 |
| 测试 | 433 全绿；smoke 通过 |

> 未做：硬删（仍是软删 + 移 FTS）、TTL 过期（`expires_at`）、纠错复核队列；`listFacts` 本身不排除 secret 的既存口径未改，只在 MCP 工具层挡住。线上未发布——`provider-permission-static` 属 L3，需人工发版。

### 主线收口：外壳/评分卡/市场

- P5：current -> releases/<id> 外壳已在生产启用，supervisor 先写 release 再切；watchdog 5 次失败回滚
- P5：人格/技能 30 天熔断、快照、Web 设置页回滚；R 逐条评分卡
- P7：M6 离线市场、工具白名单、安装/回滚；A8 语气学习
- P6：W3/W4 设备执行器显式 uture，/api/v1/enforcement/status
- 测试：406 全绿

> 未做：严格只读运行目录、在线市场、M4/M7。

### 桌宠完整版：图片、形象、引导、全屏隐藏

| 项 | 状态 |
| --- | --- |
| 图片 | 服务端 `/api/v1/uploads` + 消息 image blocks；桌面粘贴/拖入发送（≤4MB） |
| 形象 | 青梅（WebM）/ 小光球；右键「选个动作…」 |
| 引导 | 首次启动欢迎页 → 设置连接 |
| 全屏隐藏 | `fullscreen.exe` 6 秒轮询，实测可见→隐藏→恢复 |
| 聊天 | SSE chunk 流式、Markdown、离线补发 |
| 打包 | portable + NSIS；`fullscreen.exe` 以 asarUnpack 打包 |
| 测试 | 369 全绿 |

> 未做：图片历史回显、独立字体缩放、番茄钟/喂饭账本、代码签名。

### 桌宠宿主：设置/流式/打包

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop` | 设置：大小缩放/音效/开机自启/隐藏通知/全屏自动隐藏；系统通知；显示器回位 |
| `apps/desktop/renderer` | SSE `chunk` 流式聊天、Markdown 渲染、气泡去 Markdown、离线待发补发 |
| `apps/desktop/electron/fullscreen.ps1` | 前台全屏检测（6 秒轮询，Windows） |
| `apps/desktop/build/icon.ico` | 应用图标；版本 0.1.0 |
| `apps/desktop/dist` | portable exe 构建成功（约 100MB）；NSIS 生成卸载器被杀软/权限拦截，未稳定 |
| 测试 | 368 全绿 |

> 未做：sidecar 拉起内核、首次启动向导、移动端、三端一致、代码签名。

### M4 桌面宿主（桌宠）

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop`（新） | Electron 透明置顶桌宠：SSE 通知→头顶气泡、点击聊天、输入发送、右键菜单、拖动、透明区域点击穿透；令牌 safeStorage 加密 |
| `apps/desktop/renderer/core.mjs` | SSE 分块解析、事件转气泡、气泡队列、地址/令牌编码、历史映射（纯逻辑，可单测） |
| 测试 | 367 全绿（新增 11 条桌面契约/核心测试） |
| 文档 | docs/05 M4、docs/00、README、本文件 |

> 未做：sidecar 拉起内核、托盘、开机自启、安装向导、移动端、三端一致；本机无交互桌面，GUI 启动未实测。
## 2026-11-03

- **决策**：W3/W4 的设备执行器（专注模式/屏蔽/锁屏）暂缓，移入 [docs/16 §8.1](docs/16-Future与硬件依赖.md)；服务端执行队列保留，但不执行设备动作。

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
3. **前端已有构建、仍无类型检查**：`apps/web` 是 Vue 3 + Vite（`pnpm web:build`），
   `apps/web/test/ui-contract.test.ts` 继续守接口、路由与 SSE 契约；补 TS 检查要等仓库加 typescript。
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
# 一键发布（gate → 前端构建 → 打包 → supervisor → healthz → 更新源上传）
node scripts/deploy.mjs
node scripts/deploy.mjs --skip-tests       # 只改了文档时
node scripts/deploy.mjs --updates-only     # 只传 updates/desktop 与 Android
node scripts/deploy.mjs --install          # 依赖有变动时才装（默认跳过，省时间）

# 本地
cd E:/Workflow/qingmei && node --test          # 全量测试
node scripts/smoke.mjs                        # 端到端：起服务→发消息→落库→重启后还在

# 健康
curl -s http://127.0.0.1:7410/healthz
sudo journalctl -u qingmei -n 50 --no-pager

# 回滚（supervisor 激活历史 release）
ls /opt/qingmei/releases
sudo -n /opt/node24/bin/node /opt/qingmei/scripts/shell.mjs activate <release-id> --root /opt/qingmei
sudo systemctl restart qingmei
```

密钥都在 `/etc/qingmei/env`（0600）：`QM_TOKEN` / `QM_LLM_*` / `QM_DSH_API_KEY` / `QM_MCP_TOKEN`。
访问地址：`https://139.155.78.241:8710/?token=<QM_TOKEN>`。
服务器时区是 `Asia/Shanghai`，Node 在 `/opt/node24/bin`（默认 PATH 里的 node 是 20，跑不了 `node:sqlite`）。

## 5. 本次改动的落点

### P6：W3/W4 执行请求队列（服务端）

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-nudge` | 合同强度 + 动作白名单校验；30 秒取消窗口；L4 每日一次；无执行器到期失效；`GET /enforcement`、`POST request|cancel` |
| 测试 | 356 全绿 |

> 设备执行器（专注模式/屏蔽/锁屏）仍缺；不会真的操作设备。

### P7：A6/A7/A8 主动开场 + M6 技能包

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-opener`（新） | 机会窗口/理由校验/每日上限；承诺解析（明天带饭 → 次日 20:00）；回应状态机；7 天不重复措辞、偏好分钟、拒绝暂停 |
| `packages/qm-skill`（新） | `skills/<name>/SKILL.md + skill.json` 热加载；`GET /skills`、`POST reload`；MCP `qm_skill_list/read`；owner prompt 注入技能名 |
| `packages/host-mcp` / `qm-agent` | 技能工具与提示注入 |
| `skills/` | 两个示例技能：weekly-report、project-status |
| 配置 | dev/prod 各加两项（32 项插件） |
| 测试 | 355 全绿 |

> M4 三端宿主、M7 Watch 缺真实客户端/硬件，延期；W3/W4 同理。

### P7 起步：A4 记忆热点 + 周报

| 文件 | 改了什么 |
| --- | --- |
| `packages/provider-memory-sqlite` | 事实加 `hits`，召回强化时累计 |
| `packages/qm-memory-hotspot`（新） | 夜间热点调整（≤0.05/条、≤10% 批量、只改 salience）、可回滚、审计；周一记忆周报 |
| 配置 | dev/prod 各加一项（30 项插件） |
| 测试 | 347 全绿 |

> 用模型判断热点、日报、环境自维护未做。

### P6 起步：W1 任务合同 + W2 督促阶梯 + W5 休息

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` / `provider-task-sqlite` | `TaskContract`（截止/进展信号/期望曲线/强度/逃生）；HTTP/MCP 透传并持久化 |
| `packages/qm-nudge`（新） | 期望 vs 实际进度、事实清单、L1/L2 私聊、忽略累计、逃生暂停；L3/L4 只记录 |
| `packages/qm-rest`（新） | 90 分钟休息提醒、23:30 收工、连续 6 天降强度；`GET /api/v1/rest`、`POST tick` |
| 配置 | dev/prod 各加两项（29 项插件） |
| 测试 | 343 全绿 |

> W3/W4（摩擦/强制）需要设备执行器，未做。

### P5 收口：S1 supervisor + S2 playbook + R 复盘

| 文件 | 改了什么 |
| --- | --- |
| `scripts/supervisor.mjs` | 部署 supervisor：备份 → 解包/安装 → 重启 → 轮询 healthz；不健康自动回滚，回滚保留 `data`/`node_modules`；含 3 条单测 |
| `packages/qm-incident` | playbook（解决时写根因/动作，复犯自动派诊断）、拒绝 3 次停用 + 反例、`POST rollback` 取消自动任务、`runId` |
| `packages/qm-review`（新） | 每月 1 号报告（回合/任务/故障/主动性、失败 Top、消息抽样）；`POST /api/v1/review/run|score`；低分提醒 |
| 配置 | dev/prod 各加一项（27 项插件） |
| 测试 | 333 全绿 |

> P5 最小版收口；未做：不可变外壳/版本目录、配置类自动修复、逐条评分卡/C 类提案。

### P5 起步：S1 自愈最小闭环

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-incident`（新） | 失败回合/任务 → incident；指纹去重（24h）、每日提案上限（默认 3）、连续失败熔断（默认 2）；`GET /api/v1/incidents`、`POST dispatch|resolve` |
| 配置 | dev/prod 各加一项（26 项插件） |
| 测试 | 324 全绿 |

> 未做：supervisor 原子换版/自动回滚、端上提案卡片、L3 补丁拒绝。

### P4 收口：标签建议 + 内存幂等

| 文件 | 改了什么 |
| --- | --- |
| `packages/provider-memory-sqlite` | `qm_memory_event`：带 `idempotencyKey` 的上报只应用一次；`qm_finish_task` 的任务记忆按 runId+序号自带键 |
| `packages/qm-conversation-profile` | 群消息累计到阈值后给一次标签建议（关键词 + 证据，只建议）；`GET /suggestions`、`POST accept|dismiss` |
| `apps/web` | 群组面板展示建议，可采纳/忽略 |
| 测试 | 319 全绿 |

> P4 剩余（按需再启）：embedding 种子、thread/设备域、双通道确认、工具清单裁剪。

### P4：N+ 身份绑定

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `IdentityService`（resolve/bind/unbind/actor/list/ensureOwner） |
| `packages/qm-identity`（新） | actor + `channel:platformUserId` 绑定；每渠道首个私聊自动绑 owner；`GET /api/v1/identity`、`POST /bind`、`POST /unbind` |
| `packages/qm-agent` | 私聊身份闸：解析不到 owner 且不能首绑 → 回「未授权」，不调模型 |
| 配置 | dev/prod 各加一项（25 项插件） |
| 测试 | 316 全绿 |

> 未做：双通道确认流程、family/guest 的记忆视口。

### P4：N+ 跨端起步

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-agent` | 群视口改为 `group:<channel>:<id>`，不同渠道即使会话 id 撞了也不串味 |
| `packages/provider-memory-sqlite` | 多源印证写 `qm_mem_provenance`；同一来源重复上报幂等、不重复加权 |
| 文档 | docs/02、docs/05 的 audience 口径同步 |
| 测试 | 310 全绿 |

> `qm_finish_task` 的结构化任务记忆上报此前已有。未做：身份绑定/设备域/thread 缝合/幂等事件表。

### P4：群画像后置校验与群管理页

| 文件 | 改了什么 |
| --- | --- |
| `packages/qm-agent` | 群回复后置校验：禁止话题/手机号/身份证/内网地址 → 拒绝话术 + `qm_audit`（`group.reply.blocked`） |
| `apps/web` | 顶栏「群组」面板：列表、勾选标签、保存（走 `/api/v1/conversations/configure`） |
| 测试 | 309 全绿 |

> 未做：标签建议、工具清单裁剪、群管理页里的审计视图。

### P4：群画像最小版（G）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `ConversationProfile` / `ConversationPolicy` / `GROUP_TAG_POLICIES` / `ConversationProfileService` |
| `packages/qm-conversation-profile`（新） | 未配置群固定回「权限未配置」（deterministic，handledBy 跳过模型）；`GET /api/v1/conversations`、`POST /api/v1/conversations/configure`；标签策略取更严格 |
| `packages/qm-agent` | 群聊注入「本群规则」，发送前按 `maxChars` 截断 |
| 配置 | dev/prod 各加一项（24 项插件） |
| 测试 | 306 全绿 |

> 未做：群管理页、标签建议、后置校验/审计、工具裁剪。

### P4：夜间巩固最小版

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `MemoryService.consolidate`（默认不做）+ `ConsolidationReport` |
| `packages/provider-memory-sqlite` | 每个 subject 保留价值最高的 5 条，其余低置信/过旧事实软压缩（`valid_to` 置位） |
| `packages/qm-consolidate`（新） | 每天 4 点执行；落 `qm_memory_consolidation`；有压缩才发报告；`POST /api/v1/memory/consolidate` 手动触发 |
| 配置 | dev/prod 各加一项（23 项插件） |
| 测试 | 301 全绿 |

> 未做：embedding 种子、情节聚类/抽取式完整巩固。

### P4：工作记忆层

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `RecallQuery.sessionId` |
| `packages/provider-memory-sqlite` | 同一会话上一轮点亮的前 8 个节点，按 2 小时半衰期继承；不同会话隔离 |
| `packages/qm-agent` | 召回时带上 sessionId |
| 测试 | 298 全绿 |

> 工作记忆在进程内，重启清空；持久化留给巩固阶段。

### P4：多跳扩散与突触剪枝

| 文件 | 改了什么 |
| --- | --- |
| `packages/provider-memory-sqlite` | 扩散从 1 跳扩到 ≤3 跳（γ=0.6、阈值 0.005 剪弱扩散）；初始突触权重 0.2；每日 + 启动时剪枝（w<0.05 且 180 天未共同激活） |
| 测试 | 297 全绿（三跳召回、剪枝保留强边） |

> 未做：embedding 种子、工作记忆层、夜间巩固/压缩。

### P4 起步：神经元召回（打分 + 突触扩散）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `MemoryRecord.salience` |
| `packages/provider-memory-sqlite` | 事实存 salience/activation/last_fired；召回按 docs/09 权重打分；一跳突触扩散（γ=0.6）；返回后异步赫布强化写 `qm_mem_synapse` |
| 测试 | 295 全绿（联想召回、显著度排序） |

> 未做：embedding 种子、多跳、工作记忆层、剪枝/夜间巩固。

### P3 收尾：回滚与抢占

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `TaskRunnerService.cancel`（默认不支持）；`AutonomyExecution.status` 加 `rolled_back`；`rollback()` 契约 |
| `packages/qm-task` | 取消排队/执行中的 run（abort + 记 cancelled）；`preemptPriority`（默认 9）达线且低优有 checkpoint 时抢占；`pumpQueued` 防竞态 |
| `packages/qm-autonomy` | `POST /api/v1/autonomy/rollback`：回滚已执行的可逆动作（`task.retry` 取消派生 run），trace 标 `rolled_back` 并降一级 |
| `apps/web` | 主动面板加「回滚动作」按钮 |
| 测试 | 293 全绿 |

> 被抢占的 run 记 `cancelled`，checkpoint 留在账本，但 harness resume 未实现，不会自动续跑。

### A2 排期器：DAG 依赖

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `TaskRun.dependsOn` / `CreateTaskInput.dependsOn` |
| `packages/provider-task-sqlite` | `depends_on_json` 持久化、去重 |
| `packages/qm-task` | 依赖未完成留在队列；前置失败/取消/不存在或成环 → 本任务 failed；`pumpQueued` 修复入队竞态 |
| `packages/host-mcp` / HTTP | `qm_dispatch_task` 与 `POST /api/v1/tasks` 支持 `dependsOn` |
| `apps/web` | 任务卡显示「等 N 个前置」 |
| 测试 | 289 全绿 |

> 未做：抢占（低优需 checkpoint）。

### A5 投诉/回滚信号

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `AutonomyState.complaints` / `lastComplaintAt`；`complain()` 契约（默认不支持） |
| `packages/qm-autonomy` | 投诉降一级、清空待回应、累计次数并通知；`locked` 只记录不降；`POST /api/v1/autonomy/complaint` |
| `apps/web` | 「主动」面板加「这条没用」按钮，状态栏显示投诉次数 |
| 测试 | 286 全绿 |

> 未做：具体动作的回滚（撤回已执行操作）。

### A2 排期器：优先级 + 静默时间窗

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `TaskRun.priority` / `CreateTaskInput.priority`（0–9，默认 5） |
| `packages/provider-task-sqlite` | 存 priority，越界夹到 0..9，老数据按 5 |
| `packages/qm-task` | 队列按优先级降序、同级到达顺序；`quietHours`（默认 23:00–08:00）内只有 `priority >= urgentPriority`（默认 8）才启动，窗口结束自动重泵 |
| `packages/host-mcp` | `qm_dispatch_task` 支持 `priority` |
| `apps/web` | 任务条目显示非默认优先级（`P9`） |
| 测试 | 285 全绿 |

> 未做：DAG 依赖、抢占（低优需 checkpoint）。

### M1 画像最小版

| 文件 | 改了什么 |
| --- | --- |
| `packages/core` | `MemoryService.profile()`（默认空）+ `ProfileEntry` / `ProfileFact` / `ProfileQuery` |
| `packages/provider-memory-sqlite` | 按 subject 聚合 owner 高置信有效事实，每 subject 最多 4 条，最多 12 个 subject；群聊视口返回空 |
| `packages/qm-agent` | 私聊时注入「关于主人」稳定段（与按句召回分开），群聊不调用 |
| 测试 | 281 全绿 |

> 未做：画像页（查看/编辑/删除）、`summarize`、情节/决策/教训类型。

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
25. **类里的可选方法签名会遮住子类实现**：Node 类型剥离把 `profile?: (...)` 变成自己的
    `profile = undefined` 字段，子类原型上的方法被遮住（`typeof memory.profile` 不是 function）。
    可选能力要么放接口里，要么给基类一个默认实现，不要用可选方法声明。

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

