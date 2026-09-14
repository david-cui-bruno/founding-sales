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
