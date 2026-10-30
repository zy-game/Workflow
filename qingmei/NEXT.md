# NEXT · 下个会话从这里开始

> 写于 2026-10-30，技术债 1/2、日程暂停·继续、日程编辑完成并已部署；
> 同一天把 `docs/` 与实现对齐（见第 7 节）。
> 仓库全量测试 136/136（`node --test`），端到端 `node scripts/smoke.mjs` 通过。
> 新会话第一句建议：「读 qingmei/NEXT.md，做 M2 收口（工具审批 + 审计）」。

## 1. 现在是什么状态

```text
Web/QQ ─▶ gateway ─▶ qm-agent ─┬─▶ harness（DSH 0.2.1 / ACP）  对话车道
                                └─▶ llm（OpenAI 兼容 / sub2api） 降级 + 后台抽取
memory（事实）· mcp（memory/schedule 工具）· schedule（at / everyMs / cron / 暂停）· channel · store
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
- 人格白名单 + 输出卫生（内部工具名/路径不外泄）

## 2. 下一步

> 2026-10-30 已把 `docs/` 与实现对齐（见第 7 节）。**现在以 docs/05 的 M2 清单为准**，
> 下面按它的剩余项排。

1. **M2 收口：MCP 工具面的审批与审计**（docs/05 M2 验收第 5 条）。
   最小版：`permission` 服务（先做静态规则：危险工具默认拒绝）→ 拒绝时写 `qm_audit` →
   `qm_request_approval` 工具留给 H 阶段接渠道确认。
2. **历史表结构**（合并「历史表索引」）：按 docs/04 给 `qm_message` 结构化
   （`blocks_json` / `direction` / `trace_id` + `(session_id, platform_message_id)` 幂等索引），
   加 `qm_turn` 账本。现在消息被拍平成 `text`，接 QQ/飞书后图片/卡片会丢结构。
3. **路由挪回插件**：`/api/v1/schedules`、`/api/v1/memory` 用 `ctx.gateway.route` 注册到
   `qm-schedule-api` / `qm-memory-api`，host-gateway 只留 healthz / 静态 / SSE / dispatch
   （docs/01 §3、docs/03 §8）。
4. **contract 源拆分**：`core/src/cron.ts` 挪成独立 util 包，core 只留类型与抽象类
   （docs/01 §5 已记录当前妥协）。
5. **memory 收口**：`qm-agent` 把 memory 从可选改成必需（或启动期显式检查），
   补 `audience` / `validTo` 的最小语义（docs/02 已标注当前实现缺口）。

## 3. 已知技术债（按优先级）

1. **没有 tsc**：仓库只有 cordis 依赖，类型正确性靠审阅；若要补，加 typescript 并跑 `tsc --noEmit`。
2. **tick 是全表扫描**：每秒 `find()` 一遍 `qm_schedule` 再在 JS 里比时间，日程多了要按 `next_at` 建索引或缩小查询。
3. **前端没有构建与类型检查**：`apps/web/public/app.js` 是零构建原生模块，只靠
   `apps/web/test/ui-contract.test.ts` 守 DOM id 与接口路径。
4. **历史表没有索引**：`qm_message` 每次 `find()` 都是全表扫（store 是通用 JSON 表），
   长对话后要按 `session_id + created_at` 建真实列或加二级索引 —— 与第 2 节第 2 条一起做。
5. **MCP 工具命名未统一**：对话车道是 `memory_*` / `schedule_*`，docs/07 的任务数据面是 `qm_*`；
   接 H 阶段前要统一，否则模型会在同义工具里选错。
6. **部署不是自动的**：改完要手动 tar/scp/install/restart，见下。

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

## 7. 2026-10-30 文档对齐（已做，别重复做）

审计「实现是否偏离方案」后，先改文档而不是改架构，因为偏离大多来自文档没跟上 ADR-013。

| 文档 | 改了什么 |
| --- | --- |
| `docs/00` §8 | 实施状态：M0 完成、M1 只有事实子集、M2 日程侧完成、审批/审计未开始；测试数 136 |
| `docs/01` §3 / §5 / §11 | 编排层改成「上下文 + 调 harness」；记录「core 是契约真源、service-* 是门面」的当前妥协；补实际包清单（`host-mcp` = 目标形态里的 `harness-mcp`） |
| `docs/02` schedule | 契约改成实现的形状：`ScheduleInput` / `SchedulePatch` / `Scheduled(pausedAt, firedAt)` / `create|list|cancel|pause|resume|update`，并写明 cron 语义与 `InvalidScheduleError → 400` |
| `docs/02` memory | 标注当前只做 fact 子集、`qm-agent` 把 memory 当可选的偏离 |
| `docs/02` 事件表 | `qm/schedule/due` 的消费者改成 `qm-reminder` |
| `docs/03` §8 | 标注当前 HTTP 面只实现了 messages/events/schedules/healthz，会话资源与幂等键未做 |
| `docs/05` M2 | 按 ADR-013 重写交付物与验收：工具面 = MCP 注册表 + 白名单/审批，删除「自研工具循环 6 步/90s」这类已作废的验收 |
| `docs/07` §4 | 标注目标工具集（`qm_*`）未实现，当前只有对话车道的 `memory_*` / `schedule_*` |
| `README-P1.md` | 标明它是 M0 的历史验收记录，当前状态看 NEXT |

还**没**对齐（属于代码要改，不是文档要改）：工具审批与审计、`qm_turn` 账本、
`gateway.route` 无生产使用者、MCP 命名统一、memory 必需化、`cron.ts` 拆分。
这些都在第 2 节里排了序。
