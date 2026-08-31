# Workflow × DSH Web 集成

把 Workflow 的任务/项目/节点/同步页面**长在 DSH 自带的网页里**：在 DSH web
界面上注入一个浮动的「⚙ Workflow」按钮，点开即全屏使用 Workflow 应用
（同源代理，无跨域、无需单独记地址）。

```
浏览器 ── DSH web（原页面 + 注入按钮）
              │ /workflow/* 同源代理（workflow-web.mjs）
              ▼
        Workflow Core :8710（自带完整 Web 应用）
```

## 组成

| 文件 | 角色 |
| --- | --- |
| `workflow-web.mjs` | DSH host 插件：注册 `/workflow/client.js`（按钮脚本）、`/workflow/*`（→ Core 同源代理）、向 index.html 注入脚本标签 |
| `workflow-client.js` | 按钮脚本（纯 DOM，零依赖）：浮动按钮 + 全屏 iframe 面板 |
| `@workflow/dsh-web/` | （实验）原生客户端插件包：`sidebar.footer.action` 菜单按钮 + `shell.overlay` 全屏页面，走 DSH 模块系统的一等公民路径 |

## 安装（在有 DSH web 的机器上）

1. 复制两个文件到 DSH 插件目录：

```bash
cp web/workflow-web.mjs      /home/ubuntu/.dsh/plugins/
cp web/workflow-client.js    /home/ubuntu/.dsh/plugins/
```

2. 在 `server-patch.yml` 追加（文件尾部有现成注释块，取消注释即可）：

```yaml
- insert:
    - id: workflow-web
      name: 'file:///home/ubuntu/.dsh/plugins/workflow-web.mjs'
      config:
        coreUrl: 'http://127.0.0.1:8710'
        clientScript: '/home/ubuntu/.dsh/plugins/workflow-client.js'
```

3. 重启 DSH web。打开 DSH 网页，右下角出现「⚙ Workflow」按钮即成功；
   点击进入全屏 Workflow 应用，登录一次即可。

Core 侧无需任何配置（`/workflow/*` 经 DSH host 同源代理转发，
`WFC_CORS_ORIGINS` 不需要包含 DSH origin）。

## 验证

- 单元测试：`npm test`（dsh-workflow）覆盖路由注册、index 注入幂等、
  `/workflow` 前缀到 Core 的路径映射与真实 HTTP 对拍、按钮脚本托管。
- 端到端：在有 DSH web 的机器上按上述安装后，浏览器确认按钮出现、
  打开后 iframe 内能完成登录并列出任务。

## 说明与边界

- `workflow-web.mjs` 只使用 DSH host 公开服务（`webServer.register` /
  `tapIndex`），不触碰 DSH 内部结构。
- `@workflow/dsh-web/`（原生侧边栏菜单）依赖 DSH 模块系统的包发现约定
  （`dsh.client.platform: "web"` + `exports["./client"]`），RC.2 下需在真实
  DSH host 上验证一次加载链路后作为后续增强启用。
- 首次打开会停留在 Workflow 登录页（token 存在 DSH origin 的
  localStorage 里），登录一次后保持。
