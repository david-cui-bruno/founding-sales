# LinkedIn connection, manual work and history

Settings → LinkedIn exposes account connection only. Connecting does not authorize outreach or posting. The retained product supports manual drafting and an account-bound manual activity ledger, not recurring automatic publication or a promise of supported invitation/message automation.

## Desired direction, superseding October22

The October26 full-build decision supersedes the October22 manual-only/review-first target with founder-voice automatic publishing on supported public platform/account/routes, without blanket per-post review. Public Conversations are not DMs. LinkedIn browser-automation platform permission is already obtained, do not ask again. See the [canonical plan](../../apps/web/PLAN.md) for the finite implementation queue and [current state](../operations/current-state.md) for actual adapters and holds. Desired scope is not a claim of live support or permission for a current LinkedIn action, new channel/contact group, provider, spend or higher limit. Manual drafting/ledger fallback remains supported.

## Operational authority

The manual ledger lives in `packages/domain/crm/linkedinManual.ts` and its access/read/stop helpers. Preserve the actual account/profile, person/firm association, channel history, unknown activity and current actor authorization. A recorded manual action must describe what happened, not fabricate a provider receipt or imply a draft was delivered.

Replies and refusals stop follow-up under current rules. Switching profiles or channels does not reset history, allowances or uncertainty. A connection status is not conversation coverage, and a missing observed reply is not proof of no reply. Do not broaden contact groups, limits or channels through a settings save.

## Retained versus removed

Manual post drafts and supported account connection remain. Recurring posting policy/jobs and their Settings mount are removed. Historical posting records and required deletion/history boundaries remain. No historical policy grants fresh approval for a new external action.

David's approval is required before LinkedIn actions or contacting people. See [current state](../operations/current-state.md), the [manual handoff contract](../sourcing/social-manual-handoff-contract-20261009.md) and [native acceptance limitations](../sourcing/linkedin-native-acceptance-460.md). These documents are source/setup context, not live permission.

Existing API/domain/manual-ledger and connection-renderer tests cover account binding, stale input, access refusal, stops and unknown activity. Local components and mocked adapters do not prove native capture or live LinkedIn feasibility. Do not perform OAuth, invitations, messages or publication as part of source verification.
