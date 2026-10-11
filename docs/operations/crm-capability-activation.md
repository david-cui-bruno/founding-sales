# CRM capability preparation and activation

This is the schema88 source contract, not an activation or release approval. Production and the signed desktop must first pass their separate release and native acceptance gates. Automatic email admission, routine replies, sender caps and all existing holds are independent and unchanged.

Normal authenticated commands prepare disabled metadata, email capture, extraction or Ask settings. Saving settings clears the previous activation binding. Readiness compares the **resulting activation revision** to independently reviewed authority. A configured capability with no current authority remains unavailable. The desktop shows readiness and exact activate/disable actions; it cannot manufacture a provider grant, review reference or evaluation result. Disable remains available when a mailbox disconnects or authority expires.

An operator prepares a strict body-free `crmCapabilityAuthorityReceiptSchema` document only after independently verifying its references: actual provider consent and account generation where applicable, source owner and privacy scope, deletion acceptance, current release and image digests, data handling, access, and approved funding. Mail acquisition needs actual acceptance; hosted AI needs actual representative evaluation. Controlled fixtures and diagnostic pilots cannot establish activation authority. Semantic, embedding and support configurations remain unavailable until a supported implementation and measured evaluation are separately approved.

The existing migration task identity can store a reviewed receipt. The application identity has SELECT access only and cannot provision or revoke receipts. Use the current reviewed worker image and ordinary in-VPC task launcher; do not use desktop credentials or direct operator SQL.

```
fss admin crm-authority provision --json reviewed-receipt.json --sha256 <reviewed-canonical-receipt-sha256> --report provision-report.json
fss admin crm-authority revoke --workspace <workspace-id> --receipt <receipt-id> --reference <reviewed-revocation-reference> --report revocation-report.json
```

`--json-base64` may replace `--json` for the task override. The hash is SHA256 of the strict parsed canonical receipt (`crmCapabilityAuthorityFingerprint`), not arbitrary file bytes. Both commands require the separate migration credential and resolve database dependencies only. Provisioning enables nothing. Identical provision retries retain the original immutable receipt; different content under its identity is refused. Revocation is one-way and serializes with final activation/publication checks.

The administrator then uses the normal authenticated capability activation command or desktop action with the exact read revision and independently provisioned receipt identity. The server rechecks release, owner, account, disclosure, evaluation, expiry and runtime adapter support under locks. Provider consumers recheck after external waits, and final publication retains the same transaction locks. Known observed provider charges settle even if publication loses authority; uncertain dispatches conserve reserved allowance.

OAuth scope observations are recorded only from actual normal provider callback responses. An old connected mailbox without this observation does not acquire invented scope proof. A fresh normal consent/reconnect and exact acceptance evidence may be needed. Historical email processing additionally needs the existing bounded import scope and independently verified read allocation; enabling capture alone grants no history import, enqueue or quota expansion. Trusted operations can record a strict `crmReadAllocationSchema` document through `fss admin crm-read-allocation put --json reviewed-allocation.json --sha256 <crmReadAllocationFingerprint> --report allocation-report.json`. It requires current owner/account/generation, an active administrator review, dated unexpired verification, bounded headroom and exact revision; immutable audit records bind the reviewed document digest. Runtime-role provision is refused. This records an allowance only, calls no provider and creates no import or job. A separate exact `mail_backfill` authority receipt still binds its allocation fingerprint and already frozen import interval. Mutations and altered idempotent retries are refused; revised allocations invalidate old authority.

Each capability remains independently disabled until its own gates pass. Preserve the release hold and the original cancelled Shirley follow-up and LinkedIn test. A new external LinkedIn test requires a separately reviewed exact proposal after preparation and release acceptance.


## Approved simplification — October11

ADR0009 now defines a monitored David-only provisional quality tier separately from representative quality; #581 must implement and verify that policy before it can authorize hosted work. Existing actual_representative runtime guards remain effective until then. This document is historical schema88 source guidance, not an instruction to bypass those guards. #580 will coordinate normal protected releases; #581 will resolve precise readiness and assemble independently reviewed trusted evidence. Existing Activate/Disable and receipt discovery are reused. Exact bindings remain; refreshed release receipts can reuse applicable verified evaluation without claiming it was rerun.

ADR0010/#547 now default to a disposable local real-Google/API/worker/PostgreSQL test with the separate diagnostic project. The temporary AWS proposal/rerun is superseded. Local acceptance does not prove production callback/secrets/watch configuration, ordinary recovery, native delivery or model quality. No real grant/read, paid call, release or activation follows merely from this document update.

## Final approved lean operating model — October11

The grilling decisions are settled: normal breakage/short maintenance/hours of forward repair are acceptable; preserve data/history, source/member access and unintended-send controls. Merge normally auto-deploys app and explicitly eligible routine migrations after focused CI. Destructive/privilege/unknown changes require one review; the current88→99 backlog remains specifically held.

#580 is now automatic delivery using existing stop/migrate/start and proportional CI, not a new release platform. #581 is ordinary authenticated owner consent/configuration plus audit and persistent Enable/Disable, replacing independent privileged per-release capability receipt provisioning. Changed data/provider/model/purpose/budget scopes require real owner approval; unchanged releases preserve valid settings. The provisional David-only quality policy remains, with Codex technical checks, actual model integration, a useful reviewed labeled set and a few owner usefulness judgments.

ADR0009 latest amendment and ADR0011 record this final design. This supersedes the earlier trusted-assembler/technical-rebinding proposal. #547 remains disposable local real-Google acceptance. Current source still implements the old mechanism until #581 replaces it; no bypass or fixture mode is allowed. No provider read, paid call, role change, current held rollout or activation occurred in this reconciliation. Sending/calling/admission controls remain unchanged.

Parallel implementation frontier is #547/#580/#581, with one integration owner for shared schema/contracts. #548 preparation can proceed independently; #549 follows actual capture and final #550/#551 depend on implemented owner setup and applicable source/evaluation evidence. No additional simplification tickets were added.
