# DeepSeek Harness 提取库

来源：`E:\deepseek-harness`（DeepSeek 开源 agent harness `dsh`，MIT 协议，Cordis 插件架构）。
本目录是从该仓库中筛选出的可复用资产：**9 个 skill 原文 + 3 份提炼文档**。

## 提炼文档

| 文档 | 内容 |
|---|---|
| [设计哲学.md](设计哲学.md) | 插件化架构、事件域选择、边界纪律、工程文化、防御性模式 |
| [规范清单.md](规范清单.md) | 代码/测试/文档/Git/Agent 协作的可执行规则清单 |
| [postmortem-与决策记录规范.md](postmortem-与决策记录规范.md) | Agent Note（ADR）四态生命周期 + postmortem 门槛与格式 |

## Skills（原文拷贝，含 references/ 与 agents/ 子文件）

| Skill | 一句话价值 | 复用建议 |
|---|---|---|
| `dsh-pre-push-checks` | 按改动面选最小相关证据，不为提交/推送重复跑通过的检查；CI 负责穷举矩阵 | 通用工程纪律，命令需按目标仓库替换 |
| `dsh-code-review` | 语义审查方法论：阻塞项优先、生命周期/并发/所有权检查单、报告缺陷-位置-影响-证据 | 高度通用 |
| `dsh-find-simplifications` | 简化审计：按生产/非生产语料分类消费者，强候选需证据，避免打薄 | 高度通用 |
| `dsh-prose-standard` | "完整命题"注释/文档编辑规则：保留每一条事实子句，只删修饰、重复与叙述 | 高度通用 |
| `dsh-trim-cot-leakage` | 思维链泄漏八类 taxonomy 与召回探针——AI 协作仓库的注释卫生 | 独有且通用 |
| `dsh-archive-agent-notes` | ADR 归档判断：按未来决策价值而非字数/年龄；冻结三件套机制 | 配合决策记录规范使用 |
| `dsh-doc-standards` | 文档分层放置、预算纪律、语料审计流程 | 通用 |
| `dsh-merging-stacked-prs` | GitHub 官方 stacked PR 合并操作规程（`gh stack`） | GitHub 栈工作流专用 |
| `record-browser-gif` | GUI 变更证据链：真实服务录制、一个故事一次运行、来源声明、assets 分支发布 | 任何 Web 项目可复用 |

**未拷贝**（dsh 专用工具链，通用价值低）：`dsh-translate-docs`（双语文档扩展翻译流）、`dsh-doc-site-sync`（VitePress 站点投影同步）。

## 使用注意

- Skill 内的相对链接（`../../notes/...`、`../../../docs/...`）指向原仓库 `E:\deepseek-harness`，在别处使用前需适配或改写为目标仓库路径。
- 原仓库规模参考：506 篇 implemented Agent Note、25 proposed、11 rejected、4 篇 postmortem——规则不是纸面理想，而是配套门禁（`doc-sync`、`verify-agent-note-format` 等）强制执行的现行实践。
- 版权：上游 MIT（见原仓库 LICENSE / THIRD_PARTY_NOTICES.md），保留原始内容未做改动。
