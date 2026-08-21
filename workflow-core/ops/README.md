# Workflow Core production runbook

## Production layout

- Release: `/opt/workflow-core/releases/<release-id>`
- Current symlink: `/opt/workflow-core/current`
- Runtime data: `/var/lib/workflow-core`
- Environment: `/etc/workflow-core/core.env` (`root:root`, mode `0600`)
- Unit: `workflow-core.service`
- Public HTTPS entrypoint: `0.0.0.0:8710` (Nginx, IP allowlisted)
- Core API upstream: `127.0.0.1:18710`
- Core internal API: `127.0.0.1:18711` (loopback only)
- Central DSH: `127.0.0.1:3081`
- Central DSH public route: `https://<host>:8710/dsh/`
- Knowledge repository: `/var/lib/workflow-core/workflow.db`

Nginx routes both `/worker` and `/dsh/` to Core with WebSocket upgrade headers, and all other paths to Core. Core authenticates `/dsh/api/*` with a live client bearer token before forwarding approved HTTP and WebSocket traffic to the loopback-only central DSH. Install `ops/nginx/workflow-admin.conf` as `/etc/nginx/sites-available/workflow-admin`, symlink it into `sites-enabled`, and require `nginx -t` to pass before reload. Port `3080` must remain closed; the former `dsh-web-public.service` forwarding process is retired. `wf-api.service`, `feishu-listener.service`, and `ai-engine.service` must remain disabled so they cannot compete with Core for traffic or Feishu events.

## Feishu application requirements

In the Feishu developer console for the same App ID used by Core:

1. Enable the bot capability.
2. Select long connection for event delivery.
3. Subscribe to `im.message.receive_v1`.
4. Grant permissions required to read messages and send/update interactive cards.
5. Publish the application version and install the bot in the test group.

Long connection delivers message events. Card button callbacks use HTTPS URL mode and are disabled during the initial isolated deployment. Enable them only after routing `/webhook/feishu` publicly over trusted HTTPS and setting both `WFC_FEISHU_CALLBACKS_ENABLED=1` and `WFC_FEISHU_VERIFICATION_TOKEN`.

## Release install

Run from an extracted release directory as the deployment user:

```bash
PATH=/opt/node24/bin:$PATH npm ci --omit=dev
PATH=/opt/node24/bin:$PATH npm test
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/workflow-core
sudo install -d -o root -g root -m 0700 /etc/workflow-core
sudo install -o root -g root -m 0644 ops/systemd/workflow-core.service /etc/systemd/system/workflow-core.service
sudo systemctl daemon-reload
```

Create `/etc/workflow-core/core.env` from `ops/systemd/core.env.example`. Insert credentials through a history-free, access-controlled process. Never place them in the release directory, command arguments, logs, or shell history.

Before activating a new release:

```bash
sudo ln -sfn /opt/workflow-core/releases/<release-id> /opt/workflow-core/current
sudo systemctl enable --now workflow-core.service
sudo systemctl is-active --quiet workflow-core.service
```

## Readiness

The process is not ready until the health response reports Feishu connected:

```bash
/opt/node24/bin/node ops/verify-feishu-ready.mjs http://127.0.0.1:18710
sudo journalctl -u workflow-core.service --since '-5 minutes' --no-pager \
  | grep -F '[feishu] websocket long connection ready'
```

The verification script prints only state and never prints credentials, task content, or database rows.

## Linux Worker install

Each Linux Worker uses its own local DSH and state directory. Create the runtime directories with owner `ubuntu`, keep the environment file root-only, and install `ops/systemd/workflow-worker.service` as `/etc/systemd/system/workflow-worker.service`.

The server's DSH package is a Node-backed CLI, so the environment file must set both the Node executable and the script entrypoint:

```text
WFC_CORE_URL=http://127.0.0.1:18710
WFC_WORKER_ID=isolated-worker-1
WFC_WORKER_CAPABILITIES=dsh
WFC_WORKER_STATE_DIR=/var/lib/workflow-worker
WFC_WORKER_WORKSPACE=/var/lib/workflow-worker/workspace
WFC_DSH_NODE=/opt/node24/bin/node
WFC_DSH_BIN=/opt/node24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
WFC_DSH_HOME=/var/lib/workflow-worker/dsh
```

`WFC_WORKER_TOKEN` is the only secret in this file. Write it through a protected process, set owner `root:root` and mode `0600`, and never print or log it. The Worker strips this variable before spawning DSH. `WFC_WORKER_STATE_DIR` holds the task-to-session recovery database; `WFC_DSH_HOME` holds the DSH session itself. The daemon pins `HOME`, `DSH_HOME`, `DSH_SESSION_DB`, `DSH_STATE_DB`, and `DSH_SESSION_QUERY_DB` inside `WFC_DSH_HOME` because DSH resolves its databases from the account's passwd home when they are unset - without those variables the Worker would share the central DSH's databases. Preserve both directories across restarts so an active claim can resume without sending its prompt again. The Worker unit keeps `NoNewPrivileges=true`; `ProtectHome=false` is required because DSH persists SQLite state below its isolated HOME. The writable surface remains `/var/lib/workflow-worker`.

After installing the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workflow-worker.service
sudo systemctl is-active --quiet workflow-worker.service
```

Readiness requires `workers_online` and `workers_connected` to be non-zero, and the Worker journal should report local DSH readiness followed by a Core connection. Do not grant the Worker admin actions or reuse the central DSH state directory.

## Windows Worker install

Windows requires Node 24 and an elevated Windows PowerShell 5.1 session. Build the DSH runtime with `npm ci` from the committed `dsh-workflow/package-lock.json`, smoke-test it with isolated `HOME`, `DSH_HOME`, `DSH_SESSION_DB`, `DSH_STATE_DB`, and `DSH_SESSION_QUERY_DB` paths, and pass that exact DSH `0.1.0-rc.8` runtime to the installer. The installer rejects a lock whose `@deepseek-ai/dsh*` package family is not entirely pinned to RC.8 and does not re-resolve that dependency tree during production installation.

The installer reads the one-time worker token from standard input, restricts `C:\ProgramData\WorkflowCore` to `SYSTEM` and Administrators, immediately encrypts the token with LocalMachine DPAPI, and registers the `Workflow Core Worker` startup task under `SYSTEM`. The token must not appear in command arguments, environment files, logs, or intermediate files.

```powershell
$tokenProducer | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File E:\Workflow\workflow-core\ops\windows\install-workflow-worker.ps1 `
  -DshRuntimeSource C:\path\to\verified-dsh-runtime
```

`$tokenProducer` must emit only the one-time plaintext token. The installation is ready only after all of these checks pass:

1. The scheduled task is Running under `SYSTEM`, with restart-on-failure configured.
2. The latest worker log reports `local DSH ready` and `connected` with an empty error log.
3. Core reports `windows-<hostname>` online with the current model revision.
4. A task constrained by `worker_selector.capabilities = ["powershell"]` completes on that worker.
5. Stopping and starting the scheduled task creates a new Worker/DSH process pair and reconnects without reissuing credentials.
6. Worker recovery state remains below `C:\ProgramData\WorkflowCore\state`, while DSH profile and session storage remain below `C:\ProgramData\WorkflowCore\dsh-home`; the SYSTEM profile must stay unused.

## Production acceptance

1. Mention the bot once in the test group with a harmless task.
2. Require one task card and one new task in Core.
3. Confirm the card can be updated by a synthetic progress event after a worker is connected.
4. Verify reply correction, cancel, and a harmless approval request.
5. Verify knowledge context through the loopback-only API and confirm that it reports the expected repository revision:

```bash
curl -fsS -H 'content-type: application/json' \
  -d '{"cwd":"/opt/workflow-core/current","machine":"server","max_chars":12000}' \
  http://127.0.0.1:18711/api/internal/v1/workflow/context
```

6. Confirm the retired services and port remain absent:

```bash
systemctl is-active workflow-core.service workflow-worker.service dsh-web.service
systemctl is-enabled wf-api.service feishu-listener.service ai-engine.service dsh-web-public.service
ss -ltn | grep -E ':(3080|3081|8710|18710|18711)\b'
sudo ufw status numbered
```

The three retained units must be active. The four retired units must be disabled, nothing may listen on `3080`, and UFW must not contain a `3080/tcp` rule.

## Knowledge cutover

Before replacing `workflow.db`, stop Core and create a mode-`0600` backup below `/var/lib/workflow-core/backups`. Copy only from a checkpointed source database whose WAL is empty. After replacement, restore owner `ubuntu:ubuntu`, start Core, and verify `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, repository counts, the context API, and `/api/v1/health`.

Keep the source database and the pre-import Core backup until the cutover retention window closes. Record SHA-256 checksums without printing any database rows.

## Rollback

Before any rollback, stop Core and archive the current `core.db`, `auth.db`, and `workflow.db`. They may contain tasks, audit events, credentials, and knowledge written after cutover.

For an application release failure, point `/opt/workflow-core/current` at the previous release and restart Core:

```bash
sudo systemctl stop workflow-core.service
sudo ln -sfn /opt/workflow-core/releases/<previous-release-id> /opt/workflow-core/current
sudo systemctl start workflow-core.service
/opt/node24/bin/node /opt/workflow-core/current/ops/verify-feishu-ready.mjs http://127.0.0.1:18710
```

Restoring a pre-import `workflow.db` discards knowledge changes made after that backup. Do it only after preserving the current database and only when the incident specifically requires repository rollback.

Reactivating the legacy stack is a separate disaster-recovery operation. Restore the known-good legacy Nginx configuration first, stop Core and its Worker, and then enable the legacy services. Never run both Feishu listeners at once. Reopening `3080/tcp` is not required when DSH remains available through the `8710` Nginx gateway.
