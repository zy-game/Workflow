# 青梅 M0 · 落地记录与操作手册

> **范围**：M0（内核闭环），不是 [docs/00](docs/00-总体方案.md) 里 6 周的完整 P1——
> 完整 P1 还包含 M1（记忆）与 M2（工具与日程），本次未实现。
> **已交付**：配置驱动挂载 → HTTP 对话 → SQLite 落库 → 关服重启历史仍在。
> **验证环境**：Windows / Node v24.15.0 / pnpm 10.13.1；验证日期 2026-10-30。
> **验收**：`node --test` 57/57 通过；`node scripts/smoke.mjs` 通过；`qm doctor` 能诊断缺插件。

## 0. 验收后的修复

第一轮对抗验收判 fail，以下问题已在本轮修掉：

| 验收发现 | 修复 |
| --- | --- |
| Web 刷新丢失历史（M0 验收项） | `app.js` 新增 `loadHistory()`，启动时 GET `/api/v1/messages` 回放 |
| 缺 `qm-agent` 时 doctor 仍报“健康”、POST 200 但消息石沉大海 | 数 `qm/inbound` 监听者；doctor 报异常；`/healthz` 返回 `agent:0`；POST 直接 503 |
| 缺 provider 时只给 15 秒超时，没有逐条诊断 | `startApp({ tolerate: true })` + doctor 3 秒超时，输出 PENDING 插件与缺失依赖 |
| 清单里的 `{ $env: 'X' }` 不生效，密钥只能明文 | 组合根实现 `{ $env }`（缺失即报错）与 `${VAR}` 插值，含测试 |
| `store` 无事务与迁移（契约与 M0 交付物都要求） | 契约加 `transaction` / `migrate`，SQLite 实现 + 回滚测试 |
| `qm-agent` 写 user/assistant 两条非原子，可能留孤儿消息 | 用 `store.transaction` 包住 |
| 组合根按包名 `endsWith('/host-gateway')` 判断宿主 | 改为按 `gateway` 服务是否存在判断 |

**尚未修复（已知，低优先级）**：

- `gateway.route()` 仍无生产使用者：三个 API 路由硬编码在 host-gateway（`qm doctor` 显示“网关路由 0”）。
- 契约里的 `qm/turn/request`、`qm/channel/online|offline` 无人发出（预留给 M1/M2 的 router 与渠道健康）。
- `channel-web` 的能力矩阵比 Web 实际渲染能力宽（客户端只渲染文本），`clampToCapabilities` 尚无消费者。
- 没有 tsc 类型检查、没有覆盖率门禁、没有可复用的 store conformance suite。
- `qm-agent` 卸载时不等在途回合，关闭过程中可能写库失败（错误只进 `turn/end`）。

## 1. 启动


```bash
pnpm install          # 建立 workspace 链接
pnpm start            # = node apps/server/src/index.ts
pnpm qm serve         # 同一个入口
```

默认读仓库根的 `qingmei.yml`，监听 `http://127.0.0.1:7410`。

**必须在仓库根目录启动**：清单里的相对路径（`./data/qm.db`、`./apps/web/public`）
以进程工作目录为基准，由插件自己解析。Ctrl+C 会按挂载逆序卸载插件。

临时改端口 / 换清单：

```bash
node apps/server/src/index.ts --port 17411
node apps/server/src/index.ts --config ./tmp/other.yml
pnpm qm serve --port 17411 --host 0.0.0.0
```

启动成功后打印监听地址、每个插件 fiber 状态、已注册服务与渠道（不打印 config，避免泄露 token）：

```text
青梅 P1 · 已启动
  配置文件  E:\Workflow\qingmei\qingmei.yml
  监听地址  http://127.0.0.1:17411
  已挂载插件（9）
    ACTIVE    @qingmei/service-store
    ...
    ACTIVE    @qingmei/host-gateway
  已注册服务（4）
    channel   ← ChannelHub @ service-channel
    gateway   ← GatewayHub @ service-gateway
    llm       ← EchoLlm @ EchoLlm
    store     ← SqliteStore @ provider-store-sqlite
  渠道（1）
    web       online
```

## 2. 插件清单

`qingmei.yml` 是唯一的组装真源：每项 `{ name, config }`，组合根按 `name`
动态 `import()` 后 `ctx.plugin(mod, config)`。顺序无关——消费方先挂载会停在
`PENDING`，依赖（`inject`）就绪后自动继续。

集成时给原清单补了 5 项，否则链路不完整：

| 补充项 | 原因 |
| --- | --- |
| `@qingmei/service-channel` | 提供 `channel` 服务；缺了它 `qm-agent` 永远 `PENDING` |
| `@qingmei/service-gateway` | 提供 `gateway` 服务；`host-gateway` 与 `qm-agent` 都依赖它 |
| `@qingmei/channel-web` | 注册 web 适配器；缺了它 `/healthz` 渠道为空、回合回投报 `no adapter` |
| `@qingmei/service-store` / `@qingmei/service-llm` | 契约门面（无运行时行为），列出来让清单自解释 |

`token: 'dev-token'` 是开发占位，P1 的所有 `/api/v1/*` 都靠它鉴权。

## 3. doctor

```bash
pnpm qm doctor        # 或 pnpm doctor
```

doctor 用**同一个组合根**启动，但默认 `--port 0`（系统分配临时端口），
不会和正在运行的服务抢 7410。它打印：

- 清单里每个插件的 fiber 状态、uid、插件自报 name、`inject` 依赖；
- 插件内部自己挂载的 fiber（例如 `provider-llm-echo` 里的 `EchoLlm`）；
- 已注册服务名、实现类、提供方 fiber 与状态；
- 渠道在线状态、网关路由数、实际监听地址。

健康时退出码 0 并打印 `结论：健康`；有插件非 `ACTIVE`、缺 `store/llm/channel/gateway`
任一服务、渠道离线或 host-gateway 没监听时，退出码 1 并逐条列出问题。
插件内部自己挂载的 fiber 失败（例如 echo 里的 `EchoLlm`）也会标出 `FAILED` 与原始报错，
不会因为父插件仍是 `ACTIVE` 而漏诊。

```text
青梅 P1 · doctor
  配置文件  E:\Workflow\qingmei\qingmei.yml
  监听地址  http://127.0.0.1:56031
  插件 fiber（9，来自清单）
    ACTIVE    uid=8    @qingmei/qm-agent  plugin=qm-agent  deps=llm,store,channel,gateway
    ...
  已注册服务（4）
    store     ← SqliteStore   @ provider-store-sqlite (ACTIVE)
  渠道状态（1）
    web       online
结论：健康
```

## 4. smoke

```bash
pnpm smoke            # = node scripts/smoke.mjs
QM_SMOKE_PORT=17412 node scripts/smoke.mjs
QM_TOKEN=xxx node scripts/smoke.mjs     # 清单 token 改过时
```

`scripts/smoke.mjs` 只用 Node 内置模块，自动挑一个空闲端口，完整走一遍人工验收：

1. 启动服务，轮询 `/healthz` 到 200，并断言 `channels` 里有在线的 `web`；
2. 断言无 token 的 `/api/v1/*` 返回 401；
3. 带 `Authorization: Bearer` POST `/api/v1/messages`，内容「你好」；
4. 轮询 GET `/api/v1/messages`，断言本会话恰好 `user`、`assistant` 两条，
   user 文本为「你好」，assistant 回复包含「你好」；
5. 关服、重启，再读同一会话，断言 id 与文本完全一致（持久化）；
6. 退出码 0 = 全绿；任何一步失败打印 `SMOKE FAIL` 与原因，退出码 1。

每次运行用独立会话 id（`smoke-<时间>`），不会把历史库越读越乱。
Windows 上 `child.kill()` 无法投递 SIGTERM，冒烟用强制结束；数据落库是
SQLite 自动提交 + WAL，重启验证已覆盖这一点。

```text
[smoke] 地址：http://127.0.0.1:52043  会话：smoke-mvusah3r
✔ 第一次启动：/healthz 返回 200 — {"ok":true,"uptime":0,"channels":[{"id":"web","online":true}]}
✔ 无 token 请求被拒 — HTTP 401
✔ POST /api/v1/messages — HTTP 200 platformMessageId=msg_0mvusahb9760ww0
✔ 历史已落库（第一次） — user="你好" / assistant="我是青梅，P1 版本先跑通闭环。\n你说：你好"
✔ 服务已关闭
✔ 第二次启动：/healthz 返回 200 — {...}
✔ 重启后历史仍在 — user="你好" / assistant="我是青梅，P1 版本先跑通闭环。\n你说：你好"
SMOKE PASS：healthz → 发消息 → 落库 → 重启持久化，全部通过。
```

## 5. 验收记录（真实执行）

| 命令 | 结果 |
| --- | --- |
| `pnpm install` | 12 个 workspace 工程，Already up to date |
| `node --test` | **52 pass / 0 fail**（45 条包测试 + 7 条新增 server 配置测试） |
| `curl /healthz` | `HTTP 200`，`{"ok":true,...,"channels":[{"id":"web","online":true}]}` |
| `curl -X POST /api/v1/messages`（`--port 17411`，会话 `curl-1793353361`） | `HTTP 200`，`platformMessageId=msg_0mvusaeadp7m4at` |
| `curl GET /api/v1/messages`（第一次） | `HTTP 200`，两条：`user:"你好"`、`assistant:"我是青梅，P1 版本先跑通闭环。\n你说：你好"` |
| 关服重启后再 `curl GET` | `HTTP 200`，**id 与文本和关闭前完全一致** |
| `pnpm smoke` | `SMOKE PASS` |

原始 curl 输出（第一次读回）：

```json
[{"id":"msg_0mvusaeaxm8hn82","session_id":"s_curl-1793353361","role":"user","text":"你好","created_at":1793353362154},
 {"id":"msg_0mvusaeazkhzfvm","session_id":"s_curl-1793353361","role":"assistant","text":"我是青梅，P1 版本先跑通闭环。\n你说：你好","created_at":1793353362155}]
HTTP 200
```

重启后读回同一会话仍是上面两条，id 未变，证明 `data/qm.db` 持久化生效。

## 6. P1 已完成 / 未完成

### 已完成

- [x] `@qingmei/core` 契约：消息/渠道/网关/存储/模型类型、事件名、`uid`/`textOf`/能力降级工具。
- [x] 服务层：`service-store` / `service-llm` 门面，`ChannelHub`（适配器注册、发送、在线状态），`GatewayHub`（路由、事件广播、撤销）。
- [x] `provider-store-sqlite`：`node:sqlite` + 通用 JSON 记录表、WAL、等值过滤/排序/分页、关库钩子。
- [x] `provider-llm-echo`：流式回声模型，8–20 字切片，可中止。
- [x] `qm-agent`：读最近 20 条历史、注入 persona、流式广播、落 user/assistant 两条、回投渠道、同会话串行。
- [x] `host-gateway`：`/healthz`、Bearer 鉴权（含 SSE query token）、静态资源与目录穿越防护、`POST/GET /api/v1/messages`、`/api/v1/events` SSE、网关自定义路由。
- [x] `channel-web`：把出站信封广播到网关事件流。
- [x] 组合根 `apps/server/src/index.ts`：读 YAML、按 name 动态 import、按 inject 等待就绪、打印监听地址/插件/服务/渠道；CLI 可覆盖端口与清单。
- [x] `apps/server/src/cli.ts`：`qm doctor` / `qm serve` / `qm help`，doctor 健康检查退出码。
- [x] `scripts/smoke.mjs`：非默认端口、真实起停、重启持久化断言。
- [x] 全量测试 52 条全绿（含新增的组合根配置/参数测试）。

### 未完成 / 已知边界（P1 范围外）

- [ ] 真实模型提供方（DeepSeek/Ollama 等）；当前只有 echo，无网络与密钥管理。
- [ ] QQ / 飞书 / 邮件渠道；当前只有 `web` 适配器。
- [ ] 身份与会话模型：只有单一静态 Bearer token，没有用户、权限、限流和审计。
- [ ] 记忆体系：只有 persona + 最近 20 条上下文，尚未接 docs/04、docs/09 的事实/巩固/遗忘。
- [ ] 存储索引与迁移：P1 用 `(name,id) + JSON` 单表，过滤排序在 JS 侧；数据量上来需列级索引/迁移。
- [ ] 历史分页：`GET /api/v1/messages` 只返回最近 `limit`（默认 50，上限 200），没有游标。
- [ ] 前端交互验收：`apps/web/public` 的页面只做了静态资源与 SSE 协议验证，没有浏览器端人工点测。
- [ ] 类型检查与 lint：直接靠 Node 类型剥离运行，未引入 `tsc --noEmit` / lint。
- [ ] Windows 优雅停机：外部无法投递 SIGTERM；Ctrl+C 可正常卸载，冒烟走强制结束（已验证数据不丢）。
- [ ] 多进程、热重载、部署（systemd/PM2）、可观测性。

## 7. 本次改动清单

新增：

- `apps/server/src/index.ts` —— 组合根 + `qm serve` 实现。
- `apps/server/src/cli.ts` —— `doctor` / `serve` / `help` 分发。
- `apps/server/test/config.test.ts` —— 清单解析、参数解析、状态名测试（7 条）。
- `scripts/smoke.mjs` —— 端到端冒烟。
- `README-P1.md` —— 本文件。

修改（含别人的文件，均已在上面说明理由）：

- `qingmei.yml` —— 补 5 个插件条目（4 个服务/门面 + `channel-web`），否则依赖链不完整。
- `package.json`（根）—— 增加 `qm` / `serve` / `smoke` 三个脚本；原有 `start` / `dev` / `doctor` / `test` 不变。
- `apps/server/package.json` + `pnpm-lock.yaml` —— 增加 `js-yaml@^5.5.0`，用于读 `qingmei.yml`。
- `packages/provider-llm-echo/test/` 与 `packages/qm-agent/test/` —— 把 `index.js` 入口换成
  `package.json`（`main` 指向测试文件，与 host-gateway 等三个包一致）。原因：`node --test`
  在根目录发现时，`test/index.js` 和 `test/*.test.ts` 都被当成入口，同一个文件跑两遍
  （多出 9 + 7 条重复用例）；改完后 `node --test <目录>` 仍能正常展开，测试数从虚高的 68 回到 52。

未改 `packages/*` 的业务源码与测试断言：所有包测试全部通过，未发现功能 bug。

## 8. 相关文档

- [总体方案](docs/00-总体方案.md)
- [架构总览](docs/01-架构总览.md)
- [落地路线](docs/05-落地路线.md)
- [仓库说明](README.md)
