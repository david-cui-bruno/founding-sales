# CRM capture, evidence and Today: ticket-to-code audit

October 11, 2026. Read-only source/ticket audit at `a9be6eb05646ff35b22b0ea5a01f15bdabcbab3d`. Ticket snapshot: `.context/roadmap-audit-20261011/issues.json`. This review inspected implementation and tests; it did not rerun tests, read a live mailbox, refresh production, call a model, change issues or enable capabilities.

## Conclusion

The stack already has substantial capture, identity, versioning, deletion, processing and Today implementation. Rebuilding the closed foundations is unnecessary. The material remaining questions are **ordinary Google configuration/observation**, **what constitutes a supported communication milestone versus authored content**, **how model input conveys author/date/quotation context**, and **how broadly promises should become actionable work**. A vector index can help discover evidence; it cannot settle these questions.

The strongest concrete end-state gap is the ordinary Gmail-to-progress composition: the real Gmail capture adapter never labels a span `authored`, while deterministic CRM contacted/replied projection requires such a span. This preserves an intentional conservative guarantee but currently prevents the observed real capture from establishing those milestones. Do not fix it by relabeling heuristics as verified authorship or by manufacturing a human decision.

## Contracts and evidence classes

- #479 is the broad CRM/Ask contract. #562 and closed #563–#568 extend it to continuous relevant business Gmail, not an entire inbox archive.
- Closed #547 supplies the isolated two-message Google lifecycle; that does not prove normal production callback/watch/history configuration, ninety-day acquisition or AI usefulness.
- Closed #580/#581 implement lean release and owner-controlled setup. Read the latest ADR0009 lean-owner amendment and ADR0011 rather than rebuilding the older privileged per-release receipt scheme.
- Open #549 owns ordinary capture/recovery readiness and selected-input acquisition. #552 owns the held rollout and enabled ordinary-worker observation; their evidence should be shared rather than creating a circular acceptance ceremony.
- Open #550 owns useful extraction, supported progress, commitments, Today and booking journeys. #548 supplies frozen labels and honest denominators. Synthetic/controlled, actual provider, provisional owner usefulness and representative customer quality are distinct claims.

Dated production evidence is backend d49/schema88 and desktop1.0.51. This source targets schema104. No refreshed production observation is asserted here. Preserve release hold, cap5/lower caps, cancelled Shirley follow-up, uncertain-send holds, and admission/routine replies/calling off.

## Trace of existing implementation

### Qualification and acquisition

`packages/domain/mail/businessQualification.ts:6` versions deterministic metadata qualification. Lines 13–16 bind owner/account/generation and supported policy version. Lines 18–24 normalize observed endpoints and apply account-scoped correspondent rules, refusing conflicts. Lines 25–34 exclude recognized automation/transactions, recognize subject vocabulary or an existing supported correspondent, otherwise return uncertain. It never calls a model or fetches a body.

`packages/domain/mail/crmSources.ts:2415` composes this qualifier into the ordinary metadata observer. The observer excludes drafts, rechecks configured authority, then records bounded observed metadata and classification. `packages/domain/business/acquisition.ts:213` maps exact conversation decisions before category defaults; lines 239–253 require current metadata/decision revisions for changes. Explicit exclusion, relevance restoration and copy deletion are separate operations.

The qualifier is deliberately limited: unknown business relevance depends on a finite subject vocabulary (`businessQualification.ts:29–30`); known-correspondent continuity requires a subject longer than three characters and excludes a smaller set of routine words (`:31–34`). This is a rule baseline, not measured classification precision/recall. It can miss substantive ordinary-language subjects. Qualification performance belongs in #548/#549; do not describe source tests as proof that all relevant business mail is automatically found.

A small integration detail to include in that assessment: the qualifier checks `List-Unsubscribe` (`businessQualification.ts:26`) but the standard requested metadata headers omit it (`packages/domain/mail/types.ts:69`). `List-Id` and `Auto-Submitted` are requested. This is an inspected completeness mismatch, not a demonstrated live misclassification or justification for fetching bodies.

`apps/worker/src/bootstrap/crmGmail.ts:13–41` obtains dedicated server OAuth access and rechecks actual mailbox/owner/member/generation before and after token waits. `:47–58` feeds the same explicitly configured Gmail adapter into live and historical capture without enabling controls. `packages/domain/mail/crmSources.ts:719–734` derives the separate `sentProof`; it is more restrictive than observing Gmail SENT origin.

Source tests cross useful seams: `apps/api/test/businessMailCapture.test.ts:1094` exercises registered sync→unknown-business qualification→capture under independent authority, `:1514` creates an observed unknown-firm person without operational contact/enrollment, and `:1965` tests observation/capture lock ordering. These are controlled provider results, not ordinary production observations.

### Representation, authorship and milestone gap

`packages/domain/mail/crmGmailProvider.ts:31–68` checks message/thread/label/account identity around the provider waits. `:60` recognizes SENT, INBOX or supported archived incoming participant provenance. `:87–108` preserves provider time, sender date, attachment metadata, representation completeness and diagnostics. Attachments are references; this is not content analysis.

Quotation labeling is intentionally conservative. `crmGmailProvider.ts:6–11` marks unquoted text unknown and a recognized tail quoted/forwarded. `:109` returns those ranges. It never returns an authored span. The comment at `:80` is slightly stale (recognized quotation tails are no longer all unknown), but its refusal to claim original authorship is current behavior.

`packages/domain/crm/progress.ts:40–44` requires complete retained representation plus at least one authored range. Outgoing contacted additionally needs `sentProof`; replied additionally needs a prior outgoing complete/authored/Sent-proven source in the same thread and compatible participants with an earlier provider event date. `crmSources.ts:731–734` requires complete plain text and an authored range for `sentProof` itself. Thus the normal real adapter currently cannot satisfy this composed authored prerequisite, even when Gmail confirms that a message was sent. The approved Shirley acquisition recorded outgoing origin sent but sentProof false, consistent with these rules.

This is **not** a finding that the provider send failed. A message's original SENT evidence, author of each passage, whether a manual reply fulfilled a request, and whether a promise was made are distinct facts. Research/reconcile the minimum proof for each. Transport-level sent/replied chronology may not need the same original-authored proof as semantic promise fulfillment; weakening commitment evidence is not implied.

`apps/api/test/crmProgress.test.ts:55` uses a controlled adapter that explicitly supplies authored ranges. Those tests exercise chronology, wrong recipient/thread, out-of-order arrival, identity/permission loss and unresolved holds, but that positive fixture does not prove the real adapter produces such evidence. `apps/api/test/crmGmailHttpCapture.test.ts:244` covers archived received mail and canonical attachment metadata through the HTTP adapter. These test classes should remain distinct in #549/#550 readiness.

### Recovery, deletion and identity

`apps/worker/src/handlers/crmMailBackfill.ts:47` reserves each provider read under current proof/allocation/lease; `:80–112` handles qualifying older-thread expansion; `:126–162` handles recovery and retained-copy reconciliation; `:183–215` handles bounded live history with cursor/order checks. `packages/domain/mail/crmHistoryRecovery.ts:95–146` separates surviving-message enumeration from fresh history and requires retained-copy reconciliation before advancing. It does not claim an expired history cursor can recover deleted originals.

`apps/api/test/crmMailBackfill.test.ts:651` exercises older qualifying context with independent coverage; `:691` holds an unknown expanded metadata read instead of blindly redispatching it. These are already implemented scenarios. Ordinary ninety-day/live/older-context observation remains for #549/#552, not another implementation of history recovery.

`packages/domain/mail/crmSources.ts:1185` changes source availability under exact-copy locks. Lines 1221–1227 redact backfill metadata, delete retained bodies and clear copied headers/attachment references. `:1336` requests explicit revision-bound recapture. `packages/domain/crm/nativeMailEvidence.ts:30,39,45,57` excludes diagnostic copies from ordinary evidence; `:22–36` prepares/verifies/rechecks processing authority. This is a valuable existing seam to retain when improving model input or retrieval.

Identity contexts remain versioned and separate from endpoint observations. `nativeMailEvidence.ts:6–10` requires a single supported person and current context for certainty; multiple/unknown people remain review-required. Capture creates evidence, not sending routes or opportunity stage decisions.

### Extraction, promises and Today

`packages/domain/crm/nativeMailEvidence.ts:27` currently supplies the model a serialized object containing text, representation, completeness and ranges. It does **not** supply canonical sender/recipient, direction, provider event date, thread chronology or neighboring original messages in this input. `apps/worker/src/providers/crmBedrock.ts:74–75` supplies generic current-author/quotation instructions and asks for original text offsets. The model sees a serialized mail wrapper while the citation resolver validates offsets against the original retained passage. This is an interface-design concern to investigate with actual labeled mail cases; it is not a proven cause of the selected-note synthetic failures.

The configured provider's strict output tool and full-request input reservation live at `crmBedrock.ts:71–102`. `apps/worker/src/handlers/crmExtract.ts:179–205` rechecks current authority/context/usage, validates exact quote text and stores candidate interpretations. Exact quotes prove that text exists; they do not prove that an interpretation is correct. A wrong offer-as-commitment or old-promise-as-current classification can still pass structural/quote validation. Current actual evaluation failures therefore need semantic analysis, not only stronger JSON output.

`packages/domain/crm/commitments.ts:267–290` automatic admission is intentionally very narrow. It requires stated mail evidence and exact original outgoing authored proof, refuses conditional/commercial vocabulary and recognizes only “I will prepare/review/summarize … by YYYY-MM-DD UTC.” or an explicit UTC instant. It does not autonomously support broad natural-language counterparty promises, relative dates or general actions. `apps/api/test/crmCommitmentIntent.test.ts:116` uses a controlled authored-mail adapter; `:169–185` verifies real registered projection/read behavior and excludes historical work from Today.

General human commitment review exists (`commitments.ts:77–108`), preserves review/correction ownership, and feeds versioned tasks. Today projection/read at `:110–134` and `:228–253` distinguishes suggestions, historical work and exhausted projection blockers. There is no daily briefing in Today and no inference that a booking means attendance. `apps/api/test/crmBookingProgressJourney.test.ts:11` exercises booking→opportunity→Today→brief→explicit attendance/outcome with signed **controlled** booking inputs; actual calendar capacity and provider observations remain separate.

## Specific ticket/document cleanup

1. #548/#549/#550/#552 still state the current target is schema99; current checked source is104. Keep schema88 as dated shipped evidence, replace the source-target snapshot and attach actual merged-source/provider receipts.
2. #581's body still says current code enforces the old mechanism until this ticket implements it although it is now closed. Mark that paragraph historical/source-complete, with normal deployment still pending. ADR0009 also contains earlier transitional “current code” statements; preserve history while making latest source/operating status obvious.
3. #562/#568 retain older mandatory receipt wording. The latest #497/#581 lean-owner contract supersedes it. Avoid accidentally introducing image-specific reauthorization during #549/#552 acceptance.
4. #550 “clear dated promises create tasks” is broader than current automatic admission. Explicitly state current automatic coverage and human-review fallback; reconcile whether the release promises broader recognition. Do not equate an exact quote with commitment support.
5. `docs/operations/current-state.md:7` still says exact-head source merge pending; verify the parent agent's merge receipt and update once. Historical dated failed runs should remain evidence, not appear as current blockers after repairs.

## Focused research before further broad implementation

1. **Ordinary Gmail evidence contract:** distinguish message-origin/SENT/date/reply events from authorship, request fulfillment and commitments. Inspect provider MIME/header guarantees and maintained mail parsing implementations; test multipart alternatives, Gmail quote markup, forwarded headers, mobile replies, signature-only messages and authored text before/after quotations. Preserve unknown attribution where no supported proof exists.
2. **Model evidence envelope:** design one bounded typed input containing original text and offset convention, current sender/participants, event date/timezone provenance, direction, quoted/forwarded spans and explicitly selected neighboring context. Distinguish model interpretation from server evidence. Reuse current authority/deletion/cost seams; do not add a second processing harness.
3. **Commitment semantics:** evaluate offers, explicit acceptance, relative dates, old quotes, negation and speaker identity with known evidence. First measure interpretation with correct evidence supplied; then assess retrieval separately. A stronger model may improve this but cannot compensate for absent author/date context.
4. **Qualification coverage:** label missed/false-included subject examples and automated messages before proposing another classifier. Broaden safe metadata rules or retain compact review when evidence is insufficient. Model/body classification needs its own approval; classification cannot grant capture authority.
5. **Event ordering and performance:** use existing out-of-order/recovery regressions, then measure the #550 two-minute progress/five-minute AI targets through ordinary jobs. These are currently targets, not observed service levels. No new event-sourcing platform is warranted by this audit.

## Path to finish without reopening closed foundations

Reconcile #549/#550 evidence and current targets first. Complete ordinary configured Google observation after the held deployment through #552, sharing actual account/callback/worker/history/deletion evidence with #549. In parallel, settle the supported Gmail milestone versus authored-content contract and model input envelope under existing #550 implementation obligations. Run a compact known-evidence semantic evaluation on the affected cases; report every critical attribution/definitive-state error and expose human review where autonomous coverage remains narrow. Keep capture, deterministic progress, extraction, answering and embedding independently enabled only for their approved passing scope.

No new recipients, sends, routine replies, automatic admission, cloud application, paid budget or activation follows from this audit.
