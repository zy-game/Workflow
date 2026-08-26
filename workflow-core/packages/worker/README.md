# Workflow Worker

The Worker daemon is the only execution process connected to Workflow Core. It claims tasks over the authenticated `/worker` WebSocket, resolves project and backend configuration locally, and keeps backend sessions and sensitive credentials on the Worker host.

## Start the daemon

```js
import { loadWorkerConfig, startWorker } from '@workflow-core/worker';

const worker = await startWorker(loadWorkerConfig());
```

Required environment:

```text
WFC_CORE_URL=http://127.0.0.1:8710
WFC_WORKER_TOKEN=<worker-machine-token>
WFC_WORKER_ID=<stable-worker-id>
WFC_WORKER_CAPABILITIES=workflow-jsonl
WFC_WORKER_STATE_DIR=<persistent-local-state-directory>
WFC_JSONL_COMMAND=<workflow-jsonl executable>
WFC_JSONL_ARGS=<arg>|<arg>
```

`WFC_WORKER_TOKEN` is read only by the Worker process. It is not included in task payloads, logs, environment profiles, or backend child-process environments. Credentials and file selections are handled through Worker-local controlled flows; credential values never pass through Core.

## Backend contract

Backends expose a stable, vendor-neutral lifecycle: `describe()`, `checkHealth()`, `start()`, `run()`, `resume()`, optional `inject()`, `cancel()`, `resolveInteraction()`, and `dispose()`. Standard events include session, assistant, tool, progress, interaction, completion, and failure events. The Worker maps these events to Core frames and keeps vendor protocols out of Core.

## Workflow JSONL backend

`src/adapters/jsonl.js` starts one local child process per backend session. The process reads one request per line:

```json
{"type":"run","task_id":"t-1","session_ref":"bridge-1","workspace":"/work/app","prompt":"fix the failing test","task":{}}
{"type":"inject","task_id":"t-1","session_ref":"bridge-1","content":"keep the change minimal"}
{"type":"cancel","task_id":"t-1","session_ref":"bridge-1"}
```

It emits normalized messages:

```json
{"type":"session","session_ref":"vendor-1"}
{"type":"event","event":{"type":"assistant_message","text":"..."}}
{"type":"progress","note":"running","percent":50}
{"type":"result","kind":"done","session_ref":"vendor-1","result":{"summary":"done"}}
```

The bridge must implement this protocol explicitly; the Worker does not interpret arbitrary vendor stdout. Do not put API keys, Core tokens, or local secret material in JSONL messages.

## Local state and safety

Run state, replayable outbound frames, project roots, and non-secret environment profile metadata are stored beneath `WFC_WORKER_STATE_DIR` with restrictive permissions and atomic updates. Project roots are canonicalized and overlapping registrations are rejected. Backend working directories are selected from registered Worker-local projects rather than paths supplied by Core.
