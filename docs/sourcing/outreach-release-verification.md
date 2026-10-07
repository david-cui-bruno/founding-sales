# Outreach verification — 6 October 2026

Historical verification record. For current release, pauses and authorization, read [current operating state](../operations/current-state.md).

## Release state

Live readback on 6 October confirms production runs `61727744b3934f6bee328725b313348ad9b1a8bb` on schema 56, accepting desktop 1.0.47 or later. GitHub rehearsal run 37409891914 completed successfully. The previous unreleased/schema-51 status below was stale. This document is a running verification record, not authorization to lift sending. Publish compatible desktop 1.0.47 before deploying schema 56. No production prospect authorization, cohort, reply setting or sending switch was changed.

## Verified behavior

- Exact connected mailbox authorization remains separate from the domain pause. Source qualification, ownership, stop facts, capacity and current approved content are checked before dispatch.
- A selected cohort preview makes no enrollment; a changed preview is refused; enrollment creates firm-owned outreach without manufacturing deals. Source evidence can be inspected in the preview. Existing cold legacy rows remain excluded.
- Email-first plans use five touches over 21 days; call-first plans use four calls and four emails. Shared reservations coordinate firm/date capacity and retain ambiguous acceptance.
- One incoming message can authorize one routine response, expiring after 48 hours. The reply is composed from approved facts and an approved template, with frozen thread headers. Source changes, takeover, stops, ownership changes, authorization revocation and changes to reply policy prevent dispatch. Unknown acceptance is reconciled rather than resent.
- Attribution uses accepted send fences and unambiguous human replies/confirmations. A bounded internal recovery pass records committed events after crashes. Reports distinguish sent emails, genuine replies, confirmed positive replies, bounces, deferrals and held qualified demos; provider acceptance is not proof of inbox placement.
- Local schema 51 → 56 upgrade passes with runtime-role constraints, legacy data, rerun, failed-migration atomicity and old-image refusal. This is not a cloud rehearsal.
- Headless actual-renderer navigation confirms that the approved-fact draft survives leaving Settings and returning, with reply automation off and domain sending paused. The screenshot was inspected; no native mouse or screen control was used.

## Recorded Bedrock evaluation

Thirteen synthetic cases cover AppFolio, unknown pricing, booking-link requests, unsupported Buildium, mixed supported/unsupported questions, discounts, forwarded content, negative interest, stop wording, vacation notices, prompt injection, acknowledgments and a request to commit a particular appointment. These are fixtures, not real prospect messages or a statistical accuracy estimate.

The first provider checks exposed unsupported JSON Schema `oneOf` and `maxItems`; both were refused before generation. The provider grammar now uses supported shapes while the local validator retains strict UUID/version/count/size/content rules.

The first completed corpus used seven Bedrock calls (7 cents gross rounded) and scored 12/13: the model treated “Book me for 9 tomorrow, and confirm it is scheduled” as a booking-link request. A reproducing deterministic test failed, then passed after booking-action requests were held for review. Prompt revision is `routine-reply-v2`. The second completed corpus scored 13/13 with six model calls (6 cents gross rounded); the remaining cases were handled before model dispatch. Total recorded model cost was 13 cents gross through the existing AWS route, with no direct Anthropic/OpenAI calls. No prospect data, calendar writes or emails were involved. Exact credit application is governed by the account, not established by this evaluation.

## Remaining release work

Independent review, repair pass, cloud rehearsal and API deployment are complete. The live API readback confirms the deployed commit and schema; mailbox-specific sending pause, cohort authorization and routine-reply settings still need inspection. Live prospect → email → reply → booking delivery remains pending while domain sending is paused; fixture/held-path tests do not claim live delivery. Social publishing and its account-specific acceptance tests are a separate remaining roadmap release.

## Independent review repairs

The whole-branch review found seven material lifecycle defects. The repair pass adds real database regressions for deletion after preparation/delivery, direct answers on another thread before permission creation, explicit takeover followed by reply confirmation, a completed manual-call scheduler job when the next cadence slot arrives, an abandoned actual dial ticket, and a prepared email recovered after local midnight. It also checks two scheduler pages with 26 automatic replies before an older valid question. Each defect was reproduced before repair; focused repaired suites pass. The repaired complete gate passed: 7,247 tests passed and 16 pre-existing skips, with typecheck and lint clean. Cloud release remains pending.

Refused reply sources are checkpointed with their inspected version and sent to review/no-reply rather than repeatedly occupying the same selection page. Correcting such a source does not silently authorize a reply. Manual-call wake identity follows the next computed cadence decision while keeping the outstanding task visible. Capacity is reclaimed only when an expired unconsumed ticket or an unclaimed prepared fence proves no external action occurred.
