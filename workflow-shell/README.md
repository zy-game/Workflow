# Workflow 桌面壳

服务器托管控制台的桌面外壳。它**不另做界面**——加载 `<服务器>/console`，
只补上浏览器做不到的能力。

## 它加什么

| 能力 | 为什么必须壳来做 |
| --- | --- |
| `powerMonitor` 系统空闲时长 | 窗口可见 ≠ 人在，只有操作系统知道有没有真按键 |
| 原生通知 | 标签页关了就发不出来 |
| 后台常驻 | 主动型助理必须一直活着 |
| 本地执行器监管 | 让本机成为执行节点，凭据只存本地 |

## 运行

```bash
npm install
WORKFLOW_SERVER_URL=https://<core>:8710 npm start
```

界面本身就是控制台，登录后它会在加载、可见性/焦点变化、以及每 30 秒
上报一次在场状态（空闲桶来自操作系统，不是页面焦点）。

## 成为执行节点

外壳监管本机的 Worker 进程。配置方式：

```bash
WORKFLOW_WORKER_TOKEN=<core 签发的 worker 令牌> \
WORKFLOW_NODE_BIN=/path/to/node \
npm start
```

- 令牌用**操作系统凭据存储**封存（Keychain / DPAPI / libsecret），不经
  preload 桥、不落可读文件；环境变量优先，所以重新配置不会悄悄沿用旧令牌
- 令牌由 Core 按 **worker 主体**签发，外壳会显示它将使用的 worker id
  （默认 `worker-<主机名>`），照它签发即可
- **必须指定真实 Node**：Electron 内置的 Node 没有 `node:sqlite`，Worker 需要它。
  `WORKFLOW_NODE_BIN` 缺省为 PATH 上的 `node`

## 打包

```bash
npm run build     # 产出 dist/Workflow Setup <version>.exe
```

安装包会把 `workflow-core` 的源码与依赖作为资源一并带上，因为外壳要监管
其中的 Worker。打包后 `WORKER_ENTRY` 从 `process.resourcesPath` 解析。

打包关闭了原生模块重编译（`npmRebuild: false`）：外壳没有原生依赖，
而重编译会拉进一套与本项目无关的工具链。

## 安全边界

preload 只暴露四项能力：`idleBucket`、`notify`、`serverUrl`、`platform`。
文件、进程、凭据、环境变量都不在桥接面上；窗口是 sandbox + contextIsolation，
外链交给系统浏览器。测试会断言这些边界。
