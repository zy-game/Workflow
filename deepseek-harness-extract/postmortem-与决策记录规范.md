# Postmortem 与决策记录（Agent Note）规范

DeepSeek Harness 用两套互补的记录制度管理"为什么"：

- **Agent Note（ADR）**：前瞻的决策记录——记录一个决策及其击败的备选方案。
- **Postmortem**：回望的故障记录——记录一个缺陷为什么能穿过所有安全网。

原仓库体量：506 implemented / 25 proposed / 11 rejected Agent Note，4 篇 postmortem。

## Agent Note：四态生命周期

路径即元数据：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`，文件名日期 = 首次提出日，状态变化靠移动目录。

### 生命周期

| 态 | 语义 | 流转规则 |
|---|---|---|
| `proposed/` | 已评审未实现的提案 | 永不归档；不再追求则改为 rejected |
| `implemented/` | 已随代码落地 | **随实现保持同步**：代码改名/移动/改默认值时，同一变更里更新 Note 的事实（只改事实，不改决策） |
| `rejected/` | 已考虑并否决 | `Status: rejected — <一行理由>`；只在"仍能防止一个诱人的真实错误"时保留，否则删除整套 |
| `archived/{class}/` | 冻结的历史快照 | 只收 implemented；密封后永不编辑/翻译/重排/删除；不是当前行为的权威 |

### 分类（class，封闭集）

`feature`（新能力）/ `bug-fix` / `simplification`（删面积不加能力）/ `architecture`（出货源码的结构决策）/ `process`（代码周边的工具与流程）/ `testing`。
判别线：architecture 管出货的源码，process 管周边工具。`refactor` 有意缺席——被 `simplification` 的判别问题"可观察行为变了吗"覆盖。

### 文件格式（门禁强制）

```markdown
# Agent Note: <标题>

Status: proposed | implemented | rejected — <理由>
```

- `proposed/` 骨架：`## Problem → ## Proposal → …定制节… → ## Alternatives considered → ## Acceptance criteria → ## Risks`
- `implemented/` 骨架：`## Problem → ## Decision（现在时陈述已出货现实）→ …定制节… → ## Alternatives considered → ## Consequences（代价与所得都记）`。proposal 式标题（Plan/Migration plan/Acceptance criteria）在此态被门禁拒绝。
- `rejected/` 冻结提案原文，判决只放 Status 行。

**Alternatives considered 强制**：每个真实备选一段加粗开头，或 `### Why not <X>?` 小节。没有记录"赢过了什么"的决策会引来反复重议。备选是记录下来的，不是事后发明的。

### 何时必须写

非平凡变更（改行为/架构/跨文件契约/流程工具/测试策略/落盘或线缆格式/维护者可能重议的决策）**必须在同一 PR** 新增或更新 Agent Note。纯机械局部编辑豁免。更新已有 owning Note 即满足，不建重复。

### 取代与合并

- 完全取代可合并：owner 吸收每条独特理由/备选/后果/验证证据/点名缺口，修复所有入链，删除整套。仅搬运可迁移理由不算部分取代。
- 部分取代保留双份并互链，更新每条仍当前的事实。
- "加了又删"的功能只有当它从生产代码、配置、schema、持久/线缆格式、迁移、兼容行为中完全消失，才可并入删除 Note；保留原始动机、为何不再值得、放弃的能力、重新引入条件。

## Postmortem：三条件门槛 + 固定结构

**何时写**：同时满足——
1. **subtle**：机制不明显，认真的工程师也会重新踩一遍才懂；
2. **systemic**：逃逸原因是测试/工具/规范的系统性缺口，不是一次性手误；
3. **costly to rediscover**：已付出真实调试成本，再犯还会再付。

**结构**：`Executive summary`（30 秒可吸收的一段：什么坏了、根因白话、为何逃逸、持久教训）→ `Summary / Timeline / Root cause / Guardrails`。Guardrails 必须链到它催生的具体护栏（测试、AGENTS.md 规则、ADR）。

**与 Agent Note 的分界**：postmortem 是回望失败；Agent Note 是决策与被拒备选。修 bug 的决策仍走 Agent Note，postmortem 回答"流程为什么放它过去"。

## 借鉴要点

1. 路径编码状态（目录即生命周期），不需要中心索引文件；用封闭分类集 + 门禁拒绝未知目录。
2. implemented 态"随代码保持事实同步"的义务，是 ADR 不腐烂的关键——由同一个 PR 强制携带。
3. rejected 的存留判据是防错价值而非记录完整性；archived 的价值是历史证据而非权威。
4. 中文对照件（`.zh.md` + 哈希 sidecar）与格式校验脚本（`verify-agent-note-format`、`verify-archived-agent-notes`）让整套制度可机器执法。
