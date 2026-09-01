# Workflow × DSH Desktop

Workflow 的 Electron 桌面壳：一个窗口里同时跑 **Workflow Core**（任务编排/
对等同步引擎）和 **DSH Web**（AI 会话界面，含 Workflow 原生插件——侧边栏菜单、
主工作区页面、登录门禁）。退出即全部关闭。

```
Electron main
 ├── Workflow Core (child, :8710)   —— 任务/项目/节点/同步 API + peer 同步
 └── DSH Web       (child, :8333)   —— DSH 原生会话 UI + @workflow/dsh-web 插件
      └── BrowserWindow 加载 http://127.0.0.1:8333
```

## 开发运行

前置：本仓库已 `npm install`（workflow-core 与 dsh-workflow 各自装好依赖）。

```bash
cd dsh-desktop
npm install
npm start          # 启动 Electron 壳
```

首次启动会自动：
1. 在 `%APPDATA%/workflow-dsh-desktop/dsh-profile-web` 创建 DSH web profile
   并安装/注册 `@workflow/dsh-web` 插件；
2. 在 `.../core-data` 创建 Workflow Core 数据目录；
3. 拉起两个子进程，等端口就绪后开窗口。

登录：Workflow 插件的开机门禁使用 Workflow Core 账号；首次运行前请在本机 Core 管理流程中创建账号，登录状态会持久化。

## 打包

```bash
npm run build      # electron-builder -> NSIS 安装包（dist/）
```

打包把 workflow-core 源码与 DSH 插件收进 resources；目标机器不需要
预装 Node（Electron 自带运行时）。

## 端口

- `WFC_HTTPS_PORT`（默认 8710）：Workflow Core
- `DSH_WEB_PORT`（默认 8333）：DSH Web

## 与其他入口的关系

- **DSH Web 集成插件**（`dsh-workflow/web/@workflow/dsh-web`）：本壳内嵌的
  同一套插件；在已有 DSH web 的节点上可单独部署（见其 README）。
- **Tauri 壳**（`workflow-desktop/`）：纯 Workflow 管理界面、无 DSH；保留作
  无 DSH 环境的备用入口。
