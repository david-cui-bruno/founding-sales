# Sales learning implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task, inline. One independent whole-branch review per release. Steps use checkbox syntax for tracking.

**Goal:** Explain which lead signals produce reached conversations, confirmed need, held qualified demos and customers, without adding compulsory call paperwork.

**Architecture:** Link existing source/run IDs to CRM interaction IDs, preserve immutable outcome revisions, and calculate reports from current accepted facts. Reuse the funnel fact writer and existing meeting attendance; commercial qualification is a separate fact, never a pipeline stage change.

**Tech Stack:** Existing TypeScript/Postgres/API/React stack; no analytics service or new model call required for this release.

**Spec:** [Roadmap sections 2–4](../specs/2026-10-05-sales-roadmap-design.md); [master plan and release gate](2026-10-05-sales-roadmap.md). Depends on qualification plan A1/A4/A6.

## Global Constraints

- Inherit all master-plan constraints. No-answer is separate from rejection; warm introductions are separate from cold sourcing. Deals stay manual.
- Qualified demo = held + buying participant + real maintenance need + openness to paying. Missing values remain unknown. Booked or scheduled-end-passed is not held.
- Recommend targeting changes; David approves meaningful changes. Do not automatically adjust search caps or repeat analysis spend.
- Reuse accepted transcript/debrief evidence and corrections. No required form after every call, no automatic application of call suggestions before the separate trial decision.
- Funnel detail contains IDs/codes/counts only, not transcript text, email bodies or nested evidence documents.

## Review Focus

1. Two contacts/repeated calls/merged firms inflate conversions: stable firm and interaction attribution (L1/L3).
2. A meeting is booked or ended but unattended: cannot count qualified (L2).
3. Corrected suggestion or deleted evidence leaves stale success: current revision wins (L1/L2).
4. New leads haven't had time to convert: expose age and denominators, not fabricated lift (L3).
5. Family introduction contaminates cold signal results: exclude from cold comparisons and show separately (L1/L3).

## File map

- Create `packages/domain/sourcing/{attribution,learningReport,targetingProposals}.ts`, `packages/domain/meetings/qualification.ts` and `packages/contracts/src/sourcingLearning.ts`.
- Modify `packages/domain/funnel/{facts,kinds,read}.ts` only to reuse/extend its fact vocabulary; `packages/domain/sourcing/{admission,feedback,discovery}.ts`; `packages/domain/dial/calls.ts`, `packages/domain/calls/proposalApply.ts`, `packages/domain/meetings/{attendance,outcomeCorrections}.ts`, `packages/domain/crm/{pipeline,merges}.ts` and `packages/domain/retention/deletion.ts` for outcome/identity changes. Email hooks follow in E6.
- Create `apps/api/src/routes/sourcingLearning.ts`; extend existing meetings route and master-plan registries.
- Create `apps/desktop/src/renderer/sourcing/Learning.tsx` and `apps/desktop/src/renderer/meetings/Qualification.tsx`; extend `sourcing/Candidates.tsx` with a Results subview. No metrics strip on Today.
- Add one `sourcing_learning` migration and constraint/upgrade fixtures. Store source attribution, qualification revisions and targeting proposals; do not copy the whole funnel.

## Task L1: Versioned attribution and corrections

**Files/tests:** attribution module, A admission/feedback, merge/retention integration; `packages/domain/test/sourcing/attribution.test.ts`.

**Interfaces:** `attachSourcingAttribution(ctx, {firmId,candidateId,qualificationRunId,queryId:string|null,hypothesis:string,policyVersion:string,acquisition:'cold_sourced'|'warm_intro'|'manual'|'unknown'}):Promise<Result<{id:string}>>`; `attributeInteraction(ctx,{attributionId,kind:'call'|'email'|'meeting'|'deal',subjectId,sourceRevision:number}):Promise<Result<{id:string}>>`.

One firm may have multiple historical source observations; first outreach freezes a primary attribution. Later touches refer to their actual evidence version without changing initial-cohort membership. Store interaction references and revisions, not copied personal content.

- [ ] Add tests `replayCountsOnce`, `newEvidenceDoesNotRewriteFirstTouch`, `mergeCountsSurvivingFirmOnce`, `warmIntroExcludedFromCold`, `correctedPainIsNotCurrentPain`, `deletedEvidenceIsUnavailable`: assert distinct IDs/counts and preserved audit history. Include workspace mismatch refusal.
- [ ] Run `npm test --workspace packages/domain -- test/sourcing/attribution.test.ts`; confirm failures at the new interface/behavior.
- [ ] Implement the two interfaces, composite workspace foreign keys and uniqueness on interaction kind/ID/revision. Write attribution alongside admission/accepted outcomes in the business transaction. Use the existing `recordFunnelFact`, `withdrawFunnelFacts` and `reinstateFunnelFact` APIs; don't embed raw evidence in their detail. Preserve existing fact dedupe and merge ordering. Read-only legacy history may be attributed only where source relationships are explicit; otherwise label it unknown.
- [ ] Make corrections append a superseding revision; current reports resolve the newest accepted revision. Add merge and deletion behavior in the same task; an orphaned source becomes unknown rather than inheriting another firm's signal. Historical evidence is not a live permission.
- [ ] Run the new suite plus existing funnel/merge/retention tests, then commit `feat: attribute sales outcomes to sourced evidence`.

## Task L2: Explicit commercial qualification without extra call forms

**Files/tests:** meeting qualification module/contract/route, qualification panel; `packages/domain/test/meetings/qualification.test.ts`, `apps/desktop/test/meetingQualification.component.test.tsx`.

**Interfaces:** `QualificationAnswer='yes'|'no'|'unknown'`; `QualificationEvidence={field:'buyingParticipant'|'maintenanceNeed'|'openToPaying',sourceKind:'meeting_item'|'call_item'|'user_note'|'user_confirmation',sourceId:string,sourceRevision:number}`. `saveMeetingQualification(ctx,{meetingId,expectedRevision,buyingParticipant:QualificationAnswer,maintenanceNeed:QualificationAnswer,openToPaying:QualificationAnswer,evidence:QualificationEvidence[]}):Promise<Result<{revision:number,qualified:boolean}>>`; `readMeetingQualification(ctx,meetingId):Promise<{revision:number,buyingParticipant:QualificationAnswer,maintenanceNeed:QualificationAnswer,openToPaying:QualificationAnswer,attendanceConfirmed:boolean,qualified:boolean}|null>`. A user_confirmation references the authenticated command and resulting revision; it does not require an extra note. Every known answer has field-specific evidence or this explicit confirmation.

- [ ] Test `bookedIsNotQualified` and `endedIsNotAttendance`; assert qualified false even with three yes answers. Test held+three yes gives true, one unknown gives false, changed attendance/corrected source clears derived qualification, and saving never changes opportunity stage.
- [ ] Run the focused domain/component suites and confirm the new behavior fails.
- [ ] Persist independent qualification revisions. Resolve evidence against the actual meeting/firm and current accepted source revisions. Suggestions may prefill fields but are not automatically accepted through this feature. Existing accepted structured facts may supply supported values without rerunning a model; other values require one optional compact user confirmation.
- [ ] Place three short fields on meeting detail, with unknown as the initial value, source links and one Save action. Do not open a form after every call or require completion to close a meeting. Preserve edits across navigation; stale saves explain refresh without losing text. Manual notes count as user evidence, not transcript quotes.
- [ ] Run focused suites plus attendance/outcome-correction tests; commit `feat: track qualified demos separately from attendance`.

## Task L3: Useful reports and approved targeting changes

**Files/tests:** learningReport/targetingProposals modules, sourcingLearning contract/API, Learning view; `packages/domain/test/sourcing/learningReport.test.ts`, `packages/domain/test/sourcing/targetingProposals.test.ts`, `apps/desktop/test/sourcingLearning.component.test.tsx`.

**Interfaces:** `readSourcingLearning(ctx,{from:string,to:string,asOf:string}):Promise<LearningReport>` where `LearningReport={asOf:string,cohorts:{hypothesis:string,policyVersion:string,acquisition:string,firms:number,contacted:number,reached:number,confirmedPain:number,booked:number,held:number,qualified:number,won:number,unreached:number,unknownQualification:number,interactions:{answeredCalls:number,confirmedPainCalls:number},researchGrossCents:number,researchCashCents:number}[],maturity:{ageBand:string,firms:number}[]}`. Funnel counts are distinct firms; interactions count distinct call IDs. A confirmedPainCall requires accepted evidence in that answered call, not a firm's historical pain flag. `saveTargetingProposal(ctx,{basePolicyVersion,queryChanges:{id:string,query:string,locality:string,region:'TX'|'RI'|'MA'}[],rankOrder:string[],evidenceIds:string[],rationale:string}):Promise<Result<{id:string,revision:number}>>`; `applyTargetingProposal(ctx,{id,expectedRevision}):Promise<Result<{policyVersion:string}>>` is admin-only. Reads preserve existing assigned-user visibility; an admin sees the workspace, a salesperson only their assigned firms.

- [ ] Test zero denominator yields unavailable (never 0%); repeated calls don't add firms; warm/cold split; corrected outcomes update counts; two overlapping signals don't sum into total firms; 30-day intake cohort includes only outcomes before asOf; recent cohorts show shorter observation time; no model-inferred won status.
- [ ] Run the three focused suites; confirm new behavior fails.
- [ ] Implement the report from attribution plus existing accepted call/meeting/deal data. Default to firms first contacted in the last 30 days, outcomes observed through now; show age bands and the interval. Include a separate reached-call denominator for pain and a contacted-firm denominator for demos. Keep raw provider usage and verified cash separate; shared search cost is shown once at batch level rather than multiplied per hit.
- [ ] Render the report in Candidates → Results with counts before ratios and drill-down to source evidence. Show unknowns and observation period; no statistical winner badges. Signal coverage/yield can be viewed before conversations exist. Provide four existing lightweight feedback actions rather than another questionnaire.
- [ ] Implement targeting proposal save/apply with version checks. Persist immutable query-set versions (including query ID/text, locality and TX/RI/MA region), seeding the current `DISCOVERY_QUERIES` as version 1. Make discovery read its approved active version under the existing cursor/account lock and store that version on each attempt. Validate rankOrder against the defined qualification tiers; it can reorder only the new-lead lane, never callbacks or existing commitments, and cannot weaken admission criteria. Add tests that unapproved edits do nothing and a policy change during dispatch cannot relabel an attempt. Applying changes affects future work only; it never changes quota, admits dismissed firms, sends messages or creates deals. Start with explicit comparison suggestions assembled from the report; no new autonomous optimization model is necessary.
- [ ] Run focused suites, API scope/contract tests and R1 release gate. Read back one actual attributed outcome; if none exists, report fixtures passed and live outcome verification pending. Commit `feat: show evidence linked sourcing results and targeting proposals`.

**Completion:** attributable reports and corrections work; conversion superiority need not be established before email work begins. Status: planned.
