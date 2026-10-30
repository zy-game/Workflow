# NEXT · 下个会话从这里开始

> 写于 2026-10-30，提交 `ccb8a75f`。当前仓库与服务器一致，测试 77/77。
> 新会话第一句建议：「读 qingmei/NEXT.md，做 M2-cron」。

## 1. 现在是什么状态

```text
Web/QQ ─▶ gateway ─▶ qm-agent ─┬─▶ harness（DSH 0.2.1 / ACP）  对话车道
                                └─▶ llm（OpenAI 兼容 / sub2api） 降级 + 后台抽取
memory（事实）· mcp（memory/schedule 工具）· channel · store
```

已可用的能力：

- 说一句话 → 抽取事实 → 重启后仍能召回；DSH 也会主动调 `memory_recall`
- 建提醒：`schedule_create`（`at` 绝对时间 或 `seconds` 倒计时）、`schedule_list`、`schedule_cancel`
- 提醒到点后投递到 Web 并写入会话历史
- 人格白名单 + 输出卫生（内部工具名/路径不外泄）

## 2. 本次要做：M2-cron

**目标**：支持「每天九点」「工作日八点半」这类 cron 提醒，且时区正确。

### 契约（packages/core）

```ts
interface ScheduleInput {
  text: string
  at?: Date
  everyMs?: number
  cron?: string          // 五段式：分 时 日 月 周
  timezone?: string      // IANA，如 Asia/Shanghai；缺省用进程时区
  missedPolicy?: 'fire-once' | 'skip'
}
```

### 实现要点

- 下一次触发时间用 `Intl.DateTimeFormat` 取目标时区本地时间再反推 UTC，**不要手写时区偏移**
- 解析支持：`*`、`n`、`a-b`、`a,b`、`*/n`、`a-b/n`
- 周字段：0 与 7 都是周日；日与周同时限定时按 cron 惯例取「或」
- 重启期间错过的：默认补发一次，然后按下一周期重排

### 必须有的测试（少一条都不算完成）

1. `*/15 * * * *`：连续五次 nextAt 间隔 15 分钟
2. `0 9 * * 1-5`：跨周末时跳到周一
3. `0 0 31 * *`：无 31 号的月份跳过
4. 闰日 `0 0 29 2 *`
5. DST：`Europe/Berlin` 春令时切换当天不重复、不漏
6. 跨时区：同一 cron 在 `UTC` 与 `Asia/Shanghai` 的 nextAt 相差 8 小时
7. 非法表达式（4 段、字段越界）直接报错，不静默

### 接入

- `host-mcp.schedule_create` 增加 `cron` / `timezone` 参数（与 `at`/`seconds` 三选一）
- 日程页（Web）列出、取消 —— 可放到 cron 之后单独做

## 3. 已知技术债（按优先级）

1. **落库双份**：`qm-agent` 与 `qm-reminder` 各写一次 `qm_message`。应改为 `ChannelService.send` 成功后发 `qm/outbound`，由 `qm-history` 统一落库。
2. **工具列表是写死的**：`host-mcp` 的 TOOLS 数组手写 schema，新增工具要同步改三处（schema/描述/dispatch）。
3. **没有 tsc**：仓库只有 cordis 依赖，类型正确性靠审阅；若要补，加 typescript 并跑 `tsc --noEmit`。
4. **部署不是自动的**：改完要手动 tar/scp/install/restart，见下。

## 4. 运维速查（139.155.78.241，用户 ubuntu，密钥 company.pem）

```bash
# 本地
cd E:/Workflow/qingmei && node --test          # 全量测试
tar -czf ../qingmei-m0.tgz -C . --exclude=node_modules --exclude=data --exclude=.git .

# 上传 + 部署
scp -i ~/.ssh/company.pem ../qingmei-m0.tgz ubuntu@139.155.78.241:/tmp/q.tgz
ssh ... "cd /opt/qingmei && tar -xzf /tmp/q.tgz && cp qingmei.prod.yml qingmei.yml
  && PATH=/opt/dsh/bin:/opt/node24/bin:\$PATH corepack pnpm install --prod --frozen-lockfile
  && sudo systemctl restart qingmei"

# 健康
curl -s http://127.0.0.1:7410/healthz
sudo journalctl -u qingmei -n 50 --no-pager
```

密钥都在 `/etc/qingmei/env`（0600）：`QM_TOKEN` / `QM_LLM_*` / `QM_DSH_API_KEY` / `QM_MCP_TOKEN`。
访问地址：`https://139.155.78.241:8710/?token=<QM_TOKEN>`。

## 5. 环境里踩过的坑（别再踩）

1. `ctx.plugin()` 是异步的：必须 `await`，否则服务是 `undefined`
2. `node --test <目录>` 不展开目录；仓库根直接 `node --test`
3. **`test/` 目录下任何 `.mjs` 都会被当成测试执行**，辅助脚本放 `fixtures/`
4. DSH 的 `settings.yaml` 只导入一次，随后改名 `settings.yaml.imported`，改完要再启动一次
5. ACP 的 `cwd` 必须是绝对路径
6. `service-*` 门面包也必须有 `apply`，否则 cordis 拒收、服务重启循环
7. GitHub 直连会被重置，推送要加 `-c http.proxy=http://127.0.0.1:7897`
