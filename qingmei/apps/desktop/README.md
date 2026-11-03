# 青梅桌面宿主（桌宠）

![桌宠预览](docs/pet-preview.png)

Electron 透明置顶小窗：一只青梅坐在桌面角落，服务器发来的任何通知都会变成它头顶的气泡；
点它聊天、右键菜单、顶部拖动条移动窗口，窗口透明区域点击穿透。

## 运行

```bash
cd qingmei
pnpm install
pnpm --filter @qingmei/desktop start
```

首次启动会弹设置：

- **服务器地址**：生产用 `https://139.155.78.241:8710`（nginx）；本机服务用 `http://127.0.0.1:7410`
- **访问令牌**：和 Web 面板同一个 `QM_TOKEN`

也可以用环境变量跳过首次输入：

```bash
QM_SERVER_URL=https://139.155.78.241:8710 QM_TOKEN=... pnpm --filter @qingmei/desktop start
```

令牌优先用 Electron 的 `safeStorage`（Windows DPAPI）加密存到用户数据目录；系统不支持时退化为明文，
README 与设置页都明确写了这一点。

## 交互

| 操作 | 效果 |
| --- | --- |
| 单击桌宠 | 随机播一个点击回应 GIF，冒一句台词，偶尔掉爱心 |
| 双击桌宠 | 喂饭：吃白饭 GIF + 爱心 + 台词 |
| 右键桌宠 | 摸摸头 / 喂饭 / 逗一下 / 聊聊天 / 设置 / 重新连接 / 躲起来 / 退出 |
| 💬 按钮 | 开/关聊天面板 |
| 顶部小横条拖动 | 移动窗口，位置会记住；拖整只也可以 |
| 头顶气泡 | 显示服务器通知；点击气泡直接打开聊天；× 关闭，+N 表示排队条数 |
| 聊天输入 | 回车发送，消息走 `POST /api/v1/messages`，回复走 SSE 实时显示 |
| 闲置 20 秒 | 35% 概率自己找个乐子（照镜子 / 蓝鲸 / 玩水枪），否则换待机动作 |
| 闲置 90 秒 | 打盹，动一下或点它醒来 |
| 透明区域 | 点击穿透到桌面；只有桌宠/气泡/聊天/设置区域接收鼠标 |

## 通知来源

订阅 `GET /api/v1/events?token=...`，映射规则在 `renderer/core.mjs`：

- `assistant`：所有回复与主动消息（提醒、督促、复盘、周报等）→ 普通气泡
- `approval-requested`：审批待确认 → 审批气泡
- `task-finished` 且失败 → 故障气泡

`delta` 等流式事件不进气泡，避免刷屏。

## 打包

```bash
pnpm --filter @qingmei/desktop dist
```

产物在 `apps/desktop/dist/`（NSIS 安装包）。打包依赖 `electron-builder`，首次会下载 Windows 构建工具。

## 测试

```bash
node --test apps/desktop/test
```

覆盖 SSE 分块解析、事件转气泡、气泡队列过期、地址/令牌编码、历史映射，以及窗口参数、
preload 最小面、界面元素、点击穿透与协议契约。

## 常见问题

- **启动后没有窗口**：确认不是从设置了 ELECTRON_RUN_AS_NODE=1 的终端启动（这会让 Electron 以 Node 模式运行）。
- **electron/dist 不存在**：pnpm install 跳过了 Electron 的下载脚本时，执行 
ode apps/desktop/node_modules/electron/install.js（国内可先设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）。

## 素材与许可

桌宠动画取自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT），经 [shenliuyu18/dafeiyu-pet](https://github.com/shenliuyu18/dafeiyu-pet) 使用；
以官方透明 GIF 播放（220×124）；为避免抖动不再叠加 CSS 缩放/倾斜动画。许可全文见 enderer/assets/THIRD-PARTY-dsh-pet-LICENSE.txt。

## 已知限制

- 没有托盘图标：退出走桌宠右键菜单（需要托盘可以后续加）。
- 没有开机自启与安装向导；打包后需手动勾选。
- 透明窗口在部分 Windows 远程桌面/无交互会话下无法显示（Electron 需要交互式桌面）。
- 气泡只显示文本，不渲染 Markdown；长消息可在聊天面板看全文。
- 点击穿透依赖 `setIgnoreMouseEvents(..., { forward: true })`，Windows 支持最好。
