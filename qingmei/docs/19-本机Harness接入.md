# 本机 Harness 接入（设备注册 + Worker + ACP）

目标：青梅不假设所有 harness 都在自己服务器上。每台客户端上报平台、架构和可用 harness，
任务按设备投递，由本机 worker 拉起 ACP 会话。主路径不再使用 MCP。

## 1. 设备注册

`POST /api/v1/devices/register`（Bearer `QM_TOKEN`）

```json
{
  "id": "dev-my-windows",
  "name": "我的 Windows",
  "platform": "windows",
  "arch": "x64",
  "hostname": "DESKTOP-xxx",
  "harnesses": [
    { "kind": "dsh", "acp": true },
    { "kind": "zcode", "acp": true }
  ],
  "workerVersion": "0.1.0"
}
```

- `platform` 接受 `win32`/`windows`、`darwin`/`macos`、`linux`、`android`、`ios`。
- 心跳：`POST /api/v1/devices/heartbeat`。
- 列表：`GET /api/v1/devices`。

## 2. 任务投递

```text
POST /api/v1/devices/tasks     { deviceId, prompt, title, harness }
POST /api/v1/devices/claim     { deviceId }
POST /api/v1/devices/progress  { taskId, phase, percent, note }
POST /api/v1/devices/finish    { taskId, status: done|failed, result|error }
GET  /api/v1/devices/tasks?deviceId=...
```

服务端只做队列和账本，不 spawn 远端进程；Windows 上的 DSH/ZCode 由本机 worker 拉起。

## 3. 本机 Worker

```powershell
cd E:\Workflow\qingmei
pnpm worker -- `
  --server https://139.155.78.241:8710 `
  --token <QM_TOKEN> `
  --device-id dev-my-windows `
  --dsh-command "dsh"
```

- 自动检测 `dsh`/`zcode` 命令，注册 `platform=process.platform`。
- 每 3 秒领取任务；用 `AcpClient` 启动 `dsh --profile acp`。
- ZCode：`--zcode-acp-command "zcode-acp-server server"`，并用 `--zcode-bin`、`--zcode-node` 指向 ZCode CLI 和 Node。
- 配置默认保存到 `~/.qingmei/worker.json`。
- 本机没有对应 CLI 时，worker 会明确报错，不会假装执行。

## 4. 本地会话 API

worker 默认监听 `127.0.0.1:7431`（`--port` 可改）；`--zcode-sync` 会让 worker 每 60 秒跑一次 ZCode DB 补偿同步。

```text
POST /session/new    { harness, cwd } -> { sessionId }
POST /session/prompt { sessionId, text, stream? } -> output/turns/events；stream=true 时返回 SSE
GET  /session/state?sessionId=...
POST /session/cancel { sessionId }
POST /session/close { sessionId }
POST /session/ingest { sessionId, summary, turns, facts, lessons }
```

实测：`session/new` -> `session/prompt` 返回 `output:"OK"`，turns/events 都有记录。prompt 前会调用青梅 `GET /api/v1/memory?q=` 注入记忆；`/session/close` 会把 turns 上报 `/api/v1/devices/ingest`；服务端在有 LLM/memory 时会提炼事实并写记忆，否则只落 digest。

## 5. ACP 会话

worker 作为 ACP client：

```text
spawn dsh --profile acp / zcode-acp-server server
  → initialize
  → session/new
  → session/prompt
  → session/update
  → session/close
```

当前 worker 是单任务模式；多轮持久会话、turn recorder、GUI 直连和会话提炼是下一阶段。

## 6. 已验证

- Windows worker + 本机 `dsh --profile acp`：任务 `done:OK`。
- Windows worker + `zcode-acp-server`：任务已领取并启动 ZCode 后端；当前 Start Plan 需要桌面验证码。
- 设备注册/入队/领取/完成 API 已生产验证。

## 7. 手工会话 Hook 状态

`apps/dsh-hook` 已实现 `session/event` 监听，并通过 npm tarball 安装进 DSH `web/acp` profile；实测手动/ACP 会话结束会生成 `~/.qingmei/sessions/*.json`，包含 user/assistant/tool turns。ZCode 侧新增 `apps/zcode-hook/hook.mjs` 作为 Stop hook；另有 `scripts/zcode-session-sync.mjs` 直接读 `~/.zcode/cli/db/db.sqlite` 的 session/message/part 做增量补偿（每次最多 5 个会话，状态在 `~/.qingmei/zcode-sync.json`）。

## 8. 生产状态

- 设备/ingest 路由已部署，`/api/v1/devices/ingest` 返回 200。
- MCP 端口/反代/插件不在生产。
- DSH hook 以 npm tarball 安装到 `web/acp`；ZCode Stop hook 已写入 `~/.zcode/cli/config.json`。
- Web 任务页新增「本机设备任务」，可选目标设备并调用 `/api/v1/devices/tasks`；对应 Vue 构建产物已同步到生产 static。

## 9. 边界

- ACP 是客户端 spawn 子进程的 stdio 协议，**不能连接已经运行的 GUI ZCode/DSH 窗口**。
- 要控制本机 GUI 客户端，必须有本机 worker/插件；当前 worker 不支持屏幕控制。
- 每个设备必须上报真实 `platform` 和 `harnesses`；没有设备记录时任务不能投递。
- 不再部署 MCP：无 `host-mcp`、无 `/mcp` 反代、无 DSH MCP 插件。
