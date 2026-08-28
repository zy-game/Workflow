# Bridge HTTP pull transport

The Bridge HTTP pull transport is a specialized Worker transport for external executors such as UnityBridge. Task publishers continue to create work through `POST /api/v1/tasks`. Core's task repository, claim rules, leases, interactions, and state machine remain the only authority; Bridge does not introduce a second task queue or a general task-claim API.

## Identity and scope

A Bridge uses a dedicated machine token with the `bridge` role. Core derives the Bridge identity from that token rather than accepting an identity asserted in a payload. The token carries an explicit project scope, and registration may only keep or narrow that scope. It must not use an administrator, publisher, or normal Worker token.

Every request uses JSON over authenticated HTTPS. A Bridge payload must contain logical project and task data only. Credentials, `file_select` values, secrets, machine-local paths, and environment variable values are prohibited from request payloads and logs. `credential` and `file_select` interactions are not supported by this transport; they remain Worker-local controlled flows.

## Routes

All transport operations use `POST`:

| Route | Purpose |
| --- | --- |
| `/api/v1/bridge/register` | Register or refresh Bridge capabilities, backends, projects, state, protocol version, and maximum concurrency. |
| `/api/v1/bridge/tasks/pull` | Recover active claims first, then claim eligible queued work up to available concurrency. |
| `/api/v1/bridge/tasks/:id/heartbeat` | Renew a live lease and obtain current task and interaction-delivery state. |
| `/api/v1/bridge/tasks/:id/events` | Append a bounded batch of progress or session events. |
| `/api/v1/bridge/tasks/:id/interactions` | Create a supported non-sensitive interaction. |
| `/api/v1/bridge/tasks/:id/interactions/:interactionId/consumed` | Confirm that a delivered interaction response was consumed locally. |
| `/api/v1/bridge/tasks/:id/result` | Submit one terminal `done`, `report`, `failed`, or `blocked` result. |
| `/api/v1/bridge/tasks/:id/release` | Return a claim that is still `dispatched` and has not started. |

Registration describes the Bridge as a pull-transport Worker. Pull uses the same project, selector, capability, backend, dependency, priority, Worker-state, and concurrency rules as normal Core dispatch. It returns claims already owned by the Bridge and still under an active lease before filling remaining `max_concurrency` slots. Retrying pull therefore recovers existing work instead of incrementing its attempt or claiming a duplicate.

## Replay and claims

Persist a stable `request_id` before sending any request whose response may need to be recovered. Core keys replay records by the authenticated Bridge identity and `request_id`:

- The same `request_id`, operation, task identity, and canonical JSON payload returns the original HTTP status and response without applying the mutation again. Object key order does not change payload identity; array order does.
- Reusing that `request_id` with a different operation, task identity, or payload is a conflict and must not be retried under the same ID.
- A retry after an ambiguous timeout must send the exact original request. A new logical operation requires a new ID.

Each pulled task includes a claim token and lease deadline. Heartbeats, events, interactions, consumption acknowledgements, results, and releases must identify the current claim as required by the route contract. Core accepts mutations only from the owning Bridge while the task is active, the claim token matches, and the lease has not expired. Heartbeat renews the lease; absence of a successful heartbeat does not prove that Core rejected the request, so retry it with the same `request_id`.

## Bounded exchange

Pull responses and event submissions are bounded exchanges, not synchronization dumps. Respect the server-advertised or rejected batch limits, keep each progress/session event small, and split event streams across requests while preserving event IDs and order. Requests must remain below Core's global 4 MiB JSON body limit; route-specific event count, event size, batch size, pull count, and result size limits may be lower. Treat a limit rejection as a request-shaping error, not as permission to omit terminal state.

## Completion and release

`result` is the terminal path. Core records exactly one `done`, `report`, `failed`, or `blocked` outcome and clears the claim and lease. An exact retry replays the first response; a different terminal submission is a conflict. Keep an unacknowledged terminal result locally until Core acknowledges it or replays the acknowledgement.

`release` is only for a claim still in `dispatched`, before local execution starts. It requeues the task and returns the undelivered attempt. A `running` or `awaiting_input` claim cannot be released as undelivered; submit an explicit terminal result or allow Core's lease policy to recover it.

## UnityBridge durability

UnityBridge must use durable local state with atomic updates. Before network transmission, persist the task ID, claim token, lease deadline, request ID and exact payload, client event IDs and ordering, pending interaction response and consumed state, and any unacknowledged terminal result. On restart, recover active claims with pull and replay pending requests verbatim. Remove a pending record only after Core acknowledges it.

Store the Bridge machine token only in an operating-system credential facility or inject it into the Bridge process at runtime. Never persist or print the token, secrets, local paths, or environment values as task data, replay metadata, diagnostics, or logs.
