# Jobs, retries and recovery

The queue and lease rules live in `packages/domain/jobs/`; actual worker execution is in `apps/worker/src/runner/`. The runtime registry is assembled by `registerHandlers` in `apps/worker/src/bootstrap/main.ts`. A module or historical job row does not prove that a handler or provider adapter is currently available.

## Scheduling and claiming

The scheduler materializes bounded due work. Runner slots claim supported kinds under leases and fencing. Urgent/bulk slot allocation prevents one queue from becoming the other's only execution opportunity. The process uses separate database sessions for scheduler, runners and metrics. Current startup refuses unsupported schema versions before ordinary work begins.

A lease or retry counter is not proof of a provider effect. Handlers must be idempotent at the business boundary and recheck current source/access/configuration/hold state after waits and before effects. Unknown external outcomes retain uncertainty and known or estimated spending. They are reconciled through supported recovery paths, never silently reset for an automatic retry.

## Registered capabilities

Current composition includes ordinary mail/classification, sequences/outbound, Today, retention, research/sourcing, calls and retained meeting work. Some handlers are conditional on a real adapter. Capture/extraction provider absence is an unavailable capability, not permission to construct a fallback. Generated Ask/index jobs, AI booking lifecycle, automatic email admission and recurring posting are not retained capabilities.

Old queued kinds and dead jobs require truthful supported diagnosis/recovery, not resurrection of removed source or deletion of their evidence. Consult [processes](processes.md) for composition and [runbooks](runbooks/README.md) for actual operator actions. Do not use job completion as a model-quality or contact-delivery claim.

## Stops and shutdown

Dispatch gates coordinate stop facts with provider work. A stop prevents fresh work at its defined boundary but cannot undo an already accepted provider request. On shutdown, loops drain in-flight work within their deadline and close sessions. Operational heartbeat/metrics describe process state; they do not authorize business actions.

Existing registry, runner, scheduler and domain/worker integration tests cover duplicates, stale leases, cancellation, unsupported kinds and recovery. Use controlled ports and disposable PostgreSQL for changes. Live job repair, deletion or replay is a separate authorized operation under the current release/safety procedures.
