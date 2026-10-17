# Standing LinkedIn outreach policy

Source settings contract for #627, using the settled October 13, 2026 decisions in #634. This is not native LinkedIn, provider/model quality, release or activation acceptance.

## Normal authenticated settings journey

All endpoints are POSTs with the ordinary bearer session. The owner and workspace come from that session, never from a submitted owner identifier.

1. `/social/linkedin-policy/read` with `{}` returns selectable personal LinkedIn accounts with exact current revisions, the canonical rules to disclose before approval, current saved policy, approval date, independent technical holds and `enabled: false`. `identityVerified: false` explicitly distinguishes the existing posting connection flag from actual outreach identity verification.
2. `/social/linkedin-policy/save` uses the existing command envelope (`commandId`, `clientVersion`) and requires `expectedRevision`, selected `accountId` and `accountRevision`, `approved: true`, `approvedRulesVersion: "634-2026-10-13"`, and explicit `dataScope`, `acquisitionBinding` and `generation` values. Unknown scope/configuration is `null`, not invented authority. The allowed data scope is `founder_sales_business`. An acquisition binding is a proposed configuration UUID/revision, not proof of available source access or coverage. Generation is either null or the exact frozen Haiku route/data-handling/grant binding and separate $2/day, $25/New York calendar-month allowance defined in `packages/contracts/src/linkedinPolicy.ts`. Submitted configuration references remain visibly unverified.
3. Read again to see the exact approved snapshot, including the selected account's external identity, acquisition/model bindings and all fixed action, cadence, stop, retention/deletion, spend and reusable-voice rules. Saving is explicit approval of this revision, never Enable or sending.
4. `/social/linkedin-policy/disable` and `/social/linkedin-policy/revoke` require the command envelope and current `expectedRevision`. Both advance revision and clear current approval. A fresh save with explicit approval is required to restore standing approval. All revisions and body-free audit facts are retained.

Mutations share ordinary job-command receipts. Retrying an identical command returns its historical result without another mutation. A historical accepted save receipt can therefore describe a policy that is now revoked. Always use a current read/check before consuming authority. Conflicting revisions return `stale_revision`, and conflicting payloads for the same command ID are refused by the common command runner.

## After-wait and restart barrier

The ordinary owner API `/social/linkedin-policy/check-current` accepts the work's `expectedRevision`, `accountId` and `accountRevision`. It returns `current` for the approval binding, its reason/holds, and `allowed: false`. This is deliberately not dispatch permission.

Trusted worker consumers use the exported `checkLinkedinPolicyForWork` with an actual system-worker repository context and a durable work binding containing `ownerUserId`, `expectedRevision`, `accountId`, and `accountRevision`. It does not impersonate a user, cannot be called by a human/scheduler, and cannot select an owner through the normal API. It returns the approved snapshot only when that binding is current.

Every domain operation must run in a transaction. Account and policy locks, current owner membership and selected account revision/identity are checked together. Do not hold these transactions across an external wait. Check again in a new transaction after waits/restarts and immediately before any later admission/publication. Disable/revoke, new policy/source/model bindings and account revision changes invalidate old bindings. Runtime consumers must additionally recheck actual source access/deletion and acquisition configuration, manual-count/reply coverage, provider/data/model bindings, spend reservations, native readiness and scoped Enable. An opaque saved source reference cannot establish those facts.

Policy stop/check operations do not delete accepted observations, settle away incurred charges, recall native submissions, cancel posting work or change unrelated social settings. Retention/deletion consequences are represented in the approved rules; this settings slice does not acquire or process conversations or implement a provider-original deletion path.

## Acceptance evidence

`apps/api/test/linkedinPolicy.test.ts` exercises real PostgreSQL through ordinary signed sessions and command/read dispatch, with application-role sessions for concurrent mutation/restart and the trusted worker barrier. It covers complete #634 rule readback, precise approval version, selectable account revision readback, unknown settings and unverified model/spend visibility, two-workspace/owner isolation, disable/revoke/replay, account/source binding changes, controlled signed clocks around both DST transitions, concurrent save/revoke, a controlled local HTTP account-observation wait followed by revoke, preserved unrelated posting/weekly state, and membership departure during a real PostgreSQL lock wait.

These tests prove settings/source behavior, including time-policy representation, not real LinkedIn identity/capture/manual counting, prospect scheduling/count enforcement, paid model usefulness, voice calibration, actual source-deletion execution or deployment/Enable. Those remain their scoped runtime and operational acceptance checks. No live account action, model call, outreach, deployment or Enable is part of these tests.
