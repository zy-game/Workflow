# Workflow

一个持有责任、主动发起、在你所有触达点上出现的智能助理。

Workflow 不是中转层，也不是任务队列。它是「第二个我」：替你盯着你托付的事，在需要的时候找到你，经你授权后落到正确的机器上执行。

- **大脑**（判断与授权）在 Workflow Server
- **触手**（执行）在执行节点上的 Agent Runtime（DSH / CLI）
- **触达点**（你在哪）在飞书、桌面客户端与浏览器

## 方案

- [Workflow 智能助理：完整方案](docs/architecture/workflow-assistant-architecture.md) —— 定位、分层、协议契约、数据模型、实施路线图
- [对等多节点架构方案](docs/architecture/workflow-peer-architecture.md) —— 执行权威层（对等同步、执行归属、事件模型）；产品定位部分已被上者取代

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `workflow-core/` | Core 与 Worker：任务模型、项目归属路由、对等同步、Bridge、飞书渠道 |
| `docs/architecture/` | 架构与实施方案 |
| `ops/` | 生产切换与回滚 runbook |
| `deepseek-harness-extract/` | DSH 技能源码参考 |

## 开发

```bash
cd workflow-core
npm test
```
