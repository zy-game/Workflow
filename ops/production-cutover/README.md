# DSH/Workflow production cutover and rollback runbook

Status: prepared from local artifacts on 2026-08-18; not executed against production.

This runbook implements the approved SQLite/HTTPS architecture without deploying it. Copy `cutover-manifest.template.json` to a run-specific, access-controlled location and replace every `DISCOVER:` value before the change window. A manifest containing `DISCOVER:`, null required evidence, or a failed gate is not executable.

## 1. Scope and evidence

- `VERIFIED-LOCAL`: established by files under `E:/Workflow`, not by a production query.
- `APPROVED-PLAN`: required by the approved architecture but not verified on production.
- `DISCOVER-PROD`: observe read-only on production and record before execution.

| Value | Status | Evidence |
|---|---|---|
| Public TUI base `https://139.155.78.241:8710/dsh` | VERIFIED-LOCAL; DISCOVER-PROD reachability/certificate | `../../dsh-client/Start-DshTui.ps1` |
| DSH upstream `127.0.0.1:3081` | APPROVED-PLAN | [approved architecture plan](../../.zcode/plans/plan-sess_9826040e-3ef5-44d2-8ed9-605a0a102a15.md) |
| Workflow context `http://127.0.0.1:8711/api/internal/v1/workflow/context`, `maxChars=6000` | VERIFIED-LOCAL | `../../dsh-workflow/server-patch.yml` |
| DSH DB defaults `/home/ubuntu/.dsh/sessions.db`, `/home/ubuntu/.dsh/dsh-state.db`, `/home/ubuntu/.dsh/session-query.db` | VERIFIED-LOCAL defaults; DISCOVER-PROD effective paths | `../../dsh-workflow/server-patch.yml` |
| Session DB `application_id=0x44534850`, `user_version=15`; storage DB `application_id=0`, `user_version=1` | VERIFIED-LOCAL for rc.7 | `../../dsh-workflow/src/validation.mjs` |
| Domains `workspace@2`, `session_projcache@3`, `message_feedback@0` | VERIFIED-LOCAL | `../../dsh-workflow/domain-descriptors.rc7.json` |
| Node `>=24`; DSH persistence/storage packages `0.1.0-rc.7` | VERIFIED-LOCAL | `../../dsh-workflow/package.json` |
| Legacy `dsh-web-public.service`/socat port `3080`; `wf-api.service` | APPROVED-PLAN; DISCOVER-PROD units/socket | [approved architecture plan](../../.zcode/plans/plan-sess_9826040e-3ef5-44d2-8ed9-605a0a102a15.md) |

No local artifact verifies production unit names for DSH, listener, worker, or watchdog; auth/application/Workflow source paths; deployed migration commands; effective DB paths; health endpoints; release paths; or backup root. The wf-api architecture and backup tooling require `auth.db`, `app.db`, and `workflow.db`; discover their effective production paths, but do not treat any member of that authoritative set as optional. Leave unresolved manifest values as `DISCOVER:` until observed.

Hard exclusions: model API keys, real model replies, DSH approval/question flows, the Windows execution bridge, and EXE packaging. Do not use them as acceptance evidence. Never print or store passwords, cookies, tokens, password hashes, private keys, environment blocks, database rows, session/model content, or Workflow document bodies in evidence.

## 2. Phase 0 - read-only discovery and preflight

Use a shell with history disabled. These variables are non-secret identifiers and paths only.

```bash
set -euo pipefail
set +o history
umask 077
readonly WF_API_UNIT='DISCOVER:systemd unit for wf-api'
readonly LISTENER_UNIT='DISCOVER:systemd unit for external listener writer'
readonly WORKER_UNIT='DISCOVER:systemd unit for queue/poll writer'
readonly WATCHDOG_UNIT='DISCOVER:systemd unit for watchdog writer'
readonly DSH_UNIT='DISCOVER:systemd unit for DSH'
readonly SOCAT_UNIT='DISCOVER:confirm dsh-web-public.service'

for unit in "$WF_API_UNIT" "$LISTENER_UNIT" "$WORKER_UNIT" "$WATCHDOG_UNIT" "$DSH_UNIT" "$SOCAT_UNIT"; do
  case "$unit" in DISCOVER:*) printf 'UNRESOLVED %s\n' "$unit" >&2; exit 2;; esac
  systemctl show "$unit" --property=Id,LoadState,ActiveState,SubState,FragmentPath,MainPID --no-pager
done
systemctl list-dependencies --all "$WF_API_UNIT" --no-pager
systemctl list-dependencies --all "$DSH_UNIT" --no-pager
ss -lntp '( sport = :3080 or sport = :3081 or sport = :8710 or sport = :8711 )'
```

All gates must be recorded in the manifest:

1. Identify every writer of legacy auth/app/Workflow files, DSH JSON/JSONL/domain files, attachments, or target SQLite files. Reconcile units, dependencies, timers, cron, supervisors, containers, and operator jobs. Unknown writers stop the cutover.
2. Record effective paths, filesystem/mount, owner/mode, free bytes/inodes, Node/application versions, unit states, listener bindings, and deployed release/config hashes. Never query `Environment` or dump configuration.
3. Confirm `3081` and `8711` are loopback-only and `8710` is the intended HTTPS listener. Finding `3080` does not authorize disabling it.
4. Require backup capacity of at least twice all legacy sources plus SQLite targets/WAL sidecars.
5. Run each discovered auth/application/Workflow importer in validation/dry-run mode. It must parse all sources first, redact values, report only counts/revisions/aggregate hashes, refuse unexpected existing targets, and use one transaction per authority boundary.
6. Run the implemented DSH dry-run. It reads and hashes sources, validates event sequences and attachment SHA-256, and creates no destination or parent directory.

```bash
set -euo pipefail
: "${MIGRATOR_DIR:?}" "${DSH_SESSION_SOURCE:?}" "${DSH_STORAGE_SOURCE:?}"
: "${DSH_SESSION_DB:?}" "${DSH_STATE_DB:?}" "${DSH_DESCRIPTOR_FILE:?}"
cd "$MIGRATOR_DIR"
node src/migrate.mjs --dry-run \
  --sessions "$DSH_SESSION_SOURCE" --storage "$DSH_STORAGE_SOURCE" \
  --session-db "$DSH_SESSION_DB" --state-db "$DSH_STATE_DB" \
  --descriptors "$DSH_DESCRIPTOR_FILE" --attachments "$DSH_ATTACHMENT_ROOT" \
  --compression "${DSH_SOURCE_COMPRESSION:-zstd}" >"$EVIDENCE_DIR/dsh-dry-run.json"
```

Pass only when source manifests remain stable across reads, destinations do not exist, every attachment resolves and hashes correctly, and no production field is unresolved.

## 3. Phase 1 - freeze writers in exact order

Announce the freeze. Record timestamp, state, and PID after each command. Stop on any inactive-state failure or unlisted writer.

1. Stop public application writes: `systemctl stop "$WF_API_UNIT"`.
2. Stop inbound listener writers: `systemctl stop "$LISTENER_UNIT"`.
3. Stop queue/poll workers: `systemctl stop "$WORKER_UNIT"`.
4. Stop watchdog/restart writers: `systemctl stop "$WATCHDOG_UNIT"`.
5. Stop DSH last: `systemctl stop "$DSH_UNIT"`.
6. Leave `$SOCAT_UNIT` and port `3080` unchanged. Disable them only in Phase 8.

```bash
set -euo pipefail
for unit in "$WF_API_UNIT" "$LISTENER_UNIT" "$WORKER_UNIT" "$WATCHDOG_UNIT" "$DSH_UNIT"; do
  systemctl stop "$unit"
  test "$(systemctl is-active "$unit" || true)" = inactive
done
pgrep -af 'wf-api|dsh|feishu_listener|poll_worker|watchdog' && exit 3 || true
ss -lntp '( sport = :3081 or sport = :8710 or sport = :8711 )' >"$EVIDENCE_DIR/post-freeze-listeners.txt"
```

Replace the `pgrep` patterns with discovered identities. Confirm source hashes/revisions/counts still match preflight.

## 4. Phase 2 - snapshots and hashes

Before creating targets, back up all legacy authorities and deployed app/config: DSH sessions/domains/attachments, auth state, Workflow authority files, service overrides, and release/config pointers. Exclude private keys; record only their separately managed backup identifier. Use mode `0700` directories and `0600` files plus policy-required protected storage.

```bash
set -euo pipefail
: "${BACKUP_ROOT:?}" "${RUN_ID:?}" "${LEGACY_SOURCE_LIST_FILE:?}"
readonly SNAPSHOT_DIR="$BACKUP_ROOT/$RUN_ID/pre-cutover"
install -d -m 0700 "$SNAPSHOT_DIR"
tar --create --file "$SNAPSHOT_DIR/legacy-authorities.tar" --files-from "$LEGACY_SOURCE_LIST_FILE"
find "$SNAPSHOT_DIR" -type f ! -name SHA256SUMS -print0 | sort -z \
  | xargs -0 sha256sum >"$SNAPSHOT_DIR/SHA256SUMS"
sha256sum --check "$SNAPSHOT_DIR/SHA256SUMS"
chmod 0600 "$SNAPSHOT_DIR"/*
```

Review `LEGACY_SOURCE_LIST_FILE`: absolute paths only; no private keys, token files, histories, logs, or unrelated home directories. Record counts, bytes, and archive/manifest hashes, not contents.

After migration and reconciliation but before starting DSH, wf-api, login, token issuance, outbox apply, session mutation, or any writer, create a coherent SQLite cutover-point backup of `auth.db`, `app.db`, `workflow.db`, `sessions.db`, and `dsh-state.db`. Exclude rebuildable `session-query.db` and `cache.db`.

```bash
set -euo pipefail
: "${AUTH_DB:?}" "${APP_DB:?}" "${WORKFLOW_DB:?}" "${DSH_SESSION_DB:?}" "${DSH_STATE_DB:?}"
readonly DB_CUTOVER_DIR="$BACKUP_ROOT/$RUN_ID/sqlite-cutover-point"
install -d -m 0700 "$DB_CUTOVER_DIR"
for spec in "auth:$AUTH_DB" "app:$APP_DB" "workflow:$WORKFLOW_DB" \
  "dsh-sessions:$DSH_SESSION_DB" "dsh-state:$DSH_STATE_DB"; do
  name=${spec%%:*}; db=${spec#*:}
  sqlite3 "$db" ".backup '$DB_CUTOVER_DIR/$name.db'"
done
find "$DB_CUTOVER_DIR" -type f -name '*.db' -print0 | sort -z \
  | xargs -0 sha256sum >"$DB_CUTOVER_DIR/SHA256SUMS"
sha256sum --check "$DB_CUTOVER_DIR/SHA256SUMS"
chmod 0600 "$DB_CUTOVER_DIR"/*
```

## 5. Phase 3 - migrations

Run discovered commands in this order. Capture redacted JSON evidence; do not use `tee` if a tool may emit sensitive values.

1. **Application schema precheck:** validate the deployed migration framework and fresh targets; establish exact auth/application/Workflow schema versions and transactions. The authoritative wf-api set contains `auth.db`, `app.db`, and `workflow.db`.
2. **Auth import:** transactionally import accounts, original password-hash values, browser sessions, token digests, bootstrap state, and audit. Output only pass/fail, counts, stable-ID/timestamp/digest aggregates.
3. **Application-state import:** transactionally import wf-api queue, worker, runtime snapshots, and events into `app.db`; preserve duplicate runtime events and use legacy import keys only for idempotency. Reconcile counts and stable aggregates without exporting payloads.
4. **Workflow import:** stage projects/locations, memories/revisions/tags, documents/revisions, sync revisions/clients/conflicts, metadata, and FTS. Fail on duplicate IDs/slugs, path ambiguity, revision gaps, or content-hash drift. Publish in one transaction after shadow-read reconciliation.
5. **DSH offline copy:** destinations must not exist. Do not migrate `session-query.db`.

```bash
set -euo pipefail
cd "$MIGRATOR_DIR"
node src/migrate.mjs \
  --sessions "$DSH_SESSION_SOURCE" --storage "$DSH_STORAGE_SOURCE" \
  --session-db "$DSH_SESSION_DB" --state-db "$DSH_STATE_DB" \
  --descriptors "$DSH_DESCRIPTOR_FILE" --attachments "$DSH_ATTACHMENT_ROOT" \
  --compression "${DSH_SOURCE_COMPRESSION:-zstd}" >"$EVIDENCE_DIR/dsh-migrate.json"
node src/migrate.mjs --verify \
  --sessions "$DSH_SESSION_SOURCE" --storage "$DSH_STORAGE_SOURCE" \
  --session-db "$DSH_SESSION_DB" --state-db "$DSH_STATE_DB" \
  --descriptors "$DSH_DESCRIPTOR_FILE" --attachments "$DSH_ATTACHMENT_ROOT" \
  --compression "${DSH_SOURCE_COMPRESSION:-zstd}" >"$EVIDENCE_DIR/dsh-verify.json"
```

The DSH tool preserves session IDs, headers, ordered events, domain records/global values, and source stability. It verifies logical equality, sequence continuity, SQLite IDs/versions, counts, `integrity_check`, `foreign_key_check`, and attachment hashes. It removes both fresh DSH DBs if paired migration fails.

## 6. Phase 4 - reconciliation gate

With all writers stopped, verify every authority DB:

```bash
set -euo pipefail
for db in "$AUTH_DB" "$APP_DB" "$WORKFLOW_DB" "$DSH_SESSION_DB" "$DSH_STATE_DB"; do
  test "$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;')" = ok
  test -z "$(sqlite3 -readonly "$db" 'PRAGMA foreign_key_check;')"
done
```

Use migration-owned reconciliation, not row exports, to record:

- Auth: counts by entity; stable-ID/timestamp hashes; credential/digest aggregate equality without displaying digests.
- Application state: queue/worker/runtime entity counts and stable aggregate hashes from `app.db`; schema/integrity/foreign-key checks; no fallback JSON authority reads.
- Workflow: counts by entity/scope/status; maximum server revision/cursor; stable-ID/content-hash aggregates; tombstone/conflict counts; FTS source/index counts; global and per-project shadow reads.
- DSH sessions: session/event counts; per-session revision equality; contiguous `seq` from `0..count-1`; canonical logical hashes; attachment count/bytes/SHA-256 equality.
- DSH domains: record/global counts and canonical hashes for all three descriptors.
- Every DB: expected `application_id`, `user_version`, `integrity_check=ok`, empty `foreign_key_check`, owner/mode, and stopped-backup SHA-256.

Any mismatch requires rollback A. Do not hand-edit rows.

## 7. Phases 5-7 - smoke, public cutover, acceptance

### Establish the write boundary, then run loopback smoke

Complete and hash the coherent SQLite cutover-point backup before starting either service. Immediately before `systemctl start "$DSH_UNIT"`, set `sqlite_write_boundary_crossed=true` with UTC time because service startup may write schema, WAL, or runtime metadata. Only rollback B is permitted from this point.

Start only DSH and wf-api on staged SQLite config. Use discovered read-only health/describe endpoints; no login, model call, approval/question response, outbox apply, session creation, or user mutation.

```bash
systemctl start "$DSH_UNIT"
systemctl start "$WF_API_UNIT"
systemctl is-active --quiet "$DSH_UNIT"
systemctl is-active --quiet "$WF_API_UNIT"
ss -lntp '( sport = :3081 or sport = :8710 or sport = :8711 )'
curl --fail --silent --show-error --output /dev/null "$LOOPBACK_WF_HEALTH_URL"
curl --fail --silent --show-error --output /dev/null "$LOOPBACK_DSH_READONLY_URL"
```

Confirm `3081`/`8711` remain loopback-only. Probe Workflow context for a known existing project/cwd: require HTTP 200, `ok=true`, nonnegative revision, valid project, bounded context, and stable same-revision result. Do not print context; record only project ID, revision, byte count, and in-memory SHA-256.

### Public route and pre-write TUI check

Atomically activate staged public config/release and confirm the authenticated gateway route. On Windows:

```powershell
Set-Location E:\Workflow\dsh-client
.\Start-DshTui.ps1 -Check
```

This uses a harmless HTTPS `HEAD`, checks certificate trust/SAN, controlled fork, and Node, and does not authenticate. Never bypass TLS verification.

### TUI acceptance

The write boundary was crossed before service startup. Run `Start-DshTui.ps1` interactively so credentials/token remain in memory. Verify direct HTTPS login, authenticated unary RPC, both `/api/events.mux` and `/api/events.host` WebSockets, known Linux session resume/cwd, logical read/export, and reconnect. Do not request a real model reply or exercise approval/questions or the Windows bridge.

### Persistence and rebuilds

1. Record authority counts, revisions, and hashes; restart DSH, then wf-api. Confirm the issued token remains valid, existing browser session behavior is unchanged, data/context remain readable, and aggregates are unchanged.
2. Start watchdog, worker, then listener. Confirm revision/outbox/conflict behavior without model work.
3. Rebuild `session-query.db` from canonical sessions.
4. Use a fresh empty client `-CacheRoot`; confirm projections/index/cursor repopulate from server authority. Delete only this disposable acceptance cache after evidence.
5. Restart each writer in the same order and confirm active state, no revision regression/duplicate import, and no legacy-file writes.

## 8. Final acceptance and socat retirement

Require every manifest check, no legacy writes, restart persistence, empty-cache rebuild, and rollback-B backup verification. Only then:

```bash
systemctl disable --now "$SOCAT_UNIT"
test "$(systemctl is-enabled "$SOCAT_UNIT" 2>/dev/null || true)" = disabled
test "$(systemctl is-active "$SOCAT_UNIT" || true)" = inactive
if ss -lnt '( sport = :3080 )' | grep -q LISTEN; then exit 4; fi
```

Record final states/bindings, release/config hashes, DB backup hashes, and sign-off. Keep legacy sources and pre-cutover package read-only under retention policy; never resume legacy writers.

## 9. Rollback decision and orders

### Rollback A - before any new SQLite write

Condition: `sqlite_write_boundary_crossed=false`, including migration, reconciliation, or cutover-point backup verification failure. Public/loopback service smoke occurs after the boundary and therefore cannot use rollback A.

1. Stop wf-api, listener, worker, watchdog, then DSH.
2. Restore the prior release/config pointer atomically.
3. Quarantine fresh SQLite targets/sidecars as failed evidence; never merge them into legacy sources.
4. Verify pre-cutover archive and unchanged legacy-source hashes.
5. Start DSH on legacy persistence, then wf-api, watchdog, worker, and listener according to verified dependencies.
6. Verify old behavior. Socat `3080` was not disabled, so no socat state change is expected.

### Rollback B - after any new SQLite write

Condition: boundary true or uncertain. Never reactivate legacy writers or merge old files with new SQLite.

1. Stop wf-api, listener, worker, watchdog, then DSH.
2. Preserve a restricted incident snapshot/hash of the failed SQLite set without row dumps.
3. Restore the complete coherent cutover-point set for `auth.db`, `app.db`, `workflow.db`, `sessions.db`, and `dsh-state.db` from one `RUN_ID`. Do not restore `session-query.db` or `cache.db`.
4. Verify SHA256SUMS, owner/mode, SQLite schema/integrity/foreign keys, counts, and cross-DB set ID.
5. Activate the SQLite-compatible release/config. Start DSH, wf-api, watchdog, worker, then listener.
6. Rebuild session search and client caches, then repeat all smoke/acceptance/restart checks. Writes after the backup are intentionally lost and require incident accounting.
7. If socat was retired, re-enable it only with explicit incident authorization and only if required temporarily; otherwise keep `3080` disabled.

When the boundary is unknown, use rollback B. Do not perform row-level repair in the window.

## 10. Completion record

The run-specific manifest is the machine-readable record. It must contain UTC timestamps, change/operator identifiers, discovered values/evidence hashes, backup hashes, migration/reconciliation results, write-boundary time, acceptance results, final bindings/states, rollback mode, and sign-offs. It must contain no credentials or content values.
