# Grounded LinkedIn drafts: source evidence for #615

October 13, 2026. Implements #615 and its approved 17:48 UTC governed-fact refinement, under the approved #608 posting policy. This slice ends at a visible, reviewable LinkedIn text draft. It grants no publication or runtime Enable.

## Normal demo path

1. In **Approved answer facts**, create a product/pricing block with exact owner-sanitized public-safe text. Select **Sanitized LinkedIn factual input**, topic and actual `planned`, `local`, `shipped` or `observation` status. Saving makes a new unapproved version. Approve the displayed exact text and scope. Retirement and edits keep existing version governance.
2. For news, select an **existing checked public source**. The picker reads the ordinary sourcing candidate list and its existing `sourcing.check` first-party observation. It does not add a feed or fetch arbitrary source URLs. Edit the excerpt down to an exactly supported claim, retain candidate revision, original URL and actual check timestamp, then approve the block.
3. In Social → Drafts, select **LinkedIn grounded draft**, select approved sanitized blocks and generate. The ordinary `social.draft` scheduler/registered handler/runner uses the existing Bedrock Haiku social adapter. Original meaningful paragraph spacing is retained.
4. Read the draft, exact fact revisions/status and permitted source provenance. Using the draft enters the existing manual editor only. Nothing is approved, scheduled or published by generation.

Authenticated intake is `/outreach/answer-blocks/save`, `/approve`, `/retire` and list. Generation and owner-scoped readback are `/social/drafts/request`, `/social/drafts/read` and `/social/drafts`. Existing untagged blocks, manual posts, weekly maintenance-theme drafting and other platforms retain their existing paths. There is no new fact library.

## Controls and limitations

- Additive schema106 stores optional `social_input` on existing immutable-governed answer-block versions. Grounded requests use a separate `linkedin-grounded-v1` prompt version and their existing durable source selection/hash, jobs, reservation and deadline machinery.
- Grounded inputs require active owner/admin authority, current approved non-retired block versions, explicit sanitized scope, permitted fact kinds and bounded prompt size. Private transcripts cannot be selected for this mode. Detected identifiers, secret/instruction patterns and contradictory planned/shipped inputs are refused.
- Facts and public source content are untrusted claim data. Calibration affects style, not factual authority. Customer-derived generic themes are not evidence of an individual's experience.
- News requires an actual existing checked first-party, non-truncated, quote-matching source snapshot containing the approved claim. The original URL and current candidate revision/check timestamp must match. Conservative current-news support requires retrieval on the current America/New_York calendar day. Older, unavailable, second-party or unsupported observations stop the request, not repeated investigation. This is retained-source control evidence, not live news verification.
- Block/source/access changes across token-count and generation waits prevent acceptance. Ready public reads revalidate authority and erase stale displayed draft content. Model waits stay outside draft transactions. Relevant rows are share-locked during transactional admission/readback to prevent revision changes between the check and acceptance.
- The existing configured route, 24KiB context, 4096 output-token bound and research holds/shared ceilings remain. Unknown token counts or defensible cost bounds stop dispatch. The grounded path additionally conserves social-draft reservations against $1/day and $10/calendar month using New York boundaries, even when shared settings are larger. Existing social drafting is conservatively counted in the lane. Unknown usage settles at the reserved maximum. Known over-reservation cost is financially retained and the output held. Disable/holds/lower available budgets after waits prevent acceptance.
- Grounded invalid/refused generations enter visible review, without automatic paid retry. Known privacy, status, unsupported result/position, stale reference and missing news-link controls are tested. These deterministic checks are not a general semantic entailment detector. `ready` means a reviewable generated draft, never publication eligibility or proof of factual/model quality. Real owner facts, content calibration and actual configured-provider usefulness remain operational checkpoints.

## Acceptance mapping

| #615 criterion | Observable evidence |
| --- | --- |
| Governed normal input selection | Public save/approve/list/request tests, desktop governed status intake and LinkedIn selection tests |
| Ordinary durable drafting worker | Public API → scheduler source → HandlerRegistry → enqueue/claim → runClaimedJob → real social adapter with controlled external transport → public ready read |
| Revision/access/deletion fences | Public readback for block edit, retirement, deletion, owner-role loss, token-count wait and source deletion during generation, plus stale ready read |
| Supported original news | Normal candidate save/check/read and registered source-check worker, checked good/stale/unsupported/second-party snapshots, news original link and missing-link review |
| Privacy and injection | Unsafe approved input refusal, no unsafe picker exposure, unsafe generated text review, private source exclusion in grounded mode |
| Voice | Prompt wire asserts style is not factual authority, actual output paragraph bytes preserved in product, no reference-writer factual corpus supplied |
| Spend/model/data limits | Unknown token count, shared exhausted budget, daily/monthly lane caps, Disable across waits, maximum estimated settlement and known over-maximum cost review |
| Legacy behavior | Existing API manual/drafting, domain social/governance, registered-worker/model and desktop social/outreach/registry regressions |
| Independent review P2 source fence | Tagged facts excluded from legacy desktop selection/submission and weekly factBlocks; authenticated mode-less planned/news requests refused; untagged authenticated request → registered worker → all-platform ready read remains supported; historical tagged ready content erased on public read/list |
| Independent review/CI | Coordinator-owned follow-up, not claimed by this implementation |

## Honest tests-first record

- `npm run test --workspace apps/api -- socialGroundedDrafts.test.ts`: first RED at 18:13 UTC, new governed metadata intake returned400 rather than200. First GREEN at 18:15 UTC, one real-PG public request/readback tracer using the existing handler. It was subsequently strengthened to actual registry/job claim/runner and real model-adapter composition.
- `npm run test --workspace apps/desktop -- socialGroundedDrafts.component.test.tsx`: setup initially lacked jsdom and was corrected. Actual behavior RED at 18:21 UTC was missing LinkedIn selection control. GREEN at 18:23 UTC.
- `npm run test --workspace apps/api -- socialGroundedDrafts.test.ts -t shared_exhausted`: RED at 18:27 UTC showed opaque queued state despite exhausted stricter budget. Minimal change made it visible review. GREEN at 18:29 UTC.
- Other expanded cases are regression/control evidence added around the implementation. They are not claimed as individually observed RED-first traces.
- Local dependencies were installed normally, with no symlink or lockfile change, using already-installed Node24.20.0. The originally supplied24.13.0 correctly failed engine validation and was not used with checks disabled.

Focused runs observed API30/30 grounded cases, domain87/87 social/governance/migration cases, worker5/5 and the existing desktop social/outreach cases passing. Complete repository typecheck and lint passed. Final exact commands, head, counts and any final follow-ups are in the coordinator completion report.

No paid provider call, external research/news feed, private harvest/code export, native/browser/cloud action, production write, push, PR, issue write, release or runtime Enable was performed. Controlled provider transport and synthetic owner/source facts do not establish actual semantic quality, present-corpus sufficiency, live account readiness or actual-provider acceptance.

## Independent review P2 source fence repair

October13,2026, based on clean head `e9bf79f5b5b796f176121d53b9e54f781517030a`. This is only the approved source-fence repair, not automatic legacy-to-grounded routing or a new weekly feature. The shared budget, locking and refusal machinery is unchanged. Fact-bearing ready reads also revalidate their original selection so historical mode-less tagged requests cannot retain displayed accepted text, including when a referenced fact version has disappeared. Untagged current facts retain the existing all-platform prompt and output.

Observed tests-first failures before implementation:

- 19:10 UTC: `npm run test --workspace apps/api -- socialGroundedDrafts.test.ts -t fences`: planned and bounded-original-reference news facts incorrectly returned200 instead of409. Untagged public request through scheduler/registry/claim/runner and real model adapter with controlled transport already passed.
- 19:10 UTC: `npm run test --workspace packages/domain -- test/social/weekly.test.ts`: durable weekly selection contained the tagged build fact as well as the untagged fact.
- 19:10 UTC: `npm run test --workspace apps/desktop -- socialGroundedDrafts.component.test.tsx`: tagged planned fact was visible with grounded mode off.
- 19:11 UTC: `npm run test --workspace apps/api -- socialGroundedDrafts.test.ts -t historical`: historical mode-less tagged ready read returned ready text rather than review/null. Historical queued corruption was already held by existing controls and is regression evidence, not a newly observed RED. Historical persistence shape uses explicit fixture SQL after authenticated intake, not a claimed public mutation endpoint.

Focused GREEN commands on pinned Node24.20.0:

- `npm run test --workspace apps/api -- socialGroundedDrafts.test.ts socialDrafts.test.ts`:36/36, including the existing checked first-party news registered-worker/deletion cases.
- `npm run test --workspace packages/domain -- test/social`:62/62.
- `npm run test --workspace apps/worker -- socialDraft.test.ts socialDraftModel.test.ts`:5/5.
- `npm run test --workspace apps/desktop -- socialGroundedDrafts.component.test.tsx socialDraftStudio.test.tsx socialWeekly.test.tsx`:8 cases after adding mixed legacy picker/payload regression. That additional mixed case is regression evidence, not claimed RED-first.
- Root `npm run typecheck` and `npm run lint`. No full root gate was run. Exact final head and final check results are reported to the coordinator.

Remaining acceptance is coordinator integration/full root gate and independent review/CI. Controlled fixtures remain source/control evidence only, not actual-provider or semantic-quality acceptance. No #550 fixture, other worktree, GitHub write, provider/account/browser/cloud operation or paid action is part of this repair.
