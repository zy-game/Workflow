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
- Worker JSONL backend: configured per Worker with `WFC_JSONL_COMMAND`
- Knowledge repository: `/var/lib/workflow-core/workflow.db`

Nginx routes `/worker` and all other paths to Core; the Worker WebSocket uses the `/worker` route. Install `ops/nginx/workflow-admin.conf` as `/etc/nginx/sites-available/workflow-admin`, symlink it into `sites-enabled`, and require `nginx -t` to pass before reload. `wf-api.service`, `feishu-listener.service`, and `ai-engine.service` must remain disabled so they cannot compete with Core for traffic or Feishu events.

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

Each Linux Worker uses its own state directory and a configured generic Workflow JSONL backend. Create the runtime directories with owner `ubuntu`, keep the environment file root-only, and install `ops/systemd/workflow-worker.service` as `/etc/systemd/system/workflow-worker.service`.

The environment file selects the vendor-neutral JSONL command and optional pipe-delimited arguments:

```text
WFC_CORE_URL=http://127.0.0.1:18710
WFC_WORKER_ID=isolated-worker-1
WFC_WORKER_CAPABILITIES=workflow-jsonl
WFC_WORKER_STATE_DIR=/var/lib/workflow-worker
WFC_JSONL_COMMAND=/opt/workflow-tools/bin/workflow-jsonl-bridge
WFC_JSONL_ARGS=
```

`WFC_WORKER_TOKEN` is the only secret in this file. Write it through a protected process, set owner `root:root` and mode `0600`, and never print or log it. `WFC_WORKER_STATE_DIR` holds recovery state. `WFC_JSONL_COMMAND` reads Workflow JSONL requests from stdin and emits JSONL events/results on stdout; arguments are separated with `|`. Preserve the state directory across restarts. The writable surface remains `/var/lib/workflow-worker`.

### Local configuration, projects and recovery

After first start the Worker writes `<stateDir>/config.json` (mode `0600`, revisioned): the authoritative source for registered projects, backend descriptors and admin settings. Environment variables only bootstrap Core connection, the state directory and the optional first JSONL backend; later changes go through the loopback admin API, never through Core.

The loopback admin server binds `127.0.0.1` only. When started without `WFC_ADMIN_TOKEN` it generates a token, writes it to `<stateDir>/admin.token` (mode `0600`), and persists the chosen port into `config.json`. Mutations require the bearer token plus an `X-CSRF-Token` header. It exposes status/drain, project, backend, environment, credential, run and interaction management; credential responses never include secret values. On Windows, credential values are DPAPI-encrypted before being written; on Linux only external references (for example `systemd://name`) are stored, never local plaintext.

Environment profiles reject secret-like keys (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `*_KEY`) and `WFC_*` variables; profiles hold only bridge application settings. Backend child processes receive a filtered environment that strips all `WFC_*` and secret-like variables.

Recovery: terminal results stay in `<stateDir>/worker.db` as `completion_pending` runs with a stable frame id until Core acknowledges them; after a restart, unacknowledged terminal frames are replayed from the outbox and acknowledged runs are dropped. Mid-flight runs are resumed only when the backend supports `resume` and a session ref was persisted; otherwise the Worker fails the task closed with a clear terminal error and never replays the original prompt.

After installing the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workflow-worker.service
sudo systemctl is-active --quiet workflow-worker.service
```

Readiness requires `workers_online` and `workers_connected` to be non-zero, and the Worker journal should report the JSONL backend followed by a Core connection.

## Windows Worker install

Windows requires Node 24 and an elevated Windows PowerShell 5.1 session. The execution engine (JSONL bridge command) is configured **after** installation through the Worker's loopback admin UI (Backends page, which also persists it into `config.json`); the installer's `-JsonlCommand` is therefore optional and only needed to have the backend in place from the first start. Without it the Worker connects to Core with no backend capabilities and does not claim tasks until you add one.

The installer reads the one-time worker token from standard input, restricts `C:\ProgramData\WorkflowCore` to `SYSTEM` and Administrators, immediately encrypts the token with LocalMachine DPAPI, and registers the `Workflow Core Worker` startup task under `SYSTEM`. The token must not appear in command arguments, environment files, logs, or intermediate files. Non-secret settings (Core URL, worker id, capabilities, JSONL command/args, admin port) are written to `secrets\worker-settings.json` inside the ACL-protected tree; the start script reads them and no longer depends on machine-level environment variables.

```powershell
$tokenProducer | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File E:\Workflow\workflow-core\ops\windows\install-workflow-worker.ps1 `
  -JsonlCommand C:\path\to\workflow-jsonl-bridge.exe `
  -CoreUrl https://<core-address>:8710
```

`$tokenProducer` must emit only the one-time plaintext token. The installation is ready only after all of these checks pass:

1. The scheduled task is Running under `SYSTEM`, with restart-on-failure configured.
2. The latest worker log reports `JSONL backend ready` and `connected` with an empty error log.
3. Core reports `windows-<hostname>` online with the registered JSONL backend and config revision.
4. A task constrained by `worker_selector.capabilities = ["powershell"]` completes on that worker.
5. Stopping and starting the scheduled task creates a new Worker/JSONL bridge process pair and reconnects without reissuing credentials.
6. Worker recovery state remains below `C:\ProgramData\WorkflowCore\state`, while the bridge must not use the SYSTEM profile.

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
systemctl is-active workflow-core.service workflow-worker.service
systemctl is-enabled wf-api.service feishu-listener.service ai-engine.service
ss -ltn | grep -E ':(8710|18710|18711)\b'
sudo ufw status numbered
```

The retained units must be active and retired units disabled.

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

Rollback restores the previous Core and Worker release together; never run duplicate Core or Feishu listeners.
