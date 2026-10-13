# Safe email-readiness inspection: #635 under map #606

Research date: **October 13, 2026 UTC**. Email/read-only-access track only. **Not ready: no current runtime, control or sender observation was made.** Discovery recovery is another track.

## Decision

- **A noninteractive database-reading execution mechanism exists, but no currently authorized, zero-cloud-write executor covering the full #605 scope was established.** Existing operations tasks run read-only `fss` commands; launching a task still changes cloud state. Existing public health/status reads cover only part of the question.
- **Prefer a precise one-off infrastructure-operation approval under #552, with #605 owning the diagnostic outcome, before proposing application source work.** A frozen SELECT-only program in an exact existing image can collect documentary state without running sender maintenance. The retained custom launcher demonstrates capability, not present permission or complete supported coverage.
- Current operating rules restrict supported production writers to the serialized deployment workflow, which has no inspection-only mode. Consequently approval must explicitly resolve the one-off execution exception and its allowed transport, not merely approve SQL or imply permission to rerun an old script. If that exception is declined, stop and consider the narrow alternative below. Do not lift the release hold to obtain a read. [L1,L2,L3]
- Sender standing/readiness maintenance is intentionally persisted under closed #444. Its unsuitability for #607's no-mutation inspection is **not automatically a product defect** and does not justify redesigning admission or final-send safety. [L4]

## Evidence and authority boundary

Read AGENTS.md, domain instructions, GLOSSARY.md, ADR0002/0005/0009/0011, current-state and its operating roadmap, lean release procedure, sender-recovery seams, and full #635/#605/#607 bodies and comments through read-only `gh` on October 13. Inspected the existing private #605 investigation, relevant local source, exact d49 Git objects, and official public documentation. Local reference HEAD was `0de68981dd387a7eb40d7d9aec19fc8018547083`; working-tree source is not a deployed-build assertion.

#607 permits selected runtime/schema, sender/control and retained prospect reads **through existing authorized access**, excluding application/configuration writes and mutating nominal reads. #635 authorizes this research only and requires owner approval before publishing proposed execution slices. This worker's specific instruction excludes all live access even where standing authority otherwise exists. [I1,I2,I3]

October 12 18:13Z d49/schema88 application observations and October 10/11 controls remain dated evidence. Source targets schema105, but neither source HEAD nor a repository variable refreshes serving state. #605 retains an evaluated-build mismatch, missing full smoke bytes, and a previously repaired draft-processing concern. Reconfirm the actual build before choosing applicable dependencies, never make latest schema a blanket prerequisite. [L1,I2]

## Existing path matrix: application, database and cloud effects

| Existing path | What it can establish | Database/application effect | Cloud/authorization limit |
|---|---|---|---|
| `scripts/productionStatus.py` | Public health commit/schema; service stability; definition image digests and ECR retention; optional dated workflow result | Health schema query and metadata reads, no control operation | HTTP GET, ECS/ECR Describe and optional `gh run view`; optional local receipt write. Does not inspect actual running-task digests individually, sender controls, smoke bytes or DB release record. [L5] |
| `fss schema-version` / `migrate status` | Applied schema and invoking binary's declared ranges | Schema SELECT plus local migration-file inventory | Needs existing routed runtime connection or operations task launch. Not a migration and not deployment acceptance. [L6] |
| `fss admin release-record show` | Exact named stored release record | `readReleaseRecord` is SELECT-only | Task launch still needs operation approval. No `put`, smoke or verifier-proof reconstruction. [L7] |
| `fss admin send-path report` | Workspace switches, due/live enrollments, suppression, persisted ramp/day fields, prepared fences and follow-up permissions | Explicit `BEGIN TRANSACTION READ ONLY`, SELECTs, finally ROLLBACK | Existing task can invoke it noninteractively. Output contains mailbox address/firm names/IDs and is too broad for a public receipt. No admission evaluation/config/activation receipt, selected sequence binding or recovery-epoch projection. [L8] |
| `fss admin send-path preview` | Older per-enrollment condition projection, including persisted cap | READ ONLY; removes row locks for diagnostic use; `readRamp` plus `effectiveDailyCap`, not `ensureRamp` | A diagnostic, not current email-admission readiness; more prospect scope than first #605 snapshot needs. [L9] |
| `/outreach/email-admission/readiness` | Canonical server readiness | Reached receipt branch calls `readRampStanding` → `ensureRamp` → upsert + `assessInactivity` | Exclude from no-write inspection. Missing receipt can short-circuit, but unknown current state is not a safe-path guarantee. [L10] |
| `/outreach/control`, `/v2`; `/outreach/senders/standing`, `/v2`; `/outbound/status` with mailbox | Controls and fresh maintained standing | Control always reads standing per mailbox; standing explicitly ensures ramp; outbound mailbox status reads standing | All can mutate even while admission is disabled. Legacy response stripping does not remove underlying effects. [L10,L11] |
| `GET /diagnostics` | Schema, deployment/admin sending flags, mailbox coverage and operational health | Admin reading another owner's mailbox inserts access audit event | Not unconditionally zero-write and not a selected-mailbox control/binding executor. Do not bypass required audit to call it a read. [L12] |
| `fss verify`; activation preparation; release-record put | Writeability or newly persisted proof/control record | Verify INSERTs heartbeat then rolls back; other commands persist writes | Rolled-back writes are not a zero-write inspection. Operations default is `verify`, so omitted command is unsafe for this scope. [L13] |
| Retained `sender-after-read.py` | Historical selected controls/auth/cap/holds and original identity | Embedded REPEATABLE READ READ ONLY SELECT program with 15s statement timeout | Registers, runs and deregisters a definition, writes logs/files, uses dated selections and includes discovery/private IDs/addresses. **Never rerun verbatim.** Not full readiness coverage. [L14] |

A same-value `ON CONFLICT DO UPDATE` is still a write. Inactivity assessment locks the ramp and can insert/update recovery epochs and change its epoch pointer. `readRamp`/`readRecovery` are SELECT projections and `effectiveDailyCap` is pure computation, but they describe persisted recovery only. A newly due inactivity transition has not been assessed by such a read, so its cap must not be presented as canonical maintained allowance. [L11]

## Why database query capability is not an available authorized executor

Production RDS is private, with database ingress only from API/worker task security groups. No bastion/NAT or local reporting role/route is documented. `fss` can run locally given a routed connection, but this does not supply one or authorize credential extraction/new networking. [L15]

The documented in-VPC mechanism is a one-off operations task: exact worker image, runtime identity, fixed `fss` entry point, command override and CloudWatch output. Both current source and exact d49 register `schema-version`, `release-record show`, and `send-path report`. No generic SQL or complete #605 inspector is registered. `RunTask` cannot replace that entry point, so arbitrary SQL is not merely another existing `fss` argument. [L6,L8,L16]

The retained custom task uses a different frozen definition/program and registration. To collect the missing documentary fields without deploying new application code, the coordinator could propose that **specific reviewed operation** using the observed existing image and a narrowed program. It must be sanctioned expressly, including temporary definition changes, runtime role/secret injection without disclosure, bounded compute/log writes, cleanup and cost authority. Historical successful use is not present support or approval. [L14,L16]

Current `release_aws` restricts local production mutations; deployment workflow choices are only `automatic`, `review_prepare`, `reviewed`. Its ordinary write branch is release-held. Some internal launcher calls invoke AWS directly, but mechanical reach is not an exception to the documented writer policy. Do not spoof workflow/hold variables, run raw AWS to bypass restrictions, or broaden bootstrap approval. #552 must resolve the exact inspection-operation transport. [L2,L3]

## PostgreSQL 16 and AWS primary constraints

Official documents below were checked **October 13, 2026**. Retrieval date is not a claimed publication date.

1. PostgreSQL16 READ ONLY prohibits non-temporary INSERT/UPDATE/DELETE/MERGE/COPY FROM, DDL and specified administrative writes. It is not a promise of no physical disk writes; temporary-table data writes are an exception. REPEATABLE READ fixes visibility from the first query, whereas READ COMMITTED takes statement snapshots. Begin before any query, inspect all SQL/functions, avoid row-locking and external-effect helpers, set local statement/lock/idle bounds and always roll back/close. A final fresh transaction is needed for before/after control comparison. [P1]
2. Existing `send-path report` uses `BEGIN ... READ ONLY`, **not explicit REPEATABLE READ**. Its comment promising one snapshot is insufficient unless isolation is independently fixed. No bug ticket is inferred here; do not reuse it as a coherent full-snapshot receipt without checking the actual transaction mode. [L8,P1]
3. AWS ECS API supports only interactive Exec sessions, despite the CLI listing `--non-interactive`. A one-shot command carried in an interactive session does not become a supported noninteractive executor. CLI needs Session Manager plugin; configured tasks need Exec enabled and a running agent. These are not established live here. [A1,A2]
4. Exec cannot be enabled on existing tasks; it runs as root and needs writable agent filesystem, so read-only root filesystem is unsupported. Caller needs scoped `ecs:ExecuteCommand`; task role needs four `ssmmessages` Create/Open Control/DataChannel permissions. Custom KMS and session logging require additional permissions. Exec is neither a SELECT sandbox nor a zero-side-effect cloud read. No setup/IAM/service changes are proposed. [A2,A3]
5. RunTask starts new tasks, unlike Describe calls. Existing task launch entails compute/network/log activity; task-role passing and current executor permission must be verified by the coordinator without disclosing secrets. Neither SQL READ ONLY nor read-only diagnostic spending authorizes cloud registration/launch. [A4,L14,L16]

## Minimum proposed operation and stop conditions

**First, identity only:** selected public health and ECS service/definition/running-task image metadata plus immutable ECR identity, with UTC and applicable exact named release artifact pointers. Existing `productionStatus` is a partial starting path, not sufficient release proof. No smoke execution, broad logs, Terraform state or new provider dispatch. [L5,I2]

**Then, one selected workspace/owner/mailbox/approved reusable sequence:** freeze exact SQL/program bytes and serving image, runtime definition/role/network references, output allowlist, time/compute/cost ceiling and cleanup scope for coordinator review. One REPEATABLE READ READ ONLY snapshot, no maintenance helpers, no external providers. Return only:
- membership/account/status/generation/authorization equality and revisions, not credentials or addresses;
- admission enabled/revision, routine replies/calling booleans, evaluation/policy/prompt/config/mailbox/sequence/documentary receipt/release hashes and mismatch flags;
- selected sequence/version approval/retirement, five-step cadence and template/render comparison digests, not copy or unrelated inventory;
- mailbox coverage/auth flags, persisted ramp/lower caps/recovery/reservation/pacing summaries, relevant hold reasons/counts and unsettled states;
- private equality checks for original Shirley provider/enrollment identity and cancelled follow-up, emitting booleans only. [I2,L10,L11]

Start/end timestamps, executor/program/image hashes, transaction modes and bounded receipt hash are required. Compare control revision/enabled/config/receipt, independent switches and original identity again in a fresh closing snapshot. Concurrent background maintenance can change state independently; an unchanged read receipt is not proof no external writer existed. Unknown or changed state stops binding acceptance, never triggers repair. [I2,P1]

**Stop** on missing exact operation authority, incompatible/unknown build/schema, unsafe d49 ordinary-mail semantics, unexpected task/role/network/entrypoint, unsupported query/table, timeout/oversized output, any application/database mutation or unapproved cloud/provider operation, control drift, missing proof bytes, identity mismatch, holds/unsettled uncertainty, or cleanup failure. Preserve cap5/lower caps/ramp/windows, release/admission/routine-reply/calling holds, original identity and cancelled follow-up. Unknowns remain not ready. [I2,I3,L1]

Compute only exact-build explanatory comparisons offline, labeled **diagnostic projection, not canonical server readiness**. Do not manufacture a readiness SHA/receipt accepted by activation, infer fresh authentication/placement from dated proof, repair historical rows/holds, or infer usable reply/booking handoff from configuration. Ordinary runtime safety/acceptance remains separately owned. [I2,L10]

## Ownership check and ticket-sized recommendation

Read-only issue searches for read-only/inspection/readiness/sender plus full #425/#552 bodies found **#605 owns fresh disabled evidence, #552 owns supported release/access operations, #425 owns conditional admission, #550 owns consumed handoff**. Closed #444 intentionally supplies maintenance, closed #530 already repairs draft exclusion, and closed #576 inspects an encrypted acquisition proposal, not live email state. Do not duplicate these or impose Ask/native/schema105 blanket blockers. [I2,I4,I5,I6]

**Recommended decision, not a new published ticket:** #605/#552 coordinator compares these two bounded alternatives. Neither is currently executable under this research or standing read authority:

| Alternative | Smallest scope and caller outcome | Approval/dependency boundary |
|---|---|---|
| Exact owner-approved task exception | Freeze a selected-workspace SELECT-only program, existing observed image, isolated temporary definition, one launch, output/cost/timeout/cleanup limits. Produce fresh disabled documentary gate table and before/after receipt without application deployment. | An explicit #552 decision must authorize named registration/launch/log/cleanup writes **and** the exception to current serialized-write policy with an approved transport. Existing launcher is not sanctioned as-is. No bypass of `lib.sh`, hold or control gates. No exact packet exists or is approved yet. |
| Small supported workflow inspection slice | Add only an inspection mode to the existing serialized operations boundary and a scoped `fss` documentary reporter for the fields absent from existing reports. Freeze source/command/image/scope, fail closed, enforce REPEATABLE READ READ ONLY, sanitize before logging, retain receipt and close the task. No release/migrate/verify/record-put/Enable in this mode. | #552 must approve the supported execution contract, exact operation/cost/roles and any source/release prerequisites. Preserve the existing release hold rather than silently making inspection a hold bypass. A source merge cannot make the reporter available in an old deployed image. Outcome proof must exercise the actual approved transport. |

**Recommendation:** ask the narrow #552 transport decision first. A sanctioned exact task exception avoids new application code, but is not a default workaround. If the owner chooses a supported workflow instead, the above single inspection tracer is the demonstrated engineering gap: #605 cannot obtain its selected admission/config/receipt/sequence/recovery snapshot through existing no-write reports and current workflow exposes no inspection mode. The existing #604 discovery-recovery outcome may consume the same transport only with its separately frozen scope, never as authority for broad prospect exports. #605 owns email evidence; #552 owns access/workflow; #425 consumes readiness evidence.

Any new source slice is **proposal only, owner approval before publication**. Its acceptance needs public CLI/workflow scope and permission checks, real PostgreSQL write-refusal/no-change checks, privacy/timeout/unknown-schema refusals, task ambiguity/cleanup handling and a deployed authorized receipt. Preserve canonical standing/admission/final-send maintenance unchanged, expose absent/stale persisted recovery, and never emit an activation-usable readiness digest. A new pure-read application API is not demonstrated necessary for this one diagnostic, and would itself require reviewed deployment. No implementation or tests here.

## Sources

Local citations are inspected text, not executed paths:
- L1: `docs/operations/current-state.md`; `docs/sourcing/roadmap-20261007.md`; ADR0009/0011.
- L2: `docs/operations/lean-release-workflow.md:3-27`; `infra/scripts/lib.sh:137-160,761-813,884-929`.
- L3: `.github/workflows/greenfield-deploy.yml:22-51,116-122`.
- L4: `docs/agents/sender-recovery-seams.md`, especially the explicit permitted standing-read persistence paragraph.
- L5: `scripts/productionStatus.py:17-62,79-121`; `apps/api/src/health.ts:60-88`; `packages/domain/db/schemaRange.ts:53-61`.
- L6: `apps/worker/src/tools/fss.ts:455-456,526-549`; `apps/worker/src/tools/fss/migrate.ts:162-175`; exact d49 equivalents inspected.
- L7: `apps/worker/src/tools/fss/admin.ts:1129-1136`; `packages/domain/release/records.ts:204-213`.
- L8: `apps/worker/src/tools/fss/admin.ts:1143-1181,1187-1208,1549-1580,1679-1720`; current and d49 command registration.
- L9: same `admin.ts:2024-2038,2042-2080,2166-2172`.
- L10: `apps/api/src/routes/outreach.ts:26-40`; `packages/domain/outreach/emailActivation.ts:25-46`; `outreach/settings.ts:39-49,63-78`.
- L11: `packages/domain/outbound/ramp.ts:146-149,202-253`; `outbound/recovery.ts:25-55`; `apps/api/src/routes/outbound.ts:220-258`.
- L12: `apps/api/src/routes/diagnostics.ts:27-61`; `packages/domain/dashboard/diagnostics.ts:137-174`.
- L13: `apps/worker/src/tools/fss/verify.ts:70-120`; `infra/modules/cluster/main.tf:843-885`; `outreach/emailActivation.ts:54-72`.
- L14: retained `.context/all-roadmap-completion/approved-release-20261010/sender-after-read.py:9-24,27-48`, read as text only; private #605 investigation sections4/6.
- L15: `infra/modules/database/main.tf:136-139`; `infra/modules/network/main.tf:3-7,69-89`; `infra/modules/stack/outputs.tf:121-139`; `fss/admin.ts:1146-1153`.
- L16: `docs/greenfield/processes.md:463-523`; `infra/modules/cluster/main.tf:42-48,843-885`; `infra/scripts/lib.sh:735-929`.

Public contracts, full requested bodies/comments read October13:
- I1: https://github.com/david-cui-bruno/founding-sales/issues/635
- I2: https://github.com/david-cui-bruno/founding-sales/issues/605
- I3: https://github.com/david-cui-bruno/founding-sales/issues/607#issuecomment-6137888915
- I4: https://github.com/david-cui-bruno/founding-sales/issues/425 and https://github.com/david-cui-bruno/founding-sales/issues/552
- I5: https://github.com/david-cui-bruno/founding-sales/issues/444 and https://github.com/david-cui-bruno/founding-sales/issues/530
- I6: https://github.com/david-cui-bruno/founding-sales/issues/576

Official sources, retrieved October13,2026:
- P1: PostgreSQL16 SET TRANSACTION, Description/Notes: https://www.postgresql.org/docs/16/sql-set-transaction.html
- A1: ECS ExecuteCommand, interactive response semantics: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExecuteCommand.html and CLI option surface: https://docs.aws.amazon.com/cli/latest/reference/ecs/execute-command.html
- A2: ECS Running commands, prerequisites/command shell: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec-run.html
- A3: ECS Exec, Considerations/Configuring/IAM: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html and task IAM role, ECS Exec permissions: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
- A4: ECS RunTask, Description/Request Parameters: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html

Validation: source/Git-object and complete issue inspection, official constraints checked, existing ownership queried, document privacy/scope/line-count checked. No tests needed or run. Only this report is written. No script execution, credentials/.env inspection, live/cloud/database/provider access, new setup, paid calls, GitHub mutations, branch/worktree/commit, code changes, release, Enable or sends. Dirty repo and paused Ask remain untouched.
