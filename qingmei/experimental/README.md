# Experimental 模块

这里是从默认装配下线、但代码仍保留的实验模块。它们不属于个人助手核心链路，默认不加载。

| 模块 | 说明 |
|---|---|
| `qm-content` | 内容发布/账号运营 |
| `qm-review` | 月度复盘 |
| `qm-memory-hotspot` | 记忆热度调整 |
| `qm-opener` | 主动开场 |
| `qm-nudge` | 任务督促 |
| `qm-rest` | 休息提醒 |

重新启用前先确认：

1. 不直接读写其它插件的 collection
2. 通过 owner 服务取数
3. 补回 `qingmei.yml` 并更新装配测试

这些包仍在 pnpm workspace 中，方便继续维护；但默认测试/部署只覆盖 `packages/` 下的核心插件。
