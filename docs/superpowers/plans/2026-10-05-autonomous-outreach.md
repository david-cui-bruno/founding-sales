# Autonomous Gmail outreach implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task, inline. One independent whole-branch review per release. Steps use checkbox syntax for tracking.

**Goal:** Select qualified firms, coordinate email with David's calls, and answer routine replies without creating fake deals or duplicate conversations.

**Architecture:** Extend the existing sequence engine and Gmail send fence. Add an audited mailbox authorization, firm-owned outreach plans, immutable approved answer blocks, and message-scoped reply decisions. The scheduler, budget ledger, suppression system and provider reconciliation stay authoritative.

**Tech Stack:** Existing Node 24/TypeScript/Postgres/API/worker/Electron stack; existing Gmail OAuth; Bedrock Haiku only for bounded interpretation. No new email provider or mailbox purchase.

**Spec:** [Roadmap 5a](../specs/2026-10-05-sales-roadmap-design.md); [master constraints/release gate](2026-10-05-sales-roadmap.md). Depends on A source evidence and L attribution interfaces. Following the cadence discussion, the starting policy is five emails for email-only firms, or four emails plus up to four calls for call-first firms, over roughly 21 days. Exact day offsets below are implementation defaults, not a claimed conversion optimum.

## Global Constraints

- Inherit master constraints. Sender david@usecallie.com; no visible unsubscribe link. Record Google's account-specific permission as David-reported, not independently verified or generally applicable.
- Authorize one configured workspace/mailbox identity; a label such as cold_outreach never authorizes dispatch on its own. Keep legacy cold enrollments excluded.
- New settings default off; release does not lift domain pause or enroll the existing database. Activation applies to explicitly selected new cohorts only.
- One unsolicited touch per firm/local day; no simultaneous independent call/email cadences. Email-only plans allow five emails; call-first plans allow four emails plus up to four calls over roughly 21 days. Preserve the existing four-unanswered-call guard and voicemail attempts 1/4. Requested replies/callbacks are separately scoped obligations, not another cold touch.
- No automated opportunity creation/stage movement. Existing meeting follow-through and direct-send fulfillment rules remain intact.
- Automatic replies cover scheduling links and approved product/pricing facts. Discounts, new promises, unsupported integrations, ambiguous sender/intent and unusual requests go to David.
- Calls remain human-initiated. No address-pattern guessing, personal email enrichment, fake engagement warmup or automatic daily-cap increase.

## Review Focus

1. Mailbox OAuth switches to another account after a fence is prepared: authorization must fail (E0/E5).
2. A new prospect has no deal; existing enrollments do: both work without invented opportunities or loosened legacy permissions (E2).
3. Two channels claim the same firm's daily slot, including after downtime/DST: only one unsolicited action starts (E3).
4. A late reply/edit/stop changes the thread after generation: stale bytes cannot send (E4/E5).
5. A quoted question, auto-responder or mixed request tricks the model into an unsupported answer: no autonomous reply or commitment (E4).

## File map and data ownership

- Create `packages/contracts/src/outreach.ts`; extend `sequences.ts`, `followUps.ts`, `outbound.ts`, `settings.ts` and index exports compatibly.
- Create `packages/domain/outreach/{authorization,plans,selection,cadence,touchReservations,facts,content,replyRequests,replyPolicy,replyDelivery,settings}.ts`. Keep modules focused; no generic workflow engine.
- Modify existing `sequences/{enrollments,rows,types,eligibility,executions,sendHandoff,terminalStops,todaySource,followUpPermissions}.ts`, `outbound/{stepPermission,gate,send,fence}.ts`, `mail/{effects,matching}.ts`, `calls/sessions.ts`, `dial/{tickets,calls}.ts`, `crm/merges.ts`, `retention/deletion.ts` and affected restore validation.
- Create `apps/api/src/routes/outreach.ts`, `apps/worker/src/handlers/outreach.ts`, `apps/worker/src/outreach/replyInterpretation.ts`; register through master-plan seams.
- Create `apps/desktop/src/renderer/settings/OutreachSection.tsx` and `apps/desktop/src/renderer/replies/RoutineReply.tsx`; extend existing sequence, firm and Today views rather than building a second CRM.
- Add `outreach` to API/worker container import-closure allowlists and update their existing policy tests; a type-only cross-module import still affects this repository's closure checks.
- Add migrations with stems `gmail_prospecting_authorization`, `outreach_scope`, `outreach_replies` as needed by release boundaries. First-person text stays in versioned content tables, not funnel facts.

## Task E0: Scoped Gmail authorization at both gates

**Files/tests:** authorization/settings modules, contracts/routes, eligibility and stepPermission; `packages/domain/test/outreach/authorization.test.ts`, `apps/api/test/outreach.test.ts`.

**Interfaces:** `setProspectingAuthorization(ctx,{mailboxId,expectedRevision,enabled:boolean,basis:'owner_reported_google_permission'}):Promise<Result<{revision:number}>>`; `readProspectingAuthorization(ctx,{mailboxId,ownerUserId,providerAccountId}):Promise<{allowed:boolean,revision:number|null,reason:string|null}>`. Store mailbox, authenticated owner/provider account identity, enabled/revoked time, revision and reporting actor. Do not store credentials or assert Google verification.

- [ ] Test authorized exact identity passes both gates; same mailbox label without authorization fails; other workspace/account fails; revocation or OAuth replacement after preparation fails; recipient suppression is still the first applicable reason; cold_legacy never becomes eligible. Assert no sending switch/enrollment changes when recording authorization.
- [ ] Run `npm test --workspace packages/domain -- test/outreach/authorization.test.ts`; confirm the new positive cases fail under the old blanket refusal.
- [ ] Implement one shared authorization read used by sequence eligibility and final Gmail dispatch. Change the current synchronous dispatch refusal to an awaited scoped read; retain typed hold reasons for absent/mismatched/revoked configuration. Bind prepared outreach metadata to the authorization revision and recheck current identity at claim.
- [ ] Add audited authenticated-admin configuration, disabled by default, via the existing settings/command pattern. Reconnecting a different account invalidates authorization; token refresh for the same verified account does not. Preserve restore pause; restore does not silently reauthorize cold sending.
- [ ] Run focused API/domain tests plus existing cold-dispatch and suppression tests; commit `feat: scope Gmail prospecting eligibility to configured mailbox`.

## Task E1: Approved facts and sourced email routes

**Files/tests:** facts/content/selection modules, contracts, A qualification extraction contracts; `packages/domain/test/outreach/facts.test.ts`, `packages/domain/test/outreach/selection.test.ts`.

**Interfaces:** `AnswerBlock={id:string,version:number,kind:'product'|'pricing'|'booking'|'material',text:string,approvedAt:string|null,retiredAt:string|null}`; `saveAnswerBlock(ctx,{id?:string,expectedVersion?:number,kind,text:string}):Promise<Result<AnswerBlock>>`; `approveAnswerBlock(ctx,{id,version}):Promise<Result<AnswerBlock>>`. `assessEmailCandidate(ctx,{candidateId,qualificationRunId}):Promise<Result<{firmId:string|null,route:{address:string,sourceObservationId:string,blockId:string,identityKind:'named'|'role'},lane:'call_first'|'email_first'}>>`.

- [ ] Test stale/retired/unapproved blocks cannot render; AppFolio text never implies Buildium works; unapproved discount cannot enter approved pricing; only source-associated business addresses qualify; shared-domain branch mismatch/guessed address/referral to someone else remain review. Human-reviewed fit-only leads retain that label, not confirmed need.
- [ ] Run both focused suites; verify failures before implementation.
- [ ] Persist immutable answer blocks with version approval/retirement. Reuse approved template creation/rendering for email wrappers and sign-off; importing content does not silently approve it. Initial blocks are drafted from current reviewed product/offer facts; no price is invented from a past tentative $2/door conversation. UI supports approving/revising the reusable facts once, not every email.
- [ ] Extend A extraction with `business_email` source references and resolve it against current identity, geography, ownership and stops. Email eligibility is separate from call eligibility: lack of a phone does not bar a supported email prospect. A source-backed office mailbox may have a clearly labelled role contact, never a fabricated person's name; persist identityKind alongside its route provenance. CRM creation for email-only candidates uses the same atomic matching/admission locks as A4.
- [ ] Select call_first for supported help/burden candidates with a callable route; other supported or explicitly reviewed fits with email can be email_first. Missing channels stay reviewable. Existing callbacks and human-controlled conversations never get reallocated. Render personalization from validated source facts plus approved templates; unsourced timing/pain claims are omitted.
- [ ] Run focused suites plus A identity/admission regressions; commit `feat: add approved outreach facts and sourced recipient selection`.

## Task E2: Firm-owned sequences without fake deals

**Files/tests:** plans module; sequence contract/types/rows/enrollments/eligibility/terminalStops/todaySource, outbound subject checks, CRM merges/retention; `packages/domain/test/outreach/firmScope.test.ts`, `packages/contracts/test/outreach.test.ts`.

**Interfaces:** `SequenceSubject={kind:'opportunity',opportunityId:string}|{kind:'outreach',outreachPlanId:string}`; `OutreachPlan={id:string,firmId:string,contactId:string,ownerUserId:string,mailboxId:string,lane:'call_first'|'email_first',revision:number,state:'active'|'reply_pending'|'manual'|'booked'|'completed'|'stopped'}`; `createOutreachPlan(ctx,{firmId,contactId,mailboxId,lane,qualificationRunId,expectedOwnerUserId:string}):Promise<Result<OutreachPlan>>`. Re-read assignment/current qualification under locks; firms do not currently have a revision column. Extend enrollment input with this discriminated subject while accepting old opportunityId requests as the existing opportunity branch.

- [ ] Test outreach enrollment without an opportunity creates zero opportunities; a reply and booking still match that firm/contact without an opportunity; old opportunity enrollment still requires an open matching opportunity; neither/both subjects refused; mismatched firm/contact/owner refused; one firm cannot acquire a second active plan; closed/reassigned/deleted scope blocks prepared sends. Test legacy-client response compatibility and merge/restore cases.
- [ ] Run focused domain/contract suites and confirm failures at firm-owned enrollment behavior.
- [ ] Add outreach_plans and nullable enrollment opportunity_id plus outreach_plan_id with exactly-one-authority constraints, workspace/firm composite foreign keys and active-plan uniqueness. Keep an optional related deal as contextual association only, not duplicate control authority. Extend all row decoders and subject propagation through step executions/fences/history without fabricating an ID.
- [ ] Update control-mode eligibility to resolve the discriminated subject. Preserve the existing permission origin and evidence checks. Lock order: existing send gate, firm, authority row (opportunity or outreach), contact, enrollment; integrate with Today/merge lock order and add a two-connection race test. New subject handling must be explicit at every SQL inner join that previously assumed a deal.
- [ ] Extend reply, suppression, booking and explicit takeover event targeting to find firm-owned enrollments. Booking ends prospecting and lets existing meeting handling take over; an existing unrelated human-controlled conversation holds admission. If David later creates a deal, link history without recreating enrollment or advancing a stage. Guard old desktop clients from new writes until compatible contracts are present.
- [ ] Run sequence/outbound/merge/retention/restore and contract suites plus typecheck; commit `feat: support firm owned outreach sequences`.

## Task E3: One contact plan and one cold touch per day

**Files/tests:** cadence/touchReservations/selection, sequences/executions, calls/sessions, dial/tickets/calls, worker handler, attribution hooks; `packages/domain/test/outreach/cadence.test.ts`, `packages/domain/test/outreach/touchRaces.test.ts`, `apps/worker/test/outreach.test.ts`.

**Interfaces:** `claimProspectingTouch(ctx,{planId,expectedRevision,actionId,channel:'phone'|'email',at:string}):Promise<Result<{reservationId:string,localDate:string}>>`; `settleProspectingTouch(ctx,{reservationId,outcome:'accepted'|'not_dispatched'|'unknown'}):Promise<void>`. `advanceOutreachPlan(ctx,{planId,expectedRevision,event:{kind:'no_answer'|'callback_requested'|'human_reply'|'booking'|'stop'|'takeover'|'accepted_send',sourceId:string}}):Promise<Result<OutreachPlan>>`.

- [ ] Test a call and email claiming one local date concurrently yields one acceptance; an unknown dispatch retains the slot; proven pre-dispatch failure releases it; DST preserves local date; paused backlog cannot send multiple overdue steps; callback/reply doesn't fabricate a cold touch permission; restart repeats no accepted step. Assert five lifetime emails for email-only and four lifetime emails/four calls for call-first; weekend shifts preserve spacing, one-touch limits and the final eligible weekday. Test an outstanding call ticket fences email before consumption and cannot remain valid after a released slot.
- [ ] Run focused suites; verify the race fails before shared reservations exist.
- [ ] Define initial email-only plans as day offsets 0/3/7/13/20 (user-facing days 1/4/8/14/21). Call-first keeps call offsets 0/4/9/14 and uses email offsets 2/7/12/20 when unanswered and an eligible address exists. Preserve voicemail suggestions on call attempts 1 and 4; actual calls still require David. Implement local calendar offsets inside `outreach/cadence.ts` using existing localClock utilities; shift weekend steps to the next allowed weekday/time and resolve collisions by preserving order with at most one cold touch per local date. Store explicit due instants through the sequence timing integration; do not pretend elapsed 24-hour blocks or business-day delays are calendar days. Keep existing sequence delay semantics unchanged. Enforce lifetime limits of five emails/zero planned calls for email-only, and four emails/four calls for call-first, even after a pause/restart or lane change; an already contacted firm cannot obtain a fresh allowance through re-enrollment. These plans are editable published versions; existing enrollments retain theirs.
- [ ] Reserve shared firm/date capacity before authorizing a call ticket or preparing email dispatch, and recheck at actual call consumption/email claim. Prevent an opposite-channel claim while a valid pending ticket/fence exists. A call outcome may arrive late; record the attempt from actual call initiation, not when David completes the form. Preserve the existing four-unanswered-call guard. In-flight unknown outcomes keep capacity until resolved.
- [ ] On missed call steps, don't starve all email forever: the current day's allowed email can proceed if no call has started/reserved, and the unsent call step is explicitly skipped once the next scheduled action wins. On pause/resume, choose at most one still-relevant pending touch, then place future gaps after actual completed touches; never drain the whole start-anchored backlog. Freeze the expiry at the end of the last originally scheduled local weekday, including initial weekend adjustment, so the nominal three-week sequence can finish on a weekday. Pauses/retries never extend that expiry; hold remaining unsolicited work for review after it. Requested callbacks replace obsolete prospecting, and bookings/stops/takeover terminate it. User-initiated unscheduled cold calls see a same-day-touch explanation and use the same guard; supported requested callbacks are an explicit exception.
- [ ] Consume total mailbox ramp capacity for every automated email, reserving available slots for due requested replies/follow-ups before starting new prospects. A missing health signal never earns a raise. Selection is deterministic and idempotent with firm exclusivity; classify old enrollments rather than enrolling the whole CRM on enablement.
- [ ] Run focused domain/worker suites and existing call-cadence/direct-send tests; commit `feat: coordinate phone and email outreach per firm`.

## Task E4: Bounded routine-reply decisions

**Files/tests:** replyRequests/replyPolicy/content, worker replyInterpretation, shared reservation subject types/pricing; `packages/domain/test/outreach/replyPolicy.test.ts`, `apps/worker/test/outreachReply.test.ts`.

**Interfaces:** `ReplyDecision={kind:'answer',blockRefs:{id:string,version:number}[]}|{kind:'review',reason:string}|{kind:'no_reply',reason:string}`; `requestRoutineReply(ctx,{planId,messageId,threadRevision:string}):Promise<Result<{requestId:string}>>`; `interpretRoutineReply({messageText:string,contextText:string,blocks:AnswerBlock[],maxOutputTokens:1024}):Promise<ReplyDecision>` through a typed Bedrock port. `renderRoutineReply({decision,blocks,template,bookingUrl:string|null}):Result<{subject:string,body:string,contentHash:string}>` uses approved block bytes only for product/pricing claims.

- [ ] Build fixtures for straightforward price/product question, scheduling link, unsupported Buildium claim, discount request, mixed supported+unsupported questions, forwarded/quoted request, negative interest, stop, vacation responder, wrong matched person, prompt injection and looping auto-replies. Assert only fully supported human questions produce answer blocks; other cases produce review/no reply, never a fabricated fact or deal.
- [ ] Run the focused suites; record expected fixture outputs before implementation.
- [ ] Read the current matched human message and complete required context, bounded to 24 KiB text. If relevant context exceeds the bound, hold for review instead of silently truncating it. Input bodies cannot change tools or approval policy. Require all requested answer parts to be supported; one unsupported part holds the whole answer for David.
- [ ] Use Bedrock Haiku only, maximum 1,024 output tokens, at most two dispatched attempts per source/prompt revision and a 30-minute request deadline enforced outside the handler. Add `outreach_reply` to reservation subjects and every relevant accounting/retention query. Share the existing configured credit-funded research allowance; reserve full serialized input/output before network, settle ambiguous spend conservatively, and do not fall back to direct Anthropic/OpenAI.
- [ ] The model selects approved block IDs/versions and a classification; it cannot return executable actions or free-form product claims. Scheduling initially sends the approved Cal.com link, not invented availability or a booking created without a chosen slot. Revalidate blocks and exact sender/context before persisting a ready answer. Model failure or low certainty leaves the existing reply card for David.
- [ ] Run focused suites plus reservation/funding tests and a small credit-covered recorded corpus evaluation during execution; commit `feat: prepare routine replies from approved answer blocks`.

## Task E5: Message-scoped reply permission and final dispatch

**Files/tests:** replyDelivery; followUps contract and followUpPermissions, mail/effects, stepPermission/sendHandoff/fence; `packages/domain/test/outreach/replyDelivery.test.ts`, `packages/domain/test/outreach/replyRaces.test.ts`.

**Interfaces:** add `routine_reply` permission scope, bound to one incoming human message, matched firm/contact, one draft hash, template version and thread revision. `prepareRoutineReply(ctx,{requestId,expectedRevision:number}):Promise<Result<{executionId:string,draftHash:string}>>`; `verifyRoutineReplyFence(ctx,{fenceId,at:string}):Promise<Result<{requestId:string}>>` is a final-dispatch authority like the existing meeting fence check.

- [ ] Test reply arrives during preparation, two decisions for same inbound message, stop/reassignment/authorization-revocation during claim, edited answer block, thread rematch, already manually answered, automatic response loop and uncertain provider acceptance. Assert zero or one send, current recipient/bytes, and no revived prospecting.
- [ ] Run the focused suites and confirm these new paths fail before implementation.
- [ ] On deterministic human/uncertain inbound sync, hold all matching prospecting immediately before model work. Extend effects to outreach scopes as well as opportunities. An accepted routine decision creates a one-step follow_up enrollment under the outreach subject, not a fabricated agreed_sequence. Its permission has maxSteps=1, the exact draft/template/hash, and expires 48 hours after receipt; overdue replies require David's review. Stop/uncertain intent never supplies this permission.
- [ ] Only the validated routine reply may resolve its own reply-pending hold. It cannot clear a user takeover, stop, unrelated reply or firm-wide hold. Plan state can permit that one response while original prospecting remains terminally stopped. Use the existing final send fence and MIME/threading client; preserve In-Reply-To/References and no reply-all expansion. Reply auto-handling continues on later inbound messages only under the configured policy, one response per message.
- [ ] Preserve existing direct-send semantics in mail/effects.ts: match and fulfill relevant requests, invalidate obsolete drafts and honor explicit takeover; do not turn every sent Gmail message into a blanket new policy. Handle auto-responder/no-op results without reply ping-pong. Add narrow UI-review recovery for stale/expired/uncertain requests rather than auto-retrying delivery.
- [ ] Run focused suites plus existing reply-after-eligibility, direct-send conversation, meeting follow-through and stop tests. Commit `feat: send routine replies through message scoped eligibility`.

## Task E6: Desktop controls, real flow and release

**Files/tests:** OutreachSection/RoutineReply, sequence/firm/Today views, API/operation registration; `apps/desktop/test/outreach.component.test.tsx`, `apps/desktop/test/routineReply.component.test.tsx`; write `docs/sourcing/outreach-release-verification.md` during execution.

- [ ] Test visible selected sender, disabled-by-default automation, source/next-touch explanation, fact approval, pause/revoke, stale edits, reply review and manual handling. Assert no extra metrics row or raw protocol state in Today; back navigation preserves drafts.
- [ ] Run focused component/API suites and implement compact controls: sender authorization, campaign version/cohort preview, routine-reply policy, existing cap/health status and exceptions. Separate Preview, Enable for selected cohort and domain sending pause. Add explanatory errors when the existing cold transport gate is the cause.
- [ ] Walk a test recipient through source selection → firm-owned enrollment → send → human reply → routine answer → booking; also cancel/stop before a due step, race a call with email and simulate unknown acceptance. Use David-designated test contacts and a test-only selected cohort with no other eligible outgoing work. Real dispatch waits for the explicitly authorized sending state and uses every normal gate; no test-only bypass or direct Gmail shortcut. If sending stays paused, finish fixture/held-path checks and record live delivery pending. Production prospect enrollments are never created from fixtures.
- [ ] Evaluate template relevance on the real qualified batch; unsupported personalization must hold or use an approved neutral opener. Report sends, bounces/deferrals, genuine replies and held demos separately; no open-rate optimization or claim of inbox placement from API acceptance.
- [ ] Apply R1 gate/rehearsal/release, verify both Gmail gates and exact mailbox readback. Activate only a bounded new cohort after the explicit sending decision; old cold_legacy rows remain inert. Complete L attribution hooks for actual sends/replies/held meetings and record gross/credit/cash usage.
- [ ] Commit the release evidence. Completion requires real reply/booking flow and stop/duplicate checks, not merely removing `cold_outreach_mailbox_required`.

**Status:** planned. Gmail authorization is a user-supplied design input; no live authorization row, send switch or enrollment was changed while writing this plan.
