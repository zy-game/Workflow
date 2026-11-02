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

1. **H 收尾**：任务面板 ✅、H3 审批桥 ✅、`session_id` 回填 ✅、`qm doctor` 的 harness 段 ✅；
   还差 resume（拿 session_id 调 `session/resume`）、token 预算、产物（`qm_publish_artifact`）。
   做完这些「执行」这条主线才算完整，A1 才有东西可催。
2. **M1 补记忆语义（P1 欠账）**：`audience` + `validTo`（新值让旧值失效而不是覆盖）+ 画像最小版。
   现在「我养猫→我养狗」只能覆盖，查不到「猫的记录已失效」，与 docs/05 M1 验收不符。
3. **历史表结构化**（M3 的前置）：`blocks_json` / `direction` / `trace_id` + 幂等索引 + `qm_turn`。
4. **渠道侧确认**：审批目前只有 Web 入口；手机/watch 要等 M4/M7 的宿主与渠道。
5. 工程侧：路由挪回插件、`cron.ts` 拆包、`GET /api/v1/audit`。

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
