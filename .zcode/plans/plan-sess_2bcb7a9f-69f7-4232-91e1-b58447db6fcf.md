# Workflow 精简、同步与逐轮知识提取计划

## 最终边界

Workflow 保留三个能力：

1. `/workflow` 是唯一技能入口和动态编排器。
2. Web 是纯只读信息查看器，只展示项目、索引、项目记忆、全局知识和技能库。
3. 每轮对话结束时主动识别知识，直接进入记忆候选/写入流程，不建立 Workflow session。

彻底移除 Workflow 自有 session 概念：不再有会话列表、会话续聊、会话摘要、当前会话指针、session ID 绑定、session 事件日志或 session 存储。

## 1. 完全移除 Session 与复杂 Web 功能

- 删除 `scripts/session.js` 及其在 `SKILL.md`、其他脚本和文档中的全部调用。
- 删除 dashboard 的会话、聊天、远程控制、轮询和队列接口：`/api/sessions`、`/api/session-detail`、`/api/workflow-chat`、`/api/chat-poll`。
- 删除前端会话列表、聊天框、轮询定时器、续聊状态及对应样式。
- 盘点后删除 `~/.agents/workflow/projects/*/sessions/`、`.current-session.json` 与 `chat-queue.json`；这些内容不迁移到新架构。
- 从 path API 中删除 `sessionsDir()` 等不再使用的路径定义。
- 从优化统计中删除依赖 session/signal 事件的旧字段，改为直接统计记忆候选结果。

## 2. 将 Web 收敛为本地只读查看器

### 服务端

重构 `scripts/dashboard.js`：

- 保留项目列表、项目详情、索引状态、符号统计、索引搜索、文件依赖查询、项目记忆、全局知识、全局概况和技能库接口。
- 删除不准确的圆环/启发式图谱，改为真实索引摘要、符号分布和选定文件的依赖列表。
- 移除拼接查询参数的 `execSync`；复用索引和记忆模块的导出函数，并对 cwd、query、file 参数做严格校验。
- GET 请求不得创建目录、索引或记忆文件；缺失时返回明确状态。
- 仅监听 `127.0.0.1`，不开放宽泛 CORS。

### 前端

- 导航只保留：概览、项目、全局知识、技能库。
- 项目详情展示类型、索引时间/规模、语言与符号分布、依赖查询、代码搜索和项目记忆。
- 全局知识展示类型、标签、来源、状态与同步状态。
- 技能库只读展示家族、来源、版本和同步状态。
- 修复项目详情导航、未索引状态、HTML 转义、空数据与错误展示。

## 3. 新增知识与技能网络同步

实现后端无关的同步对象模型，并以私有 Git 仓库作为 v1 provider。首次验证只使用本地 bare Git 仓库，不向外部服务发布数据。

### 存储和清单

- 新增 `scripts/sync.js` 和 `~/.agents/workflow/sync/` 独立工作区。
- manifest 记录 schema、对象 ID、相对路径、类型、哈希；技能额外记录 `sourceUrl`、`requestedRef`、`resolvedCommit` 和 `contentHash`。
- 全局知识 Markdown 是权威内容，`index.yaml` 在导入后重建，不参与逐行合并。
- 技能清单使用相对路径，不同步当前注册表中的 Windows 绝对路径。
- 拉取采用暂存、校验、原子替换、重建索引；失败保留当前版本并输出冲突报告。

### 默认范围

同步：

- 全局知识 Markdown。
- Workflow 管理的技能包和可移植技能清单。
- 可共享的 Workflow 规则/参考资料版本。

永不同步：

- `settings/**`、认证信息、cookies、token、SSH 配置、`.env*`。
- 已移除的 session/chat 数据、跟踪原始对话内容。
- 项目注册表绝对路径、本地代码索引、缓存、日志、截图、附件。
- 项目记忆、attention 和 roadmap，除非以后增加显式项目 allowlist。

### 命令

- `sync init --backend git --remote <url> --branch <branch>`
- `sync status`
- `sync pull`
- `sync push`
- `sync validate`
- `sync conflicts`
- `sync resolve --id <id> --use local|remote`

相同 ID/哈希跳过；不同 ID 合并；相同 ID 但正文不同则保留双方并要求处理，禁止静默 last-write-wins。技能固定到 tag 或 commit，本地未登记修改不会被远端覆盖。

## 4. 无 Session 的主动知识提取

### 每轮提取管线

新增 `scripts/extract.js`，处理当前一轮输入、结果摘要和工具证据，不创建长期会话记录：

1. Hook 或 `/workflow` 收尾步骤将本轮必要内容传给 extractor。
2. 提取器识别 `pitfall`、`insight`、`decision`、`pattern`、`constraint` 候选。
3. 用内容指纹检索项目/全局记忆，去重并过滤临时状态、猜测和可从代码重建的信息。
4. 已由代码、测试或明确结果验证的项目事实，可按设置直接写入项目记忆并在回复中告知。
5. 用户偏好、歧义结论、敏感信息和任何全局提升必须先确认。
6. 候选一旦处理即删除；只保留短期原子临时文件用于 Hook 与 extractor 交接，正常结束和超时都会清理。

不保存用户原始提示、完整回复、工具流水或对话摘要。记忆来源改为 `zcode-turn` / `workflow-turn` 加日期和内容指纹，不依赖 session ID。

### 自动入口

- 配置 ZCode `Stop` Hook，在每轮回复完成时调用轻量检测器。
- 只有发现高价值信号时，Hook 才请求一次受限 continuation，让主模型完成语义归类/确认；响应哈希防止重复触发和循环。
- `UserPromptSubmit` 只在确有必要时写入短期临时输入，Stop 后立即清除，不形成历史记录。
- 不支持 Hook 的客户端，由 `/workflow` 的必做收尾步骤调用同一 `extract.js`；文档明确其为技能调用期间的逐轮能力，而不是后台会话监听。
- `optimize.js` 只记录匿名聚合计数：候选、写入、确认、拒绝、去重，不记录原始对话。

## 5. 一致性与现有缺陷修复

- 统一代码索引权威文件为 `index/code.index.json`，更新 `SKILL.md` 和 `memory-schema.md` 的旧 `.workflow/` 路径说明。
- 修复 router 对 `skills.yaml` 的错误路径。
- 以记忆 Markdown 为权威来源，新增索引重建和完整性校验；缺正文的旧全局索引项只报告，不伪造内容。
- 项目注册统一规范化根目录，合并同一 Unity 根的重复展示项。
- 修复增量索引遗漏新增文件、CodeDB 可用性误报、dashboard 状态字段不一致。
- 将安装器改为参数化进程调用，避免 Git URL/名称通过 shell 拼接执行。

## 6. 验证

- 测试路径归一化、只读 API、manifest、排除规则、哈希、记忆去重、逐轮提取和重复触发保护。
- 用本地 bare Git 仓库验证 push、pull、无变化状态、冲突、回滚以及凭据排除。
- 用已确认根因、架构决策、项目约束、普通对话四类样例验证主动提取；确认不生成 session 文件、不保存原始对话、不重复写入、不自动提升全局。
- 启动 dashboard，确认仅监听 loopback，所有 GET 不写磁盘。
- 浏览器验证桌面和移动视口的概览、项目详情、索引搜索、项目记忆、全局知识、技能库以及空/错误状态。
- 运行 JavaScript 语法检查和自动化测试，报告删除的数据范围、同步验证和剩余冲突。