# LinkedIn connection, manual work and history

Settings → LinkedIn exposes account connection only. Connecting does not authorize outreach or posting. The retained product supports manual drafting and an account-bound manual activity ledger, not recurring automatic publication or a promise of supported invitation/message automation.

## Desired direction, October22 2026

David's completed product interview changes desired scope, not the retained implementation above. LinkedIn browser-automation platform permission is already obtained, do not ask again. Plan review-first sequence/message/post/comment drafts for PM-company customers, roughly one post/day, with exact approved work later performed by existing Jcode/Dot/other runners plus scheduling/shared CRM history. No new automation platform or unattended LinkedIn DMs/posts. Facebook personal-profile/business-group work remains research-only, no groups vetted or publication authorized. See the [canonical plan](../../apps/web/PLAN.md). No provider actions, channels, limits or current holds change from this documentation.

## Operational authority

The manual ledger lives in `packages/domain/crm/linkedinManual.ts` and its access/read/stop helpers. Preserve the actual account/profile, person/firm association, channel history, unknown activity and current actor authorization. A recorded manual action must describe what happened, not fabricate a provider receipt or imply a draft was delivered.

Replies and refusals stop follow-up under current rules. Switching profiles or channels does not reset history, allowances or uncertainty. A connection status is not conversation coverage, and a missing observed reply is not proof of no reply. Do not broaden contact groups, limits or channels through a settings save.

## Retained versus removed

Manual post drafts and supported account connection remain. Recurring posting policy/jobs and their Settings mount are removed. Historical posting records and required deletion/history boundaries remain. No historical policy grants fresh approval for a new external action.

David's approval is required before LinkedIn actions or contacting people. See [current state](../operations/current-state.md), the [manual handoff contract](../sourcing/social-manual-handoff-contract-20261009.md) and [native acceptance limitations](../sourcing/linkedin-native-acceptance-460.md). These documents are source/setup context, not live permission.

Existing API/domain/manual-ledger and connection-renderer tests cover account binding, stale input, access refusal, stops and unknown activity. Local components and mocked adapters do not prove native capture or live LinkedIn feasibility. Do not perform OAuth, invitations, messages or publication as part of source verification.
