# Private pairing operator

This is an operator-only command for an already deployed, explicitly selected worker. It is not an HTTP endpoint, app feature, backend provisioner or automatic activation step. Building or running a dry run does not authorize live issuance.

## Build and dry run

Use the repository-supported Node 24 runtime from this package directory:

```sh
node build-operator.mjs
node out/operator-pairing.cjs --help
```

The output is deliberately outside `dist/`, which Terraform archives for Lambda. It must not be copied into a Lambda artifact.

The command requires explicit `--account`, `--region`, `--table`, `--workspace`, `--expires`, `--scopes`, and absolute `--output`. Without `--execute`, it validates arguments only and performs no filesystem, credential or network IO. No arguments also displays help. A dry-run success does not verify identity, table existence or output permissions.

Workspace IDs use 1–128 letters, digits, underscores or hyphens. IDs beginning with `--` are deliberately unsupported by this CLI because that prefix is reserved for flags. Expiry is 30–600 seconds. Scopes are a unique comma-separated subset of `commands:write`, `events:read`, `google:grant`, and `pairing:revoke`. Desktop pairing requires both `commands:write` and `events:read`; do not issue a narrower bootstrap expecting desktop pairing to work. Additional scopes require explicit approval. The operator cannot issue emergency scope.

## Explicit execution boundary

Before adding `--execute`, obtain approval for the exact account, region, table, workspace, scopes and expiry. Independently establish which root/state owns the deployed worker. No example account or workspace is a live approval.

Execution requires an explicit environment credential snapshot: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials, `AWS_SESSION_TOKEN`. Obtain temporary credentials through the separately approved operator process. Never paste credentials into command arguments, logs, source files or this document. The tool does not discover credentials through profiles, shared files, SSO, credential processes, instance metadata or role-assumption chains. A configured AWS profile alone is insufficient.

After exclusively reserving the output, the adapter captures one immutable credential snapshot for both service clients. STS identity and DynamoDB DescribeTable must match the explicit account, partition, region, table ARN and ACTIVE status before issuance. Requests use fixed regional AWS endpoints, one attempt and a shared 30-second service-request deadline. Credential selection does not make remote authorization unnecessary. No cloud-wide inventory is performed.

## Private output and uncertain outcomes

Use an existing operator-owned 0700 directory, with no symbolic-link or other-user-writable ancestors. The output file must not exist. The command creates it exclusively with mode 0600, verifies ownership and link count, and fsyncs the file and parent before contacting AWS. POSIX ownership is required. Same-user/root attackers are outside this local boundary.

Issuance uses the existing WorkerAuth bootstrap transaction once. Only its hash is sent to DynamoDB. The plaintext code is written only to the private output, never stdout/stderr. Successful output requires both file and directory fsync. This does not offer atomic content publication: a crash may leave an empty or partial file.

Any error after issuance starts is **uncertain**, not proof that no bootstrap exists. Do not blindly retry or delete/reuse the output. Treat a potentially issued bootstrap as active until its expiry and reconcile privately. An empty reserved file is retained on preflight failure as well. File cleanup errors are reported as failures. SDK client destruction is best-effort and does not replace the primary issuance diagnosis. Do not upload this output with test evidence.

## What this does not do

It does not deploy infrastructure, configure the desktop endpoint, redeem a bootstrap, change research policy, start schedules, approve campaigns, grant Google permissions, send outreach or book meetings. Desktop configuration and pairing require the real reviewed workflow, and a normal restart may be required for its startup-bound connection. Synchronization may submit already approved queued commands and is not read-only.

## Local acceptance

Tests cover pure argument validation, real private-filesystem behavior, actual WorkerAuth orchestration with fictional SDK transport, exact adapter credential/endpoint boundaries, and the actual built CLI under denied filesystem/network access. The CLI network guard has a real socket negative control. Terraform mock plans are documented in the isolated root. None of these checks proves a live account grant, deployed table, successful pairing, or useful overnight sales workflow.

## Guided research setup

The desktop exposes **Settings → Sourcing → Cloud research**. It reads status until the user explicitly approves a first-use policy and two cumulative USD ceilings. Approval atomically creates the selector, discovery ledger and research ledger. It does not create a prospect, execute a provider request, activate a schedule or grant mail/calendar permissions. Existing legacy/orphan configuration requires operator reconciliation, not automatic adoption or budget reset.

Operators must separately review the actual provider capability and reservation assumptions before declaring `delegated_research_reviewed_capability` in the owning Terraform root. This optional non-secret JSON string defaults to empty, is limited to 3000 characters, and maps to `DELEGATED_RESEARCH_REVIEWED_CAPABILITY`. Its schema is `researchReviewedCapabilitySchema` in `src/shared/contracts/researchSetupContract.ts`: capability, review and expiry instants, provenance, per-job research reservation in micro-USD, and currency `USD`. Never put credentials in this metadata. A credential parameter declaration is separately required. Neither declaration proves connectivity, model eligibility or invoiced cost. Direct provider charges are not automatically covered by AWS credits.

The two ceilings are cumulative totals, not monthly allowances or top-ups. Reservations may remain charged against them after uncertain provider outcomes. Pause/resume preserves both ledgers and targeting. Pausing does not recall already-started requests. Descriptor expiry blocks new guided provider starts and resume, but does not prevent pause.

The desktop encrypts exact pending requests before transport. Refresh may reconcile an exact terminal receipt but never replays a mutation. **Retry exact pending request** preserves the original identity and payload. **Cancel pending request** can fence an uncommitted request, but if it already applied, cancellation returns that applied receipt and does not undo it. A normal restart retains pending work. The bounded immutable journal supports 128 operation generations and fails closed on corruption or exhaustion. Do not delete or edit it to clear an uncertain request. Reconcile with the owning workspace before any separately reviewed recovery.

Deployment, pairing, credential setup, actual research, scheduling and outreach remain separate approval and acceptance steps. An approved policy or passing offline workflow is not evidence of useful closed-Mac work.
# Research-only one-shot execution

The optional native `research.once` operation is for one bounded P1 research
attempt, not a recurring worker tick. It is disabled by default. Enabling
`delegated_worker_research_once_enabled` adds no public route, schedule, grant,
budget or credential. Continuous worker scheduling must remain disabled.

Before a live attempt, separately review the exact deployment, private research
SecureString binding and model descriptor. Admit the policy and cumulative
budgets through the paired app's **Settings > Sourcing > Cloud research** flow.
The approved policy must have `maxCompanies: 1`. Copying an existing desktop API
key to cloud storage is a credential transfer, not merely a billing decision.
Do not put keys in Terraform, command-line arguments, logs or invocation payloads.

Use an authorized IAM caller with `lambda:InvokeFunction` on the exact worker.
Use synchronous **RequestResponse**, disable caller retries (`AWS_MAX_ATTEMPTS=1`)
and use a read timeout greater than the function's 60-second timeout. The native
request is a strict JSON object with only:

```json
{
  "version": 1,
  "kind": "research.once",
  "workspaceId": "REVIEWED_WORKSPACE",
  "pairingId": "REVIEWED_PAIRING_UUID",
  "expectedSourceRevision": 1,
  "researchFingerprint": "EXACT_64_HEX_FINGERPRINT_OF_REVIEWED_RESEARCH_SETTINGS"
}
```

These placeholders are not valid inputs. Use the exact admitted selector's
identity, revision and canonical research-settings fingerprint, not a newly
invented run ID or a fingerprint of the whole selector. Neither possession of
IAM access nor pairing alone approves research. Do not send a fabricated
Scheduled Event or call the general source coordinator to bypass this path.
An HTTP body containing this JSON remains an HTTP request, not an internal call.

Inspect both Lambda `FunctionError` and the typed result. `completed` requires
durable evidence and job settlement. `empty`, `held`, `in-progress` and
`uncertain` are not successful research. After a lost response, query
`research.once.status` with the original request fields and explicit `runId`
before considering any further execution. Status is read-only and may inspect
the original receipt after a pause or descriptor expiry. It does not settle
jobs, replenish budgets or restart providers. If no run ID was received, derive
only the existing deterministic identity from the exact admitted settings. Do
not substitute a fresh transport UUID or widen configuration to retry.

Discovery diagnostics are **invocation-local**, not durable receipts. When a
provider failure reaches the production research-once boundary, it emits one
structured console warning with `event: research_discovery_uncertain` and an
allowlisted `reason`: `transport_uncertain`, `response_body_invalid`,
`http_rejected`, `envelope_invalid`, `search_receipt_invalid`, `output_invalid`,
`candidate_json_invalid`, `citation_missing`, or `consulted_source_missing`.
Only `http_rejected` may also include an integer `httpStatus` in 100–599,
excluding successful 2xx statuses. No raw cause, message, body, prompt, key or
URL is emitted. Lambda supplies invocation correlation. Result objects are
unchanged. Replay and status reads do not emit or reconstruct the past reason,
including historical failures predating these diagnostics. Admission/preflight
refusals are not classified as provider failures, even if they occur after a
reservation and leave an uncertain result. Console emission is best-effort and
its failure does not alter the result or start retries. A deadline can end the wait
before a provider classification reaches this boundary, so absence of a warning
is not evidence that a provider request did not start. Timeout/cancellation and
transport loss remain uncertain. Logs are not billing proof and do not justify
retrying, reclaiming reservations or claiming uncharged spend.

The same durable identity retains discovery and page reservations after an
unknown outcome. Abort does not prove a remote request was cancelled or unbilled.
Application reservations are conservative cumulative accounting, not an AWS or
OpenAI invoice cap. IAM Invoke permission on this shared function is not a
JSON-kind restriction. Existing bearer authentication still protects HTTP
requests, and the absent schedule binding prevents schedule execution in this
profile. A separately isolated principal/function would be a different design.

For the actual P1 acceptance check, close the desktop before Invoke, retain the
durable result, then reopen and synchronize the resulting account/evidence
through the supported app workflow. A local harness, an accepted Invoke or an
empty queue does not prove useful closed-app completion. Do not enable mail,
calendar, calls, outreach or a continuous schedule for this check.

### One bounded successor of the original guided run

The private native boundary also supports `research.once.admit-next` and
`research.once.admit-next.status`. These are not public HTTP routes, schedules,
new grants, a reset facility or a general research-cycle service. Admission
requires the original deterministic run bound to source revision **1**, unchanged
settings and reviewed descriptor, a currently paused source revision **2**, one
company, and an incomplete original reservation with null candidates and cost.
The original row and retained discovery spend are never cleared or rewritten.

Review and retain the exact admission payload before invoking it. The strict
mutation fields are `version: 1`, `kind: research.once.admit-next`, `workspaceId`,
`pairingId`, `parentRunId`, `parentSourceRevision: 1`, `researchFingerprint`,
`expectedSourceRevision: 2`, `descriptorFingerprint`, `expectedDiscoveryBudget`,
`expectedResearchBudget`, and `proposedDiscoveryLimitMicros`. Each expected budget
is the exact `{limit, spent, approvedAt}` snapshot. The original discovery limit
and retained spend must both equal one reviewed descriptor discovery reservation.
The proposed cumulative limit must add exactly one more such reservation. All
amounts and the combined discovery/page ceiling must remain safe integers.
No caller-selected successor ID, model, URLs, request UUID or budget ID is accepted.

For a $1 reviewed discovery reservation, admission changes the cumulative
ledger from `$1 limit / $1 retained` to `$2 limit / $1 retained / $1 remaining`.
The original `approvedAt` remains unchanged. The page ledger remains unchanged,
must have zero retained spend and sufficient capacity for one reviewed page
reservation. Admission does not load credentials, invoke research, enqueue work
or activate the source. One transaction updates only the discovery ceiling and
creates the immutable `RESEARCH_ONCE_NEXT#<parentRunId>` receipt, with distinct
CAS checks on the parent, source, marker, admission fence, pairing and page ledger.

The result kind is `research.once.admit-next.result` with `state` of `applied`,
`held` or `not-observed`, and `receipt` or null. An applied receipt contains the
validated request, `fingerprint`, server-derived `successorRunId`,
`expectedExecutionRevision: 3`, original parent revision/fingerprint, exact
`deltaMicros` and `recordedAt`. Exact replay reads that same immutable receipt
without another increment, including after Resume, later spend, expiry or pairing
revocation. A different payload cannot take the same slot. Historical readback
does not authorize new work after revocation.

After any unknown admission acknowledgement, reconcile using the exact status
request: `version: 1`, `kind: research.once.admit-next.status`, `workspaceId`,
`pairingId`, `parentRunId`, `parentSourceRevision: 1`, `researchFingerprint` and
`admissionFingerprint` (the fingerprint of the original saved mutation, also
returned as `receipt.fingerprint`). Status performs only an exact strong receipt
read. **`not-observed` means absent at that read, not cancelled or guaranteed not
to commit later.** A read failure remains unavailable/unknown. Do not generate a
new identity or automatically retry. A separately reviewed exact resubmission
uses the identical payload and fixed slot, so a late transaction and exact retry
can create at most one receipt/allowance. A deadline stops waiting but cannot
undo an already-dispatched transaction.

Use existing **Settings → Cloud research → Refresh**, inspect the unchanged
paused policy and amended cumulative ledger, then explicitly **Resume** to
revision **3**. Execute the existing native `research.once` request at revision 3
with the original settings fingerprint and the additional all-or-nothing field:

```json
{"successor":{"parentRunId":"<original-run-uuid>","admissionFingerprint":"<receipt-fingerprint>"}}
```

This is a selector only. The worker validates the immutable receipt and original
parent, then resolves the derived run internally. Repeated pause/resume that
skips revision 3 cannot rebind this receipt. Normal original execution never
silently selects a successor. Existing `research.once.status` can inspect the
returned successor UUID at revision 3, while original historical status uses the
original UUID and revision 1. These exact historical reads remain available under
the private IAM read boundary after pause, expiry or revocation.

Successor reservation retains the second descriptor-sized discovery amount
($2 retained total in the $1 example). Its receipt, job and page ledger evolve
normally, including evidence-to-settlement crash recovery when both budgets are
fully reserved. Admission's old free-budget snapshots are not perpetual execution
conditions. Only the immutable original parent and admission receipt are added
to existing execution guards. One successor is the hard limit: uncertain or empty
successor output stops again without a third attempt. Keep both histories and
reconcile supported receipts rather than editing tables, retransferring a key or
widening policy. Admission success and logs are neither billing proof nor proof
of useful researched-account completion. Closed-app execution and supported app
synchronization remain separate acceptance steps.

### Discovery output shape

Discovery requests use Responses `text.format` with a strict JSON schema for
`{companies: [{name, domain, sourceUrl}]}` in the existing single web-search
request. This constrains shape, not truth: local field bounds, URL/domain policy,
exact citation membership and consulted-source membership remain mandatory.
Invalid output is never repaired by stripping prose or requesting another model
response. An unsupported-format HTTP rejection is retained as `http_rejected`,
without fallback or retry.

The [model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
lists Structured Outputs for the pinned model, and the
[Responses guide](https://developers.openai.com/api/docs/guides/structured-outputs)
documents the request format. These references and offline request-contract tests
are not live proof of the combined web-search, schema and citation behavior.
`candidate_json_invalid` still means JSON syntax **or** local candidate-schema
validation failed; it does not identify which field or recover historical output.
Changing the request shape does not authorize another attempt, reset retained
spend or change the immutable successor admission limit above.
