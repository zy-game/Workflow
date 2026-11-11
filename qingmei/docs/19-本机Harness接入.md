# 本机 Harness 接入（设备注册 + DSH Host Companion + ACP Worker）

目标：青梅不假设 harness 都在服务器上。每台客户端上报系统/架构、能力和工作区，
任务按设备 + harness + 工作区投递。当前只支持 **DSH**；ZCode 不在本项目范围内。

## 1. 设备注册

`POST /api/v1/devices/register`（Bearer `QM_TOKEN`）

```json
{
  "id": "dev-my-windows",
  "name": "我的 Windows (DSH companion)",
  "platform": "windows",
  "arch": "x64",
  "hostname": "DESKTOP-xxx",
  "harnesses": [{ "kind": "dsh", "acp": true }],
  "workspaces": [
    { "id": "ws-workflow", "title": "Workflow", "path": "E:\\Workflow" }
  ],
  "workerVersion": "dsh-companion/0.1.0"
}
```

- `platform` 是系统类型：`windows|macos|linux|android|ios`。
- 服务端派生 `deviceClass`（desktop/mobile）和 `systemType`，客户端不手填“设备类型”。
- 心跳：`POST /api/v1/devices/heartbeat`，会刷新工作区列表。
- 列表：`GET /api/v1/devices`。

## 2. 任务投递

```text
POST /api/v1/tasks
{
  prompt,
  title,
  target: {
    executorId: "device:<deviceId>",
    workspaceId,
    sessionKey,
    cwd
  }
}

POST /api/v1/devices/claim    { deviceId }
POST /api/v1/devices/progress
POST /api/v1/devices/finish
GET  /api/v1/devices/tasks?deviceId=...
```

`workspaceId` 必须属于设备上报列表；`cwd` 用于校验/回退。任务由 `target.executorId=device:<id>` 选择设备执行器。

## 3. DSH Host Companion

`apps/dsh-companion` 运行在 DSH Host 内：

```text
领当前设备执行器的任务
  → sessionController.create({ cwd, agentPreset: 'standard' })
  → ctx.agents.get(sessionId)
  → workspace.attachSession(sessionId)
  → agent.followup(...)
  → session/event 记录
  → 会话结束 ingest
```

- 使用 `standard` preset，因此文件/命令等完整工具可用。
- 创建出的会话会立即出现在 DSH GUI 的对应工作区。
- 支持记忆回灌：
  ```text
  POST /api/v1/devices/context
  { deviceId, text, limit }
  → 青梅按当前文本从核心记忆召回相关事实
  → companion 注入【青梅记忆】后再 followup
  ```
- 会话结束：
  ```text
  POST /api/v1/devices/ingest
  { deviceId, sessionId, summary, turns, events, facts, lessons }
  ```
- `GET /api/v1/devices/digests` 可读取 turns/events/facts/lessons。
- 失败/空 assistant 输出会标记任务失败，不会假装完成。

## 4. 本机 ACP Worker

`scripts/harness-worker.mjs` 只支持 DSH：

```powershell
pnpm worker -- `
  --server https://139.155.78.241:8710 `
  --token <QM_TOKEN> `
  --device-id dev-my-windows `
  --dsh-command "dsh"
```

- 领取任务后 spawn `dsh --profile acp`，通过 stdio ACP 执行。
- 任务 cwd 使用 `task.cwd`，否则用配置 `workdir`。
- 子 agent 请求权限时落到服务端审批队列（`POST /api/v1/approvals` 建单 + 轮询决定），
  与主路径一致；发不出去或超时按拒绝处理，不静默放行。`--auto-approve true` 才自动批准，
  只应在完全信任的机器上使用。
- 传给 dsh 的环境变量会剔除青梅自己的密钥（`QM_TOKEN` / `QM_ADMIN_PASSWORD` / `QM_LLM_KEY` …），
  只保留 DSH 自己的 `QM_DSH_API_KEY`。
- 本地会话 API：
  ```text
  POST /session/new
  POST /session/prompt (stream=true 返回 SSE)
  POST /session/cancel
  POST /session/close
  GET  /session/state
  POST /session/ingest
  ```
- 模型失败会标记任务 `failed`，不误报 `done`。

## 5. 桌宠自动安装

桌宠启动、保存设置、写 Worker 配置时检测本机 `dsh`，并把：

```text
apps/dsh-companion
apps/dsh-hook
```

安装到：

```text
~/.dsh/profiles/desktop
```

安装内容：

```text
node_modules/@qingmei/dsh-companion
node_modules/@qingmei/dsh-hook
package.json dependencies
dsh.profile.bundles
cordis.patch.yml
```

安装包还包含：

```text
resources/worker/scripts/harness-worker.mjs
resources/worker/packages/provider-dsh-acp/src/acp-client.ts
```

DSH 重启后 companion/hook 生效。

## 6. 已验证

- 设备上报 `systemType/deviceClass/workspaces`
- 任务按 workspaceId 进入 `E:/Workflow`
- DSH GUI 内 standard preset 会话可读文件/命令
- 记忆回灌 `userHasMemory: true`
- 失败任务生成 3 条 lessons
- 412/412 串行测试通过
- 桌宠 0.1.2 安装包已构建并上传

## 7. 任务会话延续

设备任务支持 `target.sessionKey`：

```text
executorId + workspaceId + sessionKey + prompt
```

- 同一 `sessionKey` 下，服务端取该线程上一任务的真实 DSH `sessionId`。
- companion 先用 `sessionController.resolveAgent(sessionId)` 恢复已有会话，恢复失败才新建。
- 新任务会把上一轮摘要和最近 turns 传给 `/api/v1/devices/context`，再做记忆召回。
- 任务完成后 `finish` 回写真实 `sessionId`。

Web 任务页默认用工作区 id 作为 `sessionKey`，所以同一工作区的连续任务会延续同一个 DSH 会话。
## 7. 语音输入与主动推送

### 语音输入

Web/桌宠对话页使用浏览器 `SpeechRecognition`：

- 支持时显示「语音」按钮，识别中文并填入输入框。
- 需要 HTTPS 或 localhost；Electron 已放行 `media` 权限。
- Android WebView 对 Web Speech API 支持不稳定，移动端需要 Capacitor 原生语音插件；
  如果需要离线/隐私，改用本地 Whisper 服务接收 MediaRecorder 音频。

### 主动推送

`qm-autonomy` 的 `notify()` 现在支持路由：

```yaml
qm-autonomy:
  notify:
    work:
      channel: feishu
      conversationId: <飞书 chat_id>
    casual:
      channel: qq
      conversationId: "dm:<openid>"   # 或 group:<group_openid>
    digest:
      channel: feishu
      conversationId: <飞书 chat_id>
```

- 任务/工作类建议走 `work`（飞书）。
- 闲聊/状态/升级提示走 `casual`（QQ）。
- 每日摘要走 `digest`。
- 未配置时自动读取 `qm_channel_target` 里最近一次飞书/QQ 入站会话；没有目标才回退 `web/owner`。

`conversationId` 必须是渠道入站时真实出现过的会话 id；QQ 的 `dm:`/`group:` 前缀不能丢。
## 7. 边界

- 只支持 DSH；ZCode 已从项目移除，不再注册、不安装 hook、不做 DB 同步。
- 手工打开的 DSH 会话由 `dsh-hook` 记录；companion 只覆盖它自己创建的任务会话。
- Host 插件安装依赖 DSH profile 结构，DSH 升级时需回归。
- 干净机器安装启动验证仍未完成。
