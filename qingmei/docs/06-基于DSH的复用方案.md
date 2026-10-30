# 06 · 基于 DeepSeek Harness 的复用方案

> **状态：已被 [07 · Harness 协作协议](07-Harness协作协议.md) 取代。**
> 青梅保持独立部署，DSH 只是它可调度的一个 harness，而不是底座。
> 本文保留的价值是事实核对：DSH 的包清单与许可、`--profile acp` 的自动化形态、插件市场与部署模型。
> 其中「青梅作为 DSH bundle」的路径不再采用。

> 本文回答三个问题：能不能用 DSH 做底座、能省掉哪些轮子、哪些轮子仍然得自己造。
> 结论会修订前五篇文档中的拓扑与路线，修订点见第 8 节。

## 1. 结论先行

**能，而且建议这么做。** 但不是「青梅 = DSH 的一个插件」这么简单的一句话，而是分两层：

```text
DSH 提供：内核 + 编排 + 会话 + 工具 + 模型 + 权限 + Web 宿主 + 插件分发
青梅提供：渠道接入 + 人格 + 记忆 + 主动触达 + 个人数据模型
```

推荐路径：**先用「bundle 插件」形态验证两周，再决定是否升级为「自己的 profile 分发」**。
理由在第 4 节，两件事的成本差一个数量级。

## 2. 事实核对：DSH 实际是什么

不是文档印象，是 npm 元数据（`@deepseek-ai/dsh@0.2.1-rc.5`）与本机安装包给出的事实。

| 事实 | 证据 |
| --- | --- |
| 许可证 MIT，可商用、可修改、可再分发 | npm `license: MIT`；安装包内 `DeepSeek-Harness-MIT.txt` |
| 以 80+ 个 npm 包公开，不是闭源二进制 | registry 依赖树：`dsh-agent-loop`、`dsh-session`、`dsh-tools`、`dsh-web-app`、`dsh-persona`… |
| 内核是自己 fork 的 Cordis 4 | `@deepseek-ai/cordis@~4.0.5` |
| 插件 = bundle（`package.json` 里 `dsh.bundle`），可带客户端 UI | 插件市场文档 + `dsh.client.platform: web` |
| 有正式的插件市场（JSON 索引，npm/git 源，`engines.dsh` 兼容检查） | [插件市场文档](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market) |
| 可部署到服务器：反向代理 + `--public-url` + `--trusted-host` + 自带 TLS | [公开部署文档](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments) |
| 有 Schedule 服务与自动化任务页 | [Schedule 文档](https://deepseek-harness.github.io/deepseek-harness/guide/schedule) |
| 记忆靠外挂 MCP，不是内置 | [记忆 MCP 文档](https://deepseek-harness.github.io/deepseek-harness/guide/mcp-memory) |

可直接复用的能力包（按青梅的视角）：

| DSH 包 | 给青梅省掉的工作 |
| --- | --- |
| `dsh-agent-loop` / `dsh-agent` | 上下文组装、工具循环、压缩、超时、子 agent 委派 |
| `dsh-tools` + `dsh-tool-*` | 工具注册表、参数校验、审批、结果呈现 |
| `dsh-llm` + `dsh-llm-deepseek` + `dsh-llm-*` | 模型适配、账号/密钥、重试 |
| `dsh-session` + `dsh-session-persistence-jsonl` | 会话、转录、恢复、分叉 |
| `dsh-persona` + `dsh-system-prompt` | 人格注入与系统提示组装 |
| `dsh-skill` + `dsh-skill-filesystem` | 渐进式技能加载 |
| `dsh-schedule` + `dsh-tool-schedule` | 定时、时区、错过补投、运行记录 |
| `dsh-user-approval` | 工具调用的确认流 |
| `dsh-host-webserver` + `dsh-web-app` + `dsh-client-ui-*` | Web 宿主、SSE、客户端插件位 |
| `dsh-plugin-manager` + 市场 | 安装/升级/兼容性检查 |
| `dsh-sandbox-*` / `dsh-fs-*` / `dsh-pwsh-*` | 文件与命令的权限边界 |

这些恰好是第 [01](01-架构总览.md)–[03](03-渠道与宿主.md) 篇里最费工的「编排层 + 传输层」。

## 3. DSH 不是什么：仍然要自己造的轮子

| 青梅需要 | DSH 现状 | 结论 |
| --- | --- | --- |
| QQ / 飞书渠道 | **没有**任何 IM 渠道包 | 自研 `channel-onebot` / `channel-feishu`，工作量最大 |
| 统一消息抽象（`InboundMessage` / `Block`） | 会话是「工作区里的编码会话」，无渠道抽象 | 自研轻量适配层，向 DSH 的会话 API 投递 |
| 记忆 L0–L3（抽取、冲突、遗忘、敏感度） | 只有 MCP 外挂（无 embedding、无冲突消解、无遗忘策略） | 自研 Cordis service，MCP 只作可选备份 |
| 主动触达与打扰预算 | Schedule 只负责「到点提醒进会话」，不管「发到哪个渠道、要不要打扰」 | 自研 `qm-proactive` + `notify` |
| 多用户（家人共用） | 单个进程凭据（启动 token → 会话 cookie），本质单用户 | v1 接受单用户；多人要改认证层 |
| 移动端 / watch | 只有浏览器访问 Web UI；无原生移动端 | 手机用浏览器访问（能否装成 PWA 需验证）；watch 不跑 DSH |
| 无工作区的「生活对话」 | 没选工作区时输入框不可用 | 需要改会话启动路径，或造一个「生活」虚拟工作区 |
| 隐私分级路由（secret 不出网） | 有模型选择，无数据敏感度概念 | 自研，且要接进 DSH 的模型路由 |

**注意最后两条**：这是产品形态上的根本摩擦，不是工程量问题。
DSH 的心智模型是「你有一个代码仓库，让 agent 去改」；青梅的心智模型是「随时说一句话，它记得你」。
这两种形态可以在同一个进程里共存，但不能指望 DSH 的默认 UX 自动变成后者。

## 4. 三种姿态

| 维度 | A. 纯插件（青梅 = DSH bundle） | B. 二次开发（自己的 profile + 复用 dsh-* 包） | C. 自研（只借 Cordis） |
| --- | --- | --- | --- |
| 起步时间 | 2 周能跑通 | 4–6 周 | 10–12 周（前五篇的估算） |
| 复用程度 | 内核 + 编排 + 宿主 + 市场，几乎全部 | 同上，但可替换 UI 与 preset | 仅内核 |
| UX 契合度 | 低：仍然像编码工具 | 中高：可换成助手形态 | 高 |
| 升级风险 | 跟随 DSH 版本走 | 中：契约测试兜底 | 无 |
| 分发方式 | 插件市场一个 bundle | 独立安装包 / 自己的 profile | 完全自研 |
| 适合 | 快速验证、自用 | 产品化 | 脱离 DSH 生态 |

**推荐：A 起步，B 收敛。**

- A 阶段只验证一件事：**渠道消息能不能可靠地驱动 DSH 会话，并把回复发回去。**
  能，则说明底座选对了；不能，则尽早退到 B 或 C，别在插件层硬撑。
- B 阶段的标志是：你开始需要「打开就是对话，不需要选工作区」「家人也能登录」「手机上像个 App」——
  这三件事在 A 阶段都做不到，必须动 profile 与前端。

C 只在一种情况下选：你要的助理与编码 agent 完全无关，且不接受 DSH 的版本节奏。
目前看没必要——省下来的 8 周足够做渠道和记忆。

## 5. 复用映射：青梅的 13 个服务怎么办

| 青梅服务 | 落地方式 |
| --- | --- |
| `llm` | **直接用** `dsh-llm`，青梅只加一个「敏感度 → provider」的路由插件 |
| `tools` | **直接用** `dsh-tools`；青梅的工具按 DSH 的 `defineTool` 写 |
| `persona` | **直接用** `dsh-persona`，青梅写人格包（YAML/Markdown） |
| `schedule` | **直接用** `dsh-schedule`；`qm-proactive` 作为它的消费者 |
| `skills` | **直接用** `dsh-skill-filesystem`，技能包格式沿用 |
| `store` | **自研**：DSH 的存储是会话转录（JSONL），不是通用业务库；青梅要 SQLite |
| `memory` | **自研** Cordis service（L0–L3），可选把 MCP 记忆服务当第二副本 |
| `channel` | **自研**：唯一没有现成包、且必须做的部分 |
| `identity` | **自研**：QQ/飞书 id ↔ actor 的映射与绑定 |
| `permission` | **部分复用**：工具审批用 `dsh-user-approval`；「群里能不能读日程」这类策略自研 |
| `audit` | **自研**（DSH 有日志，但不满足审计语义） |
| `notify` | **自研**：DSH 没有跨渠道触达概念 |
| `gateway` | **直接用** `dsh-host-webserver`；青梅的 REST 端点作为它的路由插件挂上去 |

一句话：**DSH 覆盖「agent 怎么想、怎么调工具、怎么被看到」；青梅覆盖「消息从哪来、记得住什么、什么时候该说话」。**

## 6. 必须先验证的三个假设（两周 spike）

不要先写业务。先写一个最小 bundle，验证下面三件事，每件都有明确失败退路。

| # | 假设 | 验证方法 | 失败退路 |
| --- | --- | --- | --- |
| H1 | 插件能把一条外部消息投递进 DSH 会话，并把回复取出来 | 写一个假渠道插件：收到 HTTP POST 就创建/恢复会话、注入用户消息、监听 assistant 消息并回写 | 退到 B：用 DSH 的 SDK（`dsh-sdk-app` / headless）在进程外驱动 |
| H2 | 客户端能加一个「青梅」入口（tab 或页面） | 照 `workflow-dsh` 的做法：`dsh.bundle.patch` + `dsh.client.platform: web`，加一个只读面板 | 退到「只做服务端 + 独立 Web 前端」，放弃 DSH 内置 UI |
| H3 | 反代 + 多设备登录体验可接受 | 部署到服务器，手机浏览器打开，验证 cookie、WebSocket、PWA 安装 | 退到 B：自建认证与前端壳（Electron/Capacitor） |

spike 只做这三件事，**不做**记忆、不做人格、不做 QQ。三件都过，再进 M1。

## 7. 修订后的部署形态

```text
                 ┌──────────────── 服务器 ────────────────┐
  手机浏览器/PWA  │  dsh --profile qingmei --public-url ... │  PC 浏览器
  ───────────────▶│  ├─ dsh-web-app（宿主 UI + SSE）        │◀───────────────
                 │  ├─ qm-bundle（渠道/记忆/人格/主动）      │
  飞书 ◀─长连接──▶│  ├─ channel-feishu                     │
  QQ   ◀─反向WS──▶│  ├─ channel-onebot                     │
                 │  └─ SQLite（data/qm.db）                │
                 └────────────────────────────────────────┘
  watch：不跑 DSH。只做「通知 + 一条语音/快捷指令 → 调 HTTP 接口」
```

关键点：

- **服务器只跑一个进程**（`dsh --profile web`），反向代理负责 TLS 与主机名，渠道全部走**出站连接**（飞书长连接、OneBot 反向 WS），不需要公网入站端口。
- **客户端不是「安装 DSH」**，而是浏览器访问；PC 可以再套一层 Electron 壳（DSH 自己就是这么发布的）。
- **watch 不要试图装 DSH**：表盘上跑不了对话式 UI。可行的最小形态是系统通知 + 一个快捷指令打到网关。

## 8. 对前五篇文档的修订

| 文档 | 修订 |
| --- | --- |
| [01 架构总览](01-架构总览.md) §3 分层 | 编排层与传输层改由 DSH 提供；青梅只保留渠道适配、记忆、主动触达、个人数据 |
| [01](01-架构总览.md) §10 拓扑 | 「B 家庭常驻」升级为默认形态，并明确 `dsh --profile web` + 反代 |
| [02 服务契约](02-服务契约.md) | `llm`/`tools`/`persona`/`schedule`/`skills`/`gateway` 不再需要自己定义，改为适配 DSH 的既有接口；只剩 `store`/`memory`/`channel`/`identity`/`permission`/`audit`/`notify` 七个自研服务 |
| [03 渠道与宿主](03-渠道与宿主.md) §9 | 宿主 = DSH Web App（优先）+ Electron 壳 + 手机浏览器；Capacitor 降为备选 |
| [04 记忆](04-记忆数据与隐私.md) | 不变。DSH 的 MCP 记忆只作可选副本，主记忆仍是自研 SQLite |
| [05 路线](05-落地路线.md) | M0 改为「spike + bundle 骨架」，工期从 1.5 周改为 2 周；M4 宿主缩水为「PWA + Electron 壳」 |

## 9. DSH 特有的风险

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 版本仍在 rc（0.2.1-rc.5） | 包之间版本强绑定，破坏性变更频繁 | 锁版本 + `engines.dsh` 声明 + 契约测试；升级前跑 spike 的三条假设 |
| 上游 agent 行为变化 | 人格、工具选择、压缩策略可能随版本变 | 人格包与回归用例入库，升级后重跑 |
| 供应链 | 依赖 DeepSeek 的 npm 发布节奏与可用性 | 私有 registry 镜像 + 离线安装包 |
| 许可与品牌 | MIT 允许修改与再分发，但须保留版权与许可声明；不得暗示官方背书 | 分发时附 LICENSE；产品名与 DSH 明确区分 |
| 数据位置 | DSH 用 `$DSH_HOME`，青梅用 `data/` | 明确两个目录的职责，备份覆盖两者 |
| 单用户认证 | 启动 token 即凭据，泄露等于全权 | 反代 + HTTPS；token 只走首链；后续换 OIDC |

## 10. 下一步

1. 两周 spike：H1/H2/H3 各一个最小验证，产出三份结论（可行 / 需改造 / 不可行）。
2. 若 H1 通过：把 [02](02-服务契约.md) 的自研服务收缩到 7 个，重写 M0–M2 的任务清单。
3. 若 H2 失败：直接进 B 形态，用 `dsh-sdk-app` 或 headless 在进程外驱动，前端自己写。
4. 无论哪条路，**QQ/飞书渠道和记忆服务都要写**——这两块是青梅的真正价值，不是胶水。
