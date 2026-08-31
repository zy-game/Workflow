# Workflow Desktop

Workflow 的 Tauri 桌面客户端。自有 React UI 直接消费 Workflow Core HTTP API
（不依赖 DSH 的 web 前端壳，也不做老 client 兼容），Core 通过
`WFC_CORS_ORIGINS` 允许本应用的跨域访问。

## 页面

- **登录**：Core 地址 + 账号密码（`client-login`，token 存本地）。
- **任务**：列表/状态过滤/新建，点击行查看任务事件流。
- **项目**：项目列表与 owner 节点。
- **节点**：peer 注册表，撤销/恢复（admin 权限），流游标。
- **同步**：本节点同步全景（签名、中继、收件箱、outbox head），15 秒自刷新。
- **会话**：内嵌 DSH 自带 Web 页面（会话/轨迹/设置等，由 DSH 自己的 web 服务
  托管，本应用只做嵌入不做重写），也可用独立窗口打开。

## 本地开发

```bash
npm install
npm test          # vitest：API client 单测
npm run dev       # 仅前端（浏览器），配合本地 Core 使用
npm run tauri dev # 完整桌面壳（需要 Rust + MSVC Build Tools + WebView2）
npm run tauri build
```

Core 侧需要放行 shell 来源（生产为 Tauri webview 的 origin，
`tauri://localhost`（macOS/Linux）或 `http://tauri.localhost`（Windows）；
浏览器开发为 `http://localhost:5183`）：

```bash
WFC_CORS_ORIGINS=http://tauri.localhost,http://localhost:5183
```

## 构建前提

- Node >= 20
- Rust stable（rustup）+ MSVC Build Tools（Windows）
- WebView2 Runtime（Windows 10/11 自带）

## 结构

```
src/            React 前端（pages/ 页面、lib/api.js Core 客户端、lib/api.test.js）
src-tauri/      Tauri 2 壳（Rust 仅负责窗口/系统集成，不做业务）
```
