# NEXT · 下个会话从这里开始

> 写于 2026-10-30，M2-cron + Web 日程页完成并已部署。仓库全量测试 108/108（`node --test`）。
> 新会话第一句建议：「读 qingmei/NEXT.md，做技术债 1」。

## 1. 现在是什么状态

```text
Web/QQ ─▶ gateway ─▶ qm-agent ─┬─▶ harness（DSH 0.2.1 / ACP）  对话车道
                                └─▶ llm（OpenAI 兼容 / sub2api） 降级 + 后台抽取
memory（事实）· mcp（memory/schedule 工具）· schedule（at / everyMs / cron）· channel · store
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
- 提醒到点后投递到 Web 并写入会话历史
- **Web 日程面板**：顶栏「日程」→ 列出全部提醒（按 nextAt 排序、按各自时区显示时间、
  带 cron 规则与 id），可逐条取消，已触发的一次性提醒保留最近 5 条
  - 接口 `GET /api/v1/schedules`、`DELETE /api/v1/schedules/<id>`
- 人格白名单 + 输出卫生（内部工具名/路径不外泄）

## 2. 下一步

1. **技术债 1：主动消息统一落库**。`qm-agent` 与 `qm-reminder` 各写一次 `qm_message`，
   改成 `ChannelService.send` 成功后发 `qm/outbound`，由 `qm-history` 统一落库。
2. **技术债 2：MCP 工具表去硬编码**。`host-mcp` 的 TOOLS 数组手写 schema，
   新增工具要同步改 schema/描述/dispatch 三处；改成「工具定义 + handler」注册表。
3. **日程编辑与暂停**。契约里 `pause/resume` 还没有实现；面板目前只有「取消」。
4. 技术债见第 3 节；cron 细节见第 5 节，改之前先读。

## 3. 已知技术债（按优先级）

1. **落库双份**：`qm-agent` 与 `qm-reminder` 各写一次 `qm_message`。应改为 `ChannelService.send` 成功后发 `qm/outbound`，由 `qm-history` 统一落库。
2. **工具列表是写死的**：`host-mcp` 的 TOOLS 数组手写 schema，新增工具要同步改三处（schema/描述/dispatch）。
3. **没有 tsc**：仓库只有 cordis 依赖，类型正确性靠审阅；若要补，加 typescript 并跑 `tsc --noEmit`。
4. **tick 是全表扫描**：每秒 `find()` 一遍 `qm_schedule` 再在 JS 里比时间，日程多了要按 `next_at` 建索引或缩小查询。
5. **前端没有构建与类型检查**：`apps/web/public/app.js` 是零构建原生模块，只靠
   `apps/web/test/ui-contract.test.ts` 守 DOM id 与接口路径。
6. **部署不是自动的**：改完要手动 tar/scp/install/restart，见下。

## 4. 运维速查（139.155.78.241，用户 ubuntu，密钥 company.pem）

```bash
# 本地
cd E:/Workflow/qingmei && node --test          # 全量测试
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

### M2-cron（上一次会话）

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/cron.ts` | 新增：`parseCron` / `nextCronTime` / `systemTimeZone` |
| `packages/core/src/index.ts` | `ScheduleInput` 加 `cron` / `timezone` / `missedPolicy`；`Scheduled` 同步 |
| `packages/provider-schedule-sqlite` | 三类规则统一推进；cron 到点重排；`skip` 策略；`defaultTimezone` |
| `packages/host-mcp` | `schedule_create` 加 `cron` / `timezone` / `missedPolicy`；`seconds` 改为一次性；`schedule_list` 带 id |
| 测试 | `core/test/cron.test.ts`(12)、`provider-schedule-sqlite/test/schedule.test.ts`(10)、`host-mcp/test/mcp.test.ts`(5)、`host-gateway/test/http.test.ts`(14)、`apps/web/test/ui-contract.test.ts`(2) |

### Web 日程页（本次）

| 文件 | 改了什么 |
| --- | --- |
| `packages/host-gateway/src/index.ts` | `GET /api/v1/schedules`、`DELETE /api/v1/schedules/<id>`，无 schedule 服务时 503 |
| `apps/web/public/index.html` | 顶栏「日程」按钮 + 日程面板（列表/刷新/关闭/空态/错误态） |
| `apps/web/public/app.js` | 拉列表、按各自时区渲染、逐条取消；回合结束后自动刷新 |
| `apps/web/public/style.css` | `.app` 由 grid 改 flex（面板插在标题栏与消息之间），新增面板样式 |
| `apps/web/test/ui-contract.test.ts` | 守 DOM id 与接口路径两处契约 |

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
