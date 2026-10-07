# Current operating state

Application last verified: October 7, 2026, 22:21 UTC; reusable campaign prepared October 7 at 22:24 UTC. This is a dated snapshot; read live state before any operational change. Historical checkpoints are evidence, not current authorization.

## Decisions and priorities

Read [the operating roadmap](../sourcing/roadmap-20261007.md). Preserve original targeting, budgets, recipient evidence, ownership, stops and validation. David handles substantive replies and calls; no recipient-review queue, routine reply automation or autonomous calling. Automatic verified-fit selection/contacting is authorized only after exact-version evaluation and sending-path verification. Three conversations is an outcome target, not a development gate. Use installed Matt Pocock skills; historical Superpowers records are evidence only.

## Production and sending

- Verified production commit: `13df13428380fd19c18abcf57b54e0a778d6bfd6`, schema61; worker107 and API106. Main gate37683535790, images37683535618 and deploy37684205634 attempt2 passed, including smoke and existing exact-record readback. `FSS_PROD_COMMIT` matched after verification.
- Only Shirley's original enrollment/message exists. First step is October8 15:00Z (10amCentral/11amEastern). At verification: zero attempts, no provider ID or sent timestamp. Preserve the original step; do not re-enroll or force a retry.
- Domain sending enabled, mailbox authorizationrevision1 enabled, initial cap5, zero healthy days, no overrides. A historical held reason is not the current domain control. Routine replies and automatic admission remain off.
- Received-email authentication, first durable send and subsequent cadence remain unverified. Global API health is not mailbox-specific permission or inbox-placement evidence.
- Read-only first-send check remains11:10ET; discovery yield check22:35ET, ordinary discovery due around22:24ET. Preserve scheduled checks and discovery budget; exclude manual staging from yield.

## Next work

The single-prospect atomic admission path is implemented for #420 and remains unreleased: a worker capability binds current candidate/run, evaluated policy/prompt, active owner/mailbox and approved sequence, with transactional rollback, deduplication, stops and capacity checks. Normal API activation and the schema62 `CHECK(NOT enabled)` block remain intact. #421 still needs to connect deterministic ranking and bounded scheduling; #422–#425 retain outcome visibility, representative evaluation, actual sending/authentication verification and conditional activation. Existing email-fit predicate is not activation. Six selected source cases are diagnostic, not representative precision. Neutral reusable five-email copy is now imported, approved and published as sequence version `da30fb87-ae6f-44ee-b91f-989e9ff577ba`, with offsets 0/3/7/13/20 and no enrollments. Preparation used current production content functions and verified identical sending-state hashes before/after, preserving Shirley and all controls. The disabled control API/schema62 is implemented for #419 and is not deployed; automatic admission is still unavailable. Inactivity and incident recovery need further work.

## Evidence and refresh

Local evidence: `.context/email-fit-release-verification.json`, `.context/email-fit-runtime-state.json`, `.context/email-fit-evaluation.json`, `.context/verified-fit-preparation-receipt.json`, `.context/email-controls-production-status.json`. The reusable copy definition is committed as `docs/sourcing/verified-fit-campaign.json`. These are local artifacts, not guaranteed in a fresh clone. GitHub release evidence is linked by run ID above. Keep credentials out of status files.

Run `python3 scripts/productionStatus.py --expected-commit <commit> --deploy-run <run-id> --out .context/production-status.json` with the existing AWS operator profile/region. It reads health, service rollout, task-image retention and workflow evidence; it does not attest mailbox controls, replace the normal release smoke/readback or change any state. For mailbox controls use the normal authorized product tools or a scoped read-only operations task; never reuse desktop credentials.

Update this snapshot once after a completed verification, linking evidence and naming what remains unknown. Put superseded session details in local `.context/handoff-history-20261007.md`; the compact root handoff points here.
