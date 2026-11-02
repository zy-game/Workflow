# DSH ACP profile 的客户端能力与工具开关

`dsh --profile acp` 默认在 ACP 侧禁用文件与命令工具，且 `clientCapabilities` 默认
`fs` / `terminal` 全为 `false`。青梅要真的「派任务给 harness 去做」，两边都要打开：

1. **客户端声明能力**（本仓库负责）：`AcpClient.start()` 在 `initialize` 里报
   `{ fs: { readTextFile: true, writeTextFile: true }, terminal: true }`，并实现
   `fs/read_text_file`、`fs/write_text_file`、`terminal/{create,output,wait_for_exit,kill,release}`。
   文件路径限制在会话 cwd 内。
2. **DSH profile 侧开工具**（部署时做一次）：把本目录的
   `dsh-acp.cordis.patch.yml` 覆盖到 `~/.dsh/profiles/acp/cordis.patch.yml`。

没有第 1 步，子 agent 会以为自己「没有文件权限」；没有第 2 步，工具被 `disabled: true`，
模型同样看不到。

`personaPrefix` 不要写「你没有文件和命令权限」这类话——它会直接导致模型拒绝干活。

安全边界：

- DSH 的 `sandbox-policy.mode` 默认 `workspace-write`，工作目录是任务 run 目录；
- `approval.policy` 默认 `ask`：敏感操作会发 ACP `session/request_permission`，
  青梅落到 `qm_approval`，主人在 Web「任务 → 待确认」里批准或拒绝；
- 客户端对文件路径做会话目录内的硬校验，越界直接回错误。

验证方式（生产上跑过）：

```bash
POST /api/v1/tasks {"prompt":"建 notes.txt 写 hello，然后用 qm_publish_artifact 登记它，再用 qm_finish_task 收尾"}
# → run.status=done，artifacts=[{name:"notes.txt",path:"notes.txt",...}]，
#   目录里 notes.txt 内容为 hello
```
