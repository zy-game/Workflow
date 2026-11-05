# 本机 Harness 接入（设备注册 + Worker + MCP）

目标：青梅不假设所有 harness 都在自己服务器上。每台客户端上报平台、架构和可用 harness，
任务按设备投递，由本机 worker 拉起对应的 ACP 进程。设备类型是路由依据，不靠猜测。

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
    { "kind": "dsh", "acp": true, "mcp": true },
    { "kind": "zcode", "acp": false, "mcp": true }
  ],
  "workerVersion": "0.1.0"
}
```

- `platform` 接受 `win32`/`windows`、`darwin`/`macos`、`linux`、`android`、`ios`。
- `acp` 表示该设备能通过 ACP 被拉起；`mcp` 表示可用 MCP 工具面。
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

服务端只做队列和账本，不 spawn 远端进程；因此 Windows 上的 DSH/ZCode 由本机 worker 拉起。

## 3. 本机 Worker

Windows 电脑上运行：

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
- 需要 ZCode ACP 时，把 `--zcode-acp-command "zcode-acp-server server"`，并用 `--zcode-bin` 指向 ZCode 的 `zcode.cjs`；
  未验证的 GUI ZCode 不能被 ACP 直接控制。
- 配置默认保存到 `~/.qingmei/worker.json`。
- 本机没有 `dsh` CLI 时，worker 会明确报“没有检测到可用的 dsh/zcode”，不会假装执行。`dsh` CLI 还需要 `DEEPSEEK_API_KEY`（或 DSH 已登录的凭据）；worker 从启动环境继承。

## 4. MCP

生产网关已把 `https://139.155.78.241:8710/mcp` 反代到本机 `7420`。
所有客户端统一使用：

```text
URL:    https://139.155.78.241:8710/mcp
Header: Authorization: Bearer <QM_MCP_TOKEN>
```

ZCode 用户配置：`~/.zcode/cli/config.json` 的 `mcp.servers`。
DSH 用户配置：项目根 `.agents/mcp.json`，并安装 MCP 客户端插件：`dsh plugin --profile web add dsh-mcp-autoload`（`acp` profile 同理）。
桌面设置页的“配置 ZCode / 配置 DSH”按钮会写入这两份配置，并同步 `~/.agents/mcp.json`。

## 5. 已验证

- Windows worker + 本机 `dsh --profile acp`：任务 `done:OK`。
- DSH `acp` profile + `dsh-mcp-autoload` + 项目 `.agents/mcp.json`：模型实际调用 `mcp__qingmei__memory_recall`，结果 `MCP_OK`。
- ZCode：安装 `zcode-acp-server` 后 worker 可启动 ACP；必须同时配 `ZCODE_BIN`（桌面版 `zcode.cjs`）和 `ZCODE_NODE`（支持 `node:sqlite` 的 Node）。实测已领任务并启动 ZCode 后端；当前 Start Plan 需要桌面验证码，需换 GLM Coding Plan 或桌面登录。

## 6. 边界

- ACP 是客户端 spawn 子进程的 stdio 协议，**不能连接已经运行的 GUI ZCode/DSH 窗口**。
- 要控制本机 GUI 客户端，必须有本机 worker/插件；当前 worker 支持 CLI/ACP bridge，不支持屏幕控制。
- 每个设备必须上报真实 `platform` 和 `harnesses`；没有设备记录时任务不能投递。
