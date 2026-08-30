# Callie Founder Sales System V1 Design

**Status:** Approved

**Date:** 2026-08-30

**Product:** Single-founder, local-first macOS Electron application

**Repository:** `david-cui-bruno/founding-sales`

## 1. Purpose

Callie is the operating system for one founder running early sales. It replaces the lead spreadsheet, daily call list, activity log, pipeline, transcript review, learning archive, and Friday scoreboard with one local Mac application.

The application is not a general CRM. It is intentionally opinionated:

- One founder and one local Mac workspace.
- Person-first selling; organizations and properties are supporting context.
- A fixed lifecycle with no custom stages.
- Every operationally open sales cycle (`active` or `onboarding`) has exactly one primary next action and due date.
- Fit and Timing remain separate axes. There is no blended lead score.
- Outreach is founder-initiated, even when communication is integrated.
- Communication history is logged automatically where the operating system and provider expose reliable events.
- Calls are recorded through Apple's native recording flow when eligible and technically observable.
- LLMs extract, critique, and propose. Deterministic rules and founder confirmation control business facts.
- Operational data, recordings, transcripts, and backups are encrypted locally.

## 2. Non-negotiable product decisions

### 2.1 Lifecycle

The fixed lifecycle is:

`Unreviewed -> Ready -> Contacted -> Interviewed -> Offered -> Won`

Any active stage may move to `Lost-Nurture` with a reason and reactivation condition. Stages are not customizable.

### 2.2 Next-action invariant

Every operationally open sales cycle has exactly one primary next action and due date. Completing an action must atomically create its replacement, advance to another cadence, or close the workflow.

An operationally open sales cycle without a primary next action is invalid data, not an ordinary queue category.

### 2.3 Prioritization

There is no 0-100 score, weighted Fit/Timing sum, blended rank, or hidden weighted equivalent.

The engine produces:

- Fit points and a Low/Medium/High band.
- Timing value and a Cold/Warm/Hot band.
- Reachability status.
- Data-confidence value.
- Fit x Timing matrix cell.
- P0-P3 priority.
- A lexicographic ordering key.

### 2.4 Communication authority

Calls, texts, and emails are initiated by the founder. The application may prepare content, open or control the relevant communication surface, synchronize events, and infer deterministic outcomes. It never autonomously starts an outreach touch.

### 2.5 LLM authority

Deterministic communication facts may apply automatically. Interpretive transcript findings enter Review and require founder confirmation before changing business facts.

## 3. V1 scope

V1 includes:

- Encrypted local workspace.
- Person/Organization/Property/Prospect/SalesCycle data model.
- CSV import, spreadsheet paste, and manual quick-add.
- Qualification gates and source provenance.
- Fit x Timing prioritization with trigger decay.
- Capacity-bounded Today queue.
- Fixed lifecycle and versioned cadences.
- Person-first grid and right-side inspector.
- Personal Messages integration for iMessage, SMS, and RCS visible on the Mac.
- Personal iPhone calling through the macOS Phone/Continuity stack.
- Best-effort, app-open zero-click Apple-native call recording.
- Unknown-call and ambiguous-identity review.
- Gmail-only email integration.
- Recording and transcript ingestion.
- Two-pass founder-sales and Mom Test critique.
- Evidence-backed Learnings.
- Friday scoreboard.
- Encrypted backups, portable export, recovery, and diagnostics.

V1 explicitly excludes:

- Multiple founders or users.
- A Callie account or cloud CRM database.
- Custom lifecycle stages.
- Autonomous outreach.
- A dedicated Twilio/OpenPhone number.
- Guaranteed zero-click recording for calls visible only on the iPhone.
- Always-on call monitoring while Callie is closed.
- Existing-product job, fulfillment, payment, or Stripe integration.
- An outcome-fitted lead model.
- On-device LLM or transcription.
- A full iOS companion application.
- Semantic/vector search.

## 4. Experience and navigation

Primary navigation contains:

1. **Today** — daily execution queue and capacity.
2. **Leads** — person-first spreadsheet/grid.
3. **Pipeline** — fixed lifecycle table and board views.
4. **Conversations** — calls, recordings, transcripts, and critique.
5. **Learnings** — accepted insights and recurring patterns.
6. **Friday** — weekly scoreboard.
7. **Review** — unmatched calls, identity matches, LLM suggestions, import issues, and system errors.
8. **Settings** — integrations, permissions, rules, consent, encryption, backup, and diagnostics.

### 4.1 Leads grid

The grid is compact and spreadsheet-capable:

- Person is the leading identity column.
- Organization and property information are secondary context.
- Lifecycle, original source, segment, priority, Fit band, Timing band, next action, and due date are first-class columns.
- Sorting, filtering, saved views, pinning, bulk selection, keyboard navigation, inline editing, CSV import, and spreadsheet paste are supported.
- Ordinary data cells remain neutral and high-contrast.

Selecting a row opens a resizable right-side inspector without leaving the grid.

### 4.2 Right-side inspector

The header displays:

- Person identity and contact methods.
- Organization/property context.
- Lifecycle and priority.
- Opt-out and recording/consent state.
- Primary next action.
- Call, text, and email controls.

Inspector sections are:

- **Overview:** source, segment, Fit/Timing explanations, triggers, reachability, cadence, and next action.
- **Activity:** unified calls, voicemails, texts, emails, notes, and stage events.
- **Conversation:** recording, transcript, critique, and evidence-linked suggestions.
- **Properties:** doors, ownership evidence, vacancy, and source records.
- **History:** prior sales cycles, offers, Won terms, loss reasons, and resurrection events.

A full detail page is available for deep transcript and history work.

### 4.3 Visual system

The design language is luxury, aurora, neumorphic, minimal, sleek, and bold.

- Dark theme uses obsidian and graphite surfaces.
- Light theme uses pearl and ivory surfaces.
- Aurora color is selective: navigation, focus, selection, active recording, P0 urgency, and meaningful state changes.
- Neumorphic depth is restrained to controls and inspector surfaces.
- Navigation and detail panels are spacious; the data grid is compact.
- A density toggle changes grid row density.
- Typography is bold for identity, priority, and action, not for ordinary metadata.
- Motion communicates state and never becomes ambient decoration.

## 5. Domain model

### 5.1 Person

The human being receiving outreach.

Core fields:

- Stable identifier.
- Name and aliases.
- Normalized phone numbers and email addresses.
- Contact-method validation state.
- Contact membership state for recording eligibility.
- Person-wide opt-out tombstone.
- Never Record flag.
- Created, updated, and provenance metadata.

### 5.2 Organization

A thin background entity for LLC and company normalization. It has no lifecycle, cadence, scoring, or primary navigation page.

Core fields:

- Canonical name.
- Known aliases.
- Linked people.
- Linked properties.
- Supporting source records.

### 5.3 Property

Supporting portfolio and trigger context.

Core fields:

- Address and service geography.
- Door count.
- Property type and relevant maintenance profile.
- Ownership/organization relationships.
- Vacancy and maintenance facts.
- Source records and verification timestamps.

### 5.4 Prospect

Stable sales eligibility and prioritization context connecting a Person to organizations and properties.

Core fields:

- Person reference.
- Linked organization and property context.
- Required original SourceEvent reference.
- Appended current/accompanying SourceEvents.
- Segment and cadence-selection context.
- Qualification outcome.
- Fit points, Fit band, and rule evidence.
- Trigger events, Timing value, and Timing band.
- Reachability and data confidence.
- Matrix cell, priority, and active prioritization version.

V1 permits exactly one canonical Prospect per Person. Organizations and properties are many-to-many context on that Prospect. Imports that appear to create a second Prospect for the same Person enter identity/merge review instead of becoming independently queue-eligible.

Original source channels are:

- `frbo`
- `registry`
- `rireig`
- `referral`
- `inbound_demo`
- `community`
- `custom`

Original attribution is never overwritten. Later source interactions are appended with provenance.

### 5.5 SalesCycle

A single execution attempt for a Person. Resurrecting a Lost-Nurture prospect creates a new cycle, preserving the earlier cycle's activities, offers, and outcome.

Core fields:

- Person and Prospect references.
- Lifecycle stage and stage-entered timestamp.
- Workflow status: `active`, `onboarding`, or `closed`.
- Cadence enrollment.
- Primary next-action reference.
- Close-readiness assessment.
- Founder-confirmed design-partner fitness from Interviewed onward: integer 0-5.
- Stage-event history.
- Lost-Nurture reason and reactivation condition.
- Won terms.

Won terms contain:

- Doors committed.
- Billing model.
- Unit rate.
- Calculated monthly recurring revenue.
- Founding-customer flag.
- Effective date.

V1 billing models are `per_door_monthly`, `flat_monthly`, and `manual_projected_monthly`. Currency is USD and monetary values are integer cents. Per-door MRR is committed doors multiplied by unit-rate cents; flat MRR is unit-rate cents; manual projected MRR requires an amount and reason. Calculated MRR is a reproducible projection with a formula version, never a separately editable fact.

Workflow semantics are distinct from the visible lifecycle stage:

- `active` covers Unreviewed, Ready, Contacted, Interviewed, and Offered and requires a primary next action.
- `onboarding` uses visible stage Won, runs the ordered onboarding sequence, and requires a primary next action until onboarding completes.
- `closed` covers Lost-Nurture and Won after onboarding and has no primary next action.
- Opt-out closes a pre-Won cycle as Lost-Nurture with reason `opt_out` and reactivation `never`; during Won onboarding it preserves Won and closes onboarding with an opt-out stop reason.

### 5.6 Activity

Activities are append-only facts:

- Call, voicemail, text, email, interview, offer, note, job, and system event.
- Direction, channel, timestamp, duration, and observed outcome.
- Person, Prospect, SalesCycle, cadence-step, and provider references.
- Recording, transcript, consent, and analysis references.
- Provider idempotency key.

Corrections create linked amendment events. They do not rewrite original activity rows.

### 5.7 NextAction

The primary action driving Today.

Core fields:

- SalesCycle reference.
- Action type and channel.
- Due date/time and timezone.
- Allowed execution window.
- Cadence step.
- Status and completion activity.
- Replacement action or terminal transition.

`SalesCycle.current_next_action_id` is the sole authoritative definition of the primary action. Supplemental tasks may coexist, but only the referenced action drives Today.

A transition transaction inserts the replacement action first, moves the cycle pointer to it (or closes the workflow and clears the pointer), then completes the old action. The transaction performs a postcondition check before commit.

### 5.8 JobRequest

A manual V1 record for fulfillment metrics, separate from founder job-runner infrastructure and generic Activities.

Core fields:

- Stable identifier and optional Won SalesCycle.
- Requested-at effective timestamp.
- Status: `requested`, `filled`, or `cancelled`.
- Contractor-accepted-at timestamp for Filled.
- Immutable state-event history and idempotency key.

One JobRequest can be filled once. Duplicate acceptance events are idempotent; cancellation is excluded from the fill-rate denominator.

### 5.9 Database invariants

The application service layer enforces:

1. At most one operationally open SalesCycle per Person.
2. Exactly one incomplete primary NextAction per operationally open SalesCycle.
3. Exactly one canonical Prospect per Person in V1.
4. No active cadence on a person-wide opted-out Person.
5. No P0 priority without Direct reachability.
6. No stored recording/transcript without a consent-policy record.
7. No duplicate provider event with the same adapter and idempotency key.

The database directly enforces one Prospect per Person, at most one operationally open SalesCycle per Person (`active` or `onboarding`), and action ownership/uniqueness through unique indexes, partial indexes, and foreign keys. A row CHECK ties `active`/`onboarding` to a non-null pointer and `closed` to a null pointer; a composite foreign key proves the referenced action belongs to the same cycle; and a trigger prevents completing/cancelling the referenced action before the pointer moves or workflow closes. The application service transaction retains a postcondition as defense in depth. Startup and diagnostics audits surface legacy or externally corrupted rows that violate it. The migration plan must prototype these constraints against the selected SQLCipher/SQLite build before freezing schema 0002.

## 6. Lifecycle behavior

### 6.1 Stages

- **Unreviewed:** imported or discovered; not approved for outreach. It is workflow-active with a Review Lead primary action.
- **Ready:** reviewed, eligible, and enrolled in a prospecting cadence.
- **Contacted:** at least one touch was delivered.
- **Interviewed:** founder confirms a substantive research conversation.
- **Offered:** founder confirms price was communicated.
- **Won:** founder confirms the commercial commitment; future payment integration may automate confirmation.
- **Lost-Nurture:** active pursuit ended with a required reason and resurrection rule.

### 6.2 Suggested transitions

A two-party call of at least five minutes may suggest Interviewed, but never transitions automatically. The evidence preview includes duration and transcript excerpts. The founder confirms with one tap.

Transcript analysis may suggest Offered when it detects price communication, but the founder confirms it.

High Fit plus a pain-confirmed Interviewed stage produces the recommendation to make the offer during the second substantive conversation.

Close readiness belongs to the SalesCycle and contains founder-confirmed values for demonstrated pain, active timeline, decision authority, willingness to try/pay, and concrete next-step commitment. Each dimension is `unknown`, `weak`, `moderate`, or `strong` with evidence references. An LLM may suggest a value; only founder confirmation makes it load-bearing. "Pain-confirmed" means demonstrated pain is confirmed as `moderate` or `strong`.

Design-partner fitness is founder-set on a SalesCycle from Interviewed onward. An LLM may suggest 0-5 with evidence, but the database rejects a confirmed value before Interviewed.

### 6.3 Authoritative transition table

| From | To | Authority and guard | Workflow/cadence effect |
|---|---|---|---|
| Unreviewed | Ready | Founder completes review; eligibility passes; not opted out | Start initial cadence and replace Review Lead action |
| Unreviewed | Lost-Nurture | Founder rejects/disqualifies or opt-out applies; reason required | Close cycle; reactivation rule required except `opt_out -> never` |
| Ready | Contacted | Deterministic qualifying communication outcome | Preserve/advance prospecting cadence and replace action |
| Ready or Contacted | Interviewed | Founder confirms substantive conversation evidence | Backfill Contacted first when necessary; stop prospecting; start Post-Interview |
| Unreviewed | Ready, then Contacted | Founder approves an existing inbound communication | One transaction emits both events using inbound effective time and starts Cadence C at the appropriate component |
| Ready, Contacted, or Interviewed | Lost-Nurture | Founder disposition, cadence exhaustion, or opt-out | Stop cadence; close with reason and rules |
| Interviewed | Offered | Founder confirms price communication | Stop Post-Interview; start Post-Offer |
| Offered | Won | Founder confirms commitment | Enter `onboarding`; start ordered onboarding cadence |
| Offered | Lost-Nurture | Founder disposition, Post-Offer exhaustion, or opt-out | Stop cadence; close with reason and rules |
| Won/onboarding | Won/closed | Final onboarding component completed or explicitly waived with reason | Clear current action and close workflow |
| Won/onboarding | Won/closed | Person opts out | Preserve Won and commercial terms; stop outbound onboarding; set `onboarding_stop_reason=opt_out` |

If a confirmed event implies a skipped mechanical stage, the transaction emits missing intermediate StageEvents immediately before the target event with the same effective business timestamp and explicit `backfilled=true` provenance. Confirmation time is stored separately from effective time.

Qualifying Contacted outcomes are:

- Outbound text with unambiguous provider/system acceptance; delivery status upgrades the same activity when available.
- Outbound email accepted by Gmail; a later bounce amends the activity and rebuilds projections.
- Outbound call answered by the person.
- Voicemail confirmed as left.
- Any inbound reply/call/message associated with the Person.

A no-answer call without voicemail, failed send, opened composer, copied draft, or unconfirmed automation click does not produce Contacted.

### 6.4 Lost-Nurture resurrection

Supported reactivation types are:

- `seasonal:heating-oct1`
- `new-frbo-listing`
- `lead-cert-expiry-window`
- `manual`
- `inbound_response`

Versioned Lost-Nurture reasons are `no_response`, `not_interested`, `bad_timing`, `not_decision_maker`, `not_qualified`, `price`, `trust`, `chose_alternative`, `product_gap`, `cadence_exhausted`, `disqualified`, `opt_out`, and `other`. `other` requires notes. A manual reactivation rule always requires an exact future due date; it is never a prose-only placeholder.

Each closed cycle has zero or more immutable ReactivationRules. A rule is an exact due date or an event matcher, carries a version, and is consumed idempotently when it creates a new cycle. October 1 resolves to the next future October 1 in the workspace timezone. Cadence A defaults to next October 1 plus new-FRBO-listing; Cadence B defaults to configured lead-certificate/seasonal triggers plus manual; Cadence C and Post-Offer default to new qualifying trigger plus manual. Founder disposition may replace these defaults.

Lost-Nurture requires at least one rule unless the reason is `opt_out`, which requires the sole rule `never`. Every non-opted-out closed cycle also accepts an explicit `inbound_response` event as a resurrection regardless of its narrower seasonal rules. Reactivation creates a new Ready SalesCycle only when the Person has no operationally open cycle, remains eligible, is not opted out, and has a valid primary action. Otherwise it creates Review work rather than outreach.

An inbound demo from an unknown handle creates Unmatched Communication Review with the source event attached. Promoting it creates Person/Prospect/Unreviewed SalesCycle, then the founder approval transaction emits Ready and Contacted from the existing inbound evidence and starts Cadence C. An explicit inbound sales response from a known, eligible Person with a closed cycle creates a new Ready/Contacted cycle through the `inbound_response` rule and enters the inbound interrupt lane.

## 7. Source, opt-out, and retention

### 7.1 Source attribution

Attribution is represented by immutable SourceEvents containing source channel, observed time, source record/evidence, optional referrer, and the Person/Prospect/SalesCycle it activated.

Every Prospect has a required `original_source_event_id`. Every SalesCycle has an `entry_source_event_id` identifying original acquisition, resurrection, or manual entry for that cycle. TriggerEvents reference the SourceEvent that supports them.

A direct-referral SourceEvent requires `referred_by_person_id` or an explicit `referrer_unknown` reason and cannot refer to the same Person. RIREIG connections remain a separate source/trigger type. Person merges preserve and redirect referral relationships without erasing the original event.

Friday analytics default to Prospect original acquisition source and offer an activation-source drilldown for the SourceEvent that opened the SalesCycle. Later interactions remain appended events and never rewrite original attribution.

### 7.2 Person-wide opt-out

Opt-out is:

- Person-wide across all Prospects and SalesCycles.
- Checked when Today renders.
- Checked again immediately before every call, text, or email action.
- A hard execution block, not a warning.
- Permanent unless a separately recorded, legally valid re-consent policy is implemented in a future version.
- Represented by an undeletable minimal tombstone even when other person data is deleted.

The tombstone retains normalized blocked phone/email handles, request time, observed channel, source Activity/evidence, and policy version so deletion and re-import cannot bypass the block. Person merge, restore, identity relinking, and import preserve the most restrictive opt-out state.

All app-originated outreach passes through one typed outbound-command service. It rechecks the tombstone in the same transaction immediately before handing work to Messages, Phone, or Gmail; Today filtering is an additional safeguard, not the enforcement boundary.

Opt-out immediately stops every cadence and cancels future outbound next actions. A pre-Won cycle closes as Lost-Nurture with reason `opt_out` and reactivation `never`. A Won/onboarding cycle preserves Won, closes onboarding with `onboarding_stop_reason=opt_out`, and retains its commercial metrics.

An outbound-readiness barrier serializes adapter delta sync and outbound handoff. After application launch/wake and immediately before outreach, every enabled inbound-capable adapter relevant to the Person must complete a fresh checkpoint or explicitly report that freshness cannot be established. Failure to establish freshness hard-blocks outbound work pending Sync/Review. Tests cover an opt-out received while Callie was closed followed by immediate launch and attempted send.

If the founder reports that a prohibited touch already occurred outside Callie, the application records the truth as a flagged audit event rather than suppressing evidence.

### 7.3 Retention

- Opt-out tombstones are retained indefinitely.
- Compliance-relevant communication metadata is retained for at least five years.
- The product describes this as compliance-supporting recordkeeping, not legal advice.
- Audio and transcript retention is independently configurable so privacy-sensitive content need not share the metadata retention period.
- Legal-hold status prevents deletion where applicable.

The five-year default aligns conservatively with current federal company-specific do-not-call and covered telemarketing recordkeeping periods; applicability requires legal review before release.

## 8. Cadence engine

Cadence definitions are immutable and versioned. An enrollment retains the exact version used.

Each enrollment records current step, scheduled date, allowed window, completed/skipped/failed steps, stop reason, and generated next action.

Only one primary cadence controls a SalesCycle at a time.

Each CadenceStep is a versioned graph node with an ordered list of conditional ActionComponents. Only the currently executable component is the SalesCycle's primary NextAction. Its observed outcome selects the next component or completes the step and schedules the next step.

For example, Cadence A Day 0 executes `call`. `answered` completes the step; `no_answer` advances to `voicemail`; confirmed voicemail advances to `text`; accepted text completes the step. When a conditional channel is unavailable, the component becomes Resolve Contact Method rather than silently disappearing. A founder may mark it impossible with a reason, which preserves the event and follows the cadence's explicit failure branch. Breakup components require completion or an explicit impossible-channel disposition before closure.

### 8.1 Cadence A — FRBO/live vacancy

Eight touches over fourteen days:

1. Day 0, within minutes: call. No answer -> voicemail no longer than 20 seconds plus immediate text.
2. Day 1: call in a different time window; no voicemail.
3. Day 3: value-angle text.
4. Day 5: call plus second voicemail.
5. Day 8: two-line email when an address exists.
6. Day 11: call; no voicemail.
7. Day 12: soft text.
8. Day 14: breakup text.

Then move to Lost-Nurture with October 1 heating or next-listing reactivation.

Default templates are versioned with the cadence. The Day 3 text uses the value angle "happy to share what other Providence landlords tell me about finding contractors." The Day 14 breakup conveys "closing my file — if a repair ever has you chasing plumbers, this number will still work." Founders may edit copy without changing step mechanics; saving creates a new template version.

### 8.2 Cadence B — Registry/cold list

Six touches over sixteen days:

1. Day 0: research-framed call, voicemail, and text.
2. Day 2: call.
3. Day 5: text.
4. Day 9: call and voicemail.
5. Day 13: email.
6. Day 16: breakup.

Then move to Lost-Nurture.

The first-touch template remains explicitly research-framed. The final step is a versioned breakup template, not an ordinary follow-up.

### 8.3 Cadence C — Warm

For RIREIG, referrals, community, and inbound demo:

1. Same-day thank-you or response text.
2. Day 1-2: call to book the substantive conversation.
3. Day 4: nudge.
4. Day 8: graceful breakup.

A referral untouched for forty-eight hours is an SLA breach surfaced in Today.

### 8.4 Post-Interview cadence

1. Same day: pain-specific recap and book the second call.
2. Day 2: pitch call; suggest Offered when price is communicated.

### 8.5 Post-Offer cadence

1. Day 0: one-pager and agreement link.
2. Day 2: nudge.
3. Day 5: two-line mutual-action text.
4. Day 9: final value touch.
5. Day 12: breakup.

Scarcity language is permitted only when the underlying count is true.

The recap template quotes the founder-confirmed pain in the lead's own terms. The Day 5 mutual-action template asks whether the concrete trial commitment is still good for the stated week.

### 8.6 Won onboarding

Won immediately creates:

- Welcome text.
- Payment/Stripe-link action.
- "Text your first job to this number now" action.

These are ordered ActionComponents, never three simultaneous primary actions. Completing or explicitly waiving the final component closes the Won workflow.

Existing-product onboarding integration is deferred.

### 8.7 Cadence rules

- Maximum touches are enforced.
- Cadence limits count scheduled cadence steps. Each constituent call, voicemail, text, or email is also stored as its own Activity, so the Day 0 call/voicemail/text bundle is one cadence step and up to three communication activities.
- Breakup steps cannot be silently skipped.
- Cadence exhaustion moves to Lost-Nurture; no zombie leads remain active.
- Opt-out stops every enrollment immediately.
- Default calling windows are 9:00 a.m.-8:00 p.m. Monday-Saturday, Sunday afternoon only, and never Sunday morning.
- Each action is founder-initiated and logged with timestamp and channel.

### 8.8 Segment selection and cadence upgrades

Segment is required and versioned:

- `hot_frbo` -> Cadence A.
- `cold_registry` -> Cadence B.
- `warm` -> Cadence C.

Initial precedence is Warm over Hot-FRBO over Cold-Registry. A direct referral or inbound demo therefore selects Warm even when a live listing also exists.

Before Interviewed, a new higher-precedence trigger may upgrade an enrollment: inbound demo/direct referral switches A or B to C; live vacancy switches B to A. Completed Activities and attempt-level scheduled-step counts are preserved, the prior enrollment closes with `upgraded`, and the new version starts at the first component that does not duplicate a just-completed communication. The total prospecting-step cap for the SalesCycle is the highest cap among its enrolled prospecting cadences, never the sum. Remaining executable components are bounded by both the new cadence graph and that attempt cap; the immediate response to a new inbound trigger consumes a step and is the only permitted over-cap component when the cap was already exhausted. Cadences never downgrade automatically. From Interviewed onward, prospecting triggers do not replace Post-Interview, Post-Offer, or Onboarding; they remain visible context. Founder override requires a reason.

### 8.9 Scheduling semantics

- The workspace stores an IANA timezone; V1 defaults to `America/New_York`.
- Each cadence enrollment has one immutable anchor timestamp: initial enrollment for A/B/C, Interviewed effective time for Post-Interview, Offered effective time for Post-Offer, and Won effective time for Onboarding. Every labeled day is `anchor local date + day_offset`, not a cumulative delay from the preceding completion.
- If a prior step completes late and a later step is already due, the next eligible component becomes due immediately inside the next allowed window; the schedule never silently slides the advertised 14/16-day cadence.
- DST changes preserve intended local wall-clock windows.
- Call windows are Morning 9:00 a.m.-12:00 p.m., Afternoon 1:00-5:00 p.m., and Evening 5:00-8:00 p.m. Sunday permits Afternoon 1:00-5:00 p.m. only.
- "Different time window" selects the next allowed window different from the prior call, preferring Morning after an Afternoon/Evening call and Afternoon after a Morning call.
- "Day 1-2" schedules the Warm call on Day 1 at the next allowed window and marks the SLA breached after the final allowed window on Day 2.
- Same-day text/email components are due immediately. If the configured policy disallows the channel at that time, due time rolls to the next allowed start without changing the cadence anchor.
- Failed delivery keeps the component incomplete and follows its explicit retry/failure branch. It never silently advances the cadence.
- Tests use an injected clock and cover DST, Sunday, window rollover, and delayed founder confirmation.

## 9. Qualification and prioritization

### 9.1 Gates

Hard disqualifications run before prioritization. Examples include out-of-area prospects, no relevant ownership/decision relationship, institutional portfolios outside the ICP, harmful/non-paying operators marked by the founder, and unresolved duplicates.

Missing direct contact and stale source data are not Fit penalties. They affect reachability and confidence.

### 9.2 Fit axis

Fit uses stable pre-contact facts only, on a 0-30 point scale:

- Portfolio in the 5-30 door band: up to 15 points. Two-four and 31-50 doors receive 6; other sizes receive 0 by default.
- Self-managed/no property manager: up to 8.
- Property clustering/route density: up to 4.
- Relevant building or maintenance profile: up to 3.

Bands:

- High: 20-30.
- Medium: 10-19.
- Low: 0-9.

Engagement and contactability never modify Fit.

### 9.3 Trigger events and Timing axis

Trigger values are computed at evaluation time. Supported functions are decaying, approaching, and windowed.

Timing is the sum of active trigger values, capped at 40:

- Hot: 20-40.
- Warm: 8-19.
- Cold: 0-7.

Default triggers:

| Trigger | Base | Function and default |
|---|---:|---|
| Live vacancy / FRBO listing | 15 | Decaying; 14-day half-life |
| Recent acquisition | 15 | Decaying; 180-day half-life |
| Compliance deadline | 10 | Approaching; 25% at 90 days, 100% within 30, expires 14 days after |
| Recent permit or maintenance activity | 5 | Decaying; 30-day half-life |
| Heating-season timing | 5 | Founder-configured window |
| Student-turnover timing | 5 | Founder-configured window |
| Post-storm timing | 5 | Decaying; 10-day half-life |
| Tax-season timing | 3 | Founder-configured window |
| Inbound demo text | 30 | Decaying; 2-day half-life |
| Direct referral | 25 | Decaying; 7-day half-life |
| RIREIG connection | 15 | Decaying; 7-day half-life |
| Recent lead-initiated engagement | 15 | Decaying; 7-day half-life |
| Nurture resurrection | 10 | Windowed; active for 14 days from re-queue date |
| Founder-defined custom trigger | Founder-set | Versioned function and parameters |

Rules:

- Only the strongest active instance of a trigger type contributes.
- Different trigger types may stack up to the Timing cap.
- One external event may create only one trigger type.
- Nurture resurrection cannot produce P0 by itself.
- Verification multiplier defaults to 1.0 for authoritative/founder-verified and 0.6 for unverified.
- A trigger contributes nothing after expiration or below a current value of 1.0.

Calculation is deterministic:

- Decaying raw value is `base * 2 ^ (-age_seconds / half_life_seconds)` and is zero before its effective timestamp.
- Approaching functions are stored as versioned time-to-deadline control points and use linear interpolation between points.
- Windowed value is `base` inside the half-open interval `[starts_at, ends_at)` and zero outside it.
- Effective value is `raw * strength_multiplier * verification_multiplier`.
- Each effective trigger is rounded to the nearest 0.001 point before summing; display rounds to one decimal, while ordering uses the stored thousandth-point integer.
- Decaying expiration is the first timestamp when effective value falls below 1.0, recomputed when a multiplier/version changes.
- Evaluation uses an explicit UTC timestamp and the workspace timezone only for calendar-window boundaries.
- Custom base is constrained to 0-40, half-life to one hour through 730 days, and strength multiplier to 0-2. Invalid versions cannot activate.

Post-contact pain and outstanding offers are not Timing triggers. Active SalesCycles are ordered by next action and pipeline state.

### 9.4 Reachability and confidence

Reachability is a status, not points:

- Direct: valid direct phone for the decision-maker.
- Indirect: valid email or office/general number only.
- None: no valid method.

Direct reachability gates P0 and breaks ties.

Data confidence is a 0-10 tie-break value based on source authority and freshness. Low-confidence P0/P1 records carry Verify First.

The default Verify First threshold is below 7. A High-Fit/Hot-Timing record without Direct reachability falls to P1 with the play Find Direct Line.

### 9.5 Fit x Timing matrix

| | High Fit | Medium Fit | Low Fit |
|---|---|---|---|
| Hot Timing | P0 contact immediately; Direct required | P1 contact today | P2 quick fit check |
| Warm Timing | P1 contact today | P2 qualify this week | P3 nurture |
| Cold Timing | P3 watch for trigger | P3 nurture | P3 archive candidate |

### 9.6 Prospect ordering

Within a prospecting lane, order lexicographically by:

1. Priority.
2. Earliest active trigger expiration, null last.
3. Highest Timing value.
4. Highest Fit points.
5. Reachability: Direct, Indirect, None.
6. Highest data confidence.
7. Oldest last contact, never contacted first.

This tuple is the ordering mechanism. It is never reduced to a single score.

### 9.7 Overrides and calibration

- Priority override and Pin to Top require a reason and expiration.
- Original computed values remain visible.
- V1 records implicit pairwise comparisons when the founder acts out of order, snoozes, dismisses, reorders, or overrides.
- V1.1 may present explicit "which would you call first?" comparisons.
- A Bradley-Terry fit may propose new Fit contributions, trigger values/half-lives, band boundaries, or matrix cells.
- Calibration proposals are versioned previews and never activate automatically.
- Calibration never creates a blended score.

## 10. Today queue

Today is capacity-bounded and promise-first, with an interrupt lane for truly warm inbound activity.

Queue lanes are:

1. Won cycles awaiting immediate onboarding.
2. Fresh inbound demo texts and direct referrals inside response SLA.
3. Overdue primary next actions.
4. Post-Interview and Post-Offer actions due today.
5. Other cadence actions due today.
6. New P0 prospects.
7. P1 prospects.
8. Exploration slots.
9. Later items beyond daily capacity.

Each operationally open SalesCycle is assigned to the first matching lane in this precedence list; it can appear only once. P0/P1 prospecting rows are Ready SalesCycles with a valid current action, never bare Prospects. The stable record identifier is the final tie-breaker in every lane.

Pin to Top operates only inside the item's assigned lane and cannot jump onboarding, inbound-SLA, overdue, or promised-work boundaries.

Lanes 1-5 use the promise tuple: overdue status, earliest due date, most advanced stage, oldest stage age, cadence step, then stable identifier. Lanes 6-8 use the prospect-priority tuple in Section 9.6, then stable identifier.

Default capacity settings:

- Forty daily dials.
- Five daily conversations.
- Two exploration slots.
- Three-day re-surface suppression unless a cadence action is due.

Onboarding, inbound-SLA, overdue, and already-promised due work are non-suppressible and remain visible even when they exceed the dial budget. Capacity bounds discretionary P0/P1 prospecting and exploration. Only call actions consume the dial budget; texts and emails remain visible but do not consume a dial. The conversation target is a scoreboard/pace target, not a queue truncation rule.

Inbound demo response is due immediately and breaches its default SLA after fifteen permitted minutes. A direct referral is due the same day and breaches after forty-eight elapsed hours. Policy windows still prevent executing an otherwise urgent action outside allowed hours.

Every queue row explains why it appears and shows active triggers, cadence step, next action, last activity, Verify First, and consent/recording requirements.

An invariant violation appears under Review > System Errors, never as a normal Today lane.

## 11. Lead entry and data quality

V1 entry paths are:

- CSV import.
- Spreadsheet-range paste.
- Manual quick-add.

Imports use a preview/commit flow:

1. Parse without writes.
2. Map columns.
3. Normalize phones, emails, organizations, and addresses.
4. Validate rows and display errors.
5. Preview duplicate/person/organization matches.
6. Preview source and cadence assignment.
7. Commit atomically or write nothing.

Source rows and raw input are retained as provenance.

## 12. Communication architecture

### 12.1 Process boundary

Electron owns the UI, workflow engine, encrypted database, jobs, and analysis review.

A signed native Swift helper handles macOS-only capabilities:

- Observe call state.
- Inspect/automate the Phone, Messages, and Notes apps through permitted local mechanisms.
- Read permitted local communication databases.
- Detect and initiate eligible Apple recording.
- Watch for completed recordings and transcripts.
- Report permission and adapter health.

V1 runs the helper as a bundled child process over a fixed-version, typed stdio protocol only while Callie is open. It is not a persistent login/background agent. The bridge exposes no generic AppleScript, shell, arbitrary-file, or arbitrary-Accessibility command. A future always-on helper would require a separate signed `SMAppService`/XPC design and security review.

The packaged helper uses a stable signing identity so TCC and Keychain permissions survive updates. Electron validates helper version and signature at startup; helper upgrades are atomic and roll back with the containing application bundle.

The renderer never receives filesystem, database, Keychain, shell, Accessibility, or raw Electron access.

### 12.2 Normalization flow

`Apple/Gmail event -> adapter -> identity matching -> append-only activity -> deterministic workflow update -> optional transcript analysis`

Known identities attach immediately. Ambiguous matches enter Identity Review. Unknown inbound handles enter Unmatched Communications.

### 12.3 Messages adapter

- Best-effort synchronizes personal iMessage, SMS, and RCS available on the Mac through read-only, version-checked local data access.
- Sends through the Messages application after founder action.
- Watches inbound and outbound activity where the local schema exposes unambiguous facts; it never writes Apple's Messages database.
- Associates threads using normalized contact handles.
- Deterministically recognized opt-out language creates and applies the person-wide hard block immediately. Ambiguous free-form language creates a high-priority Review item and temporarily blocks outbound actions until resolved.
- Requires Full Disk Access and Automation permissions; Accessibility may be required for unsupported surfaces.

The public Messages scripting surface is used for sending where available; history, delivery, reply, and failure synchronization are private-schema integrations and therefore best effort. The adapter is versioned, schema-checked, and diagnostic because Apple-owned local schemas may change with macOS updates.

### 12.4 Phone and recording adapter

The system uses the founder's personal iPhone number through macOS Phone/Continuity.

Recording eligibility includes:

- Calls launched from Callie.
- Numbers matching an existing lead.
- Incoming or outgoing numbers absent from Contacts.
- Contacts explicitly marked sales-related.

The unknown-number rule requires founder-granted full Contacts access. Limited or denied access cannot prove absence from Contacts, so the adapter reports Unknown Classification Unavailable and does not auto-record solely on that basis.

Recording excludes:

- Emergency numbers.
- Short codes.
- Voicemail access.
- Never Record entries.

Flow:

1. While Callie and its helper are open, a bounded native observer parses version-recognized, detached Phone Accessibility snapshots for Mac-visible call state. It never places a remote number on the call-state object.
2. The helper keeps outgoing Callie-launched identity context separate from call state and reports any incoming Phone identity as a distinct best-effort snapshot.
3. Missing Phone UI, denied Accessibility, ambiguous state, an iPhone-only call, or a handoff that removes Mac-visible state degrades the adapter and cannot synthesize a recordable call.
4. On an unambiguous connected call, Accessibility automation identifies exactly one enabled, version-recognized Apple Call Recording control.
5. After pressing, the helper takes a new snapshot and reports recording verified only when an independent active-recording indicator is present.
6. Apple provides its audible recording notice.
7. Notes creates the recording and, when supported, a transcript artifact.
8. Callie imports and encrypts its managed copy.
9. Identity matching attaches it or routes it to Review.

The macOS 26 SDK explicitly marks `CXCallObserver` and `CXCall` unavailable on macOS (`API_UNAVAILABLE(macos)`). A native macOS type-check therefore rejects the earlier CallKit design. V1 uses the app-open, fail-closed Phone Accessibility observer above; no private CallKit replacement is permitted. Manual Apple recording tap is the fallback whenever Mac-visible observation or control is unavailable.

Notes export has a deliberate V1 threat-model boundary. Callie owns a launch-lifetime 0700 staging-root descriptor and generated per-export directories, but Notes' public Apple Event accepts only an absolute file URL rather than descriptor-bound write authority. A malicious concurrent same-user replacement of the staging root or generated export directory during that external save is outside the V1 threat model. Callie revalidates root/export provenance immediately after the save; any detected mismatch returns no proof, reports `plaintextRetentionRisk` with only an opaque recovery identifier, and permanently disables Notes exports for that helper lifetime. This is detected fail-closed behavior, not a guarantee that Callie can locate or delete a write redirected outside its descriptor-bound staging directory. Shutdown likewise reports failure instead of `shuttingDown: true` when contained deletion and absence verification cannot be completed.

If an incoming number cannot be resolved safely, Callie does not auto-record. If a call is answered only on the iPhone, or a Mac-started recording does not survive handoff, guaranteed zero-click recording is not possible in V1. The app may notify the founder to tap Record and ingests the artifact if it later becomes visible in Notes on the Mac; otherwise it offers manual export/import. All such boundaries are visible adapter states, never silent success.

For every managed recording, Callie stores call identifier, recording-start attempt time, verified recording-state time, Apple-notice invocation evidence available to the helper, and consent-policy version. Missing required evidence flags the artifact and gates LLM analysis according to policy.

### 12.5 Unknown calls

Unknown numbers are recorded when technically eligible and safely classified as absent from Contacts, then routed to Unmatched Communications rather than automatically becoming Leads.

Review actions are:

- Promote to Unreviewed Lead.
- Link to Existing Lead.
- Mark Personal, which persists a Never Record exclusion for the normalized handle.
- Delete managed recording and transcript subject to retention/legal hold.

The pipeline, cadence, and scoreboard do not change until classification.

### 12.6 Gmail adapter

Gmail is the only V1 email integration.

- OAuth authorization and least-privilege scopes.
- Send/reply inside Callie after founder action.
- Thread synchronization limited to lead addresses and explicitly linked threads.
- Gmail OAuth read permission is mailbox-wide. Sync may inspect changed-message metadata across the mailbox, but Callie retains bodies/threads only when a participant matches a lead address or the founder explicitly links the thread.
- Sent, reply, failure, attachment, and timestamp logging.
- Stable provider identifiers and cursor-based incremental sync.
- Polling/on-open incremental sync; V1 has no Pub/Sub cloud relay.
- Bounded full resync when Gmail history cursors expire.
- API send rejection and detected bounce are failures; the adapter does not claim universal final-delivery confirmation.
- Deterministically recognized written opt-out language applies the same immediate person-wide tombstone as Messages; ambiguous language quarantines outbound work and enters Review.
- Credentials/tokens stored in macOS Keychain, never SQLite or renderer state.

There is no Apple Mail or generic IMAP/SMTP adapter in V1.

Gmail defaults to `gmail.readonly` plus `gmail.send`; label/draft mutation scopes are not requested unless a later approved feature needs them. OAuth setup documents the personal-use/unverified-app path and avoids Testing-mode refresh-token expiry for the founder's installed workspace.

## 13. Transcript analysis and Learnings

### 13.1 Canonical transcript

Every adapter/import normalizes to speaker-attributed utterances with stable utterance identifiers and timestamps. Raw source is preserved.

Apple's generated transcript is imported opportunistically through a versioned adapter; Notes exposes no guaranteed structured transcript API. If it cannot be extracted, Callie may use a configured cloud speech-to-text adapter or accept manual transcript import. Audio import and transcript extraction have independent health states.

### 13.2 Two-pass analysis

Pass 1 extracts evidence for:

- Problems and recent incidents.
- Current workaround.
- Frequency, severity, and cost.
- Decision authority.
- Timing and willingness to try/pay.
- Objections.
- Commitments and next steps.
- Price/founding offer communication.

Pass 2 applies Founding Sales and Mom Test rubric context:

- Past behavior versus hypotheticals.
- Specific follow-up quality.
- Leading questions and compliment-seeking.
- Premature pitching.
- Consequences and existing spend.
- Buyer and decision process.
- Concrete next-step quality.
- Missed evidence and better questions.

There is no opaque overall call score.

### 13.3 Evidence requirements

- Every factual finding references one or more canonical utterance identifiers.
- Findings without supporting evidence are omitted.
- Missing information remains unknown.
- Provider/model, rubric version, time, cost, and consent state are recorded for every analysis run.
- Transcript text is treated as untrusted data, never as assistant instructions.

### 13.4 Write authority

Deterministic facts apply automatically:

- Communication occurrence.
- Direction and duration.
- Delivery/reply/failure where reliably observed.
- Cadence completion and deterministic next-action scheduling.

Interpretive findings enter Review:

- Pain.
- Objection.
- Authority.
- Commitment.
- Close readiness.
- Mom Test critique.
- Offered suggestion.
- Identity/company extraction.

A founder can apply opt-out manually from every person and communication surface. Transcript-detected verbal do-not-contact language creates an immediate temporary outbound quarantine plus a highest-priority Review item; founder confirmation converts it to the permanent tombstone. Exact structured opt-out events from Messages or Gmail apply immediately without LLM interpretation.

Review supports batch accept, edit, merge, dismiss, and provenance-preserving undo.

The founder may enable Automatically Analyze Eligible Recorded Sales Calls once in Settings after a provider/data disclosure. That standing founder instruction permits background transcription/analysis for future recordings whose consent record allows it. When disabled, each call exposes an Analyze action. No recording is transmitted merely because it was imported.

Manual recovery remains first-class: the founder can log an off-app activity, attach an exported recording, paste/import a transcript, or amend identity/outcome evidence. Logging a past touch remains possible even when opt-out would block executing a new one.

### 13.5 Learnings

Accepted learnings retain evidence, segments, sources, confidence, sample size, first/latest observation, contradictions, and founder decision.

Views include repeated pains, alternatives, objections, winning language, segment differences, founder coaching patterns, product requests, pricing reactions, and invalidated assumptions.

Cross-call synthesis uses accepted structured evidence before raw model output.

## 14. Friday scoreboard

The current Monday-Friday period displays actual versus target and prior-week change for:

- Interviews.
- Offers.
- Wins.
- Offer rate.
- Win rate.
- Jobs requested.
- Jobs filled.
- Fill rate.
- New MRR.
- Founding customers.
- Average design-partner fitness.
- Overdue primary next actions.
- Active cycles without a valid primary next action; expected value zero.

Jobs requested and filled are manual V1 entries. A job is filled when a contractor accepts it.

The reporting week is Monday 00:00 through the report's Friday end time in the workspace timezone. Metrics use effective event time; confirmation time remains available for audit.

- Interviews: distinct SalesCycles whose first effective Interviewed StageEvent falls in the period.
- Offers: distinct SalesCycles whose first effective Offered StageEvent falls in the period.
- Wins: distinct SalesCycles whose first effective Won StageEvent falls in the period.
- Offer rate: Offers divided by Interviews in the same period.
- Win rate: Wins divided by Offers in the same period.
- New MRR: sum of formula-versioned MRR for Wins in the period.
- Founding customers: Wins in the period with founding flag true.
- Average design-partner fitness: average confirmed value for the period's Interviewed cycles that have a value by report time.
- Jobs requested: non-cancelled JobRequests created in the period.
- Jobs filled: those same period-cohort JobRequests whose contractor has accepted by report time.
- Fill rate: period-cohort Jobs filled divided by period-cohort Jobs requested.

A zero denominator displays an em dash rather than zero percent. Stage corrections/relinks rebuild the metrics from canonical events.

Every metric drills down to source events. The funnel is available by original source channel.

Future existing-product integration will automate job, fill, payment, and MRR confirmation.

## 15. Review system

Review is asynchronous instead of modal-heavy:

- Unmatched Communications, including calls, texts, and emails.
- Ambiguous Identity.
- Transcript Suggestions.
- Import Problems.
- Permission/Adapter Failures.
- System Invariant Errors.

Only immediate safety failures interrupt the founder:

- Opt-out hard block.
- Missing encryption key/recovery failure.
- Invalid lifecycle or next-action transaction.
- Unsafe/unsupported recording state.

## 16. Security and privacy

### 16.1 Encryption

- SQLCipher or an equivalent encrypted SQLite implementation protects the complete database and search indexes.
- A random workspace key is stored in macOS Keychain.
- Managed recordings and source files use authenticated AES-GCM encryption.
- Automatic backups are encrypted.
- Portable backup bundles require a password.
- Plaintext staging uses an application-private `0700` directory, streams into encrypted managed storage immediately, cleans up after success, and removes abandoned staging files on startup. Callie intentionally retains no plaintext managed copies; FileVault is recommended for residual exposure from crashes, APFS behavior, and system snapshots.
- Onboarding recommends FileVault but does not treat it as the only protection.
- A recovery-key export flow is mandatory and clearly explains irrecoverability if both Keychain and recovery material are lost.

This protection applies to Callie's canonical database, managed media, and backups. It does not encrypt or delete source-system copies retained by Apple Notes/iCloud, Messages/iCloud, Gmail, or a configured cloud transcription/LLM provider; those remain governed by their systems' storage and security policies.

### 16.2 Electron boundary

- Context isolation enabled.
- Renderer sandboxing enabled.
- Node integration disabled.
- Narrow, typed contextBridge API.
- Zod validation at IPC and adapter boundaries.
- Restrictive CSP.
- Bundled UI only.
- Navigation and external URLs allowlisted.
- Electron fuses locked before distribution.

### 16.3 Cloud disclosure

Callie's canonical CRM database remains local. Source systems and configured cloud providers retain or process their own copies as disclosed above. Network services are limited to Gmail and founder-authorized cloud LLM/transcription jobs.

Before first cloud use, the application identifies what data will be sent, to which provider, and why. Consent policy gates transcript transmission. No business content is sent as telemetry.

### 16.4 Secrets

Gmail and LLM credentials/tokens live in macOS Keychain and never enter the renderer, database, logs, backups, or exports.

## 17. Reliability and jobs

- Persistent local jobs survive restart for imports, adapter sync, transcript ingestion, analysis, recalculation, and backup verification.
- Every job records state, progress, attempts, safe diagnostics, and idempotency key.
- Interrupted jobs become retryable or explicitly failed; they never disappear.
- Adapter syncs resume from confirmed cursors/checkpoints.
- Trigger decay recomputes when Today opens and at least daily.
- Rule changes create immutable prioritization versions and previews.
- Migrations create and verify a pre-migration backup.
- Restore validates checksums/schema, creates a safety backup, and applies transactionally.
- Permission failures disable the affected integration without corrupting core CRM data.

### 17.1 Minimum Apple-integration environment

The initial acceptance target is:

- macOS 26.4 or newer on Apple silicon.
- iPhone and Mac signed into the same Apple Account.
- iCloud Notes/Call Recordings synchronization enabled for automatic ingestion of recordings started on iPhone.
- Calls on Other Devices, FaceTime number, Wi-Fi/Bluetooth/Handoff configured.
- A region/language where Apple Phone recording is available.
- Full Contacts access for unknown-number classification.
- Full Disk Access, Automation, and Accessibility granted where the packaged adapter requires them.

Core CRM behavior remains usable when these prerequisites are absent; the affected Apple capability reports a precise degraded state.

### 17.2 Event projections and reconciliation

Activity, StageEvent, SourceEvent, consent, and amendment rows are immutable events. Lifecycle, cadence position, Today membership, source metrics, and accepted findings are rebuildable projections with version columns.

Corrections, identity relinking, person merges, and bounce/failure amendments enqueue an idempotent reconciliation job. Services use optimistic version checks, and replaying the immutable event stream must produce the same projection state as incremental processing.

## 18. Testing and acceptance

Automated coverage must include:

- Every valid and invalid lifecycle transition.
- One-active-cycle-per-Person under concurrent transactions.
- One-canonical-Prospect-per-Person across two listings and multiple LLCs.
- One-primary-next-action invariant under concurrent transactions.
- Person-wide opt-out at Today render, every outbound entry point, send-versus-opt-out race, deletion/re-import, restore, and person merge.
- Cadence timing, compound action branches, step versus Activity counts, unavailable channels, touch caps, breakup steps, allowed calling windows, upgrades, and resurrection.
- Trigger functions at boundary ages and expirations.
- Fit/Timing bands, matrix cells, P0 reachability gate, and lexicographic ordering.
- Total one-lane Today assignment, pin scope, non-suppressible promises, capacity, and stable-ID tie-break.
- A regression test that proves no blended score exists in schema, engine output, or queue ordering.
- Source and referral attribution.
- Duplicate adapter-event ingestion and restart recovery.
- Apple/Gmail adapter fixtures and degraded-permission states.
- Recording eligibility, full/limited/denied Contacts access, unresolved inbound identity, Never Record exclusions, unavailable/renamed Phone control, Mac-to-iPhone handoff, and app-closed behavior.
- Transcript evidence-reference validation and prompt-injection fixtures.
- LLM write-authority boundaries.
- Encryption, recovery, backup verification, and transactional restore.
- Renderer sandbox and IPC validation.
- Friday metric calculation and drilldown provenance.
- Event replay after correction, identity relinking, and person merge.
- Retention/deletion across normal deletion, indefinite tombstones, legal hold, expired audio, retained metadata, encrypted backup/restore, and re-import.

Package-level smoke tests must verify launch, local workspace creation, import, Today, lead inspector, activity logging, transcript analysis fixture, backup, restore, and relaunch.

## 19. Implementation dependency order

The design should be implemented in dependency order:

0. Signed-package Apple feasibility spike: observe Continuity call state; resolve number where possible; invoke/verify recording through Accessibility; test Mac-to-iPhone handoff; locate/export the Notes recording; attempt transcript extraction; send and ingest Messages activity; document exact TCC behavior. Capability-specific fallbacks are mandatory: recording automation failure -> manual tap; Notes discovery/export failure -> manual recording export/import; Apple transcript extraction failure -> cloud speech-to-text or manual transcript; Messages history ingestion failure -> send-only plus manual activity logging. No Apple-spike failure blocks the core CRM.
1. Encrypted persistence, domain schema, migrations, and invariants.
2. Domain services for lifecycle, next actions, source, opt-out, cadence, and prioritization.
3. Today, Leads grid, inspector, Pipeline, Review, and Friday UI on deterministic fixtures.
4. Import and export.
5. Native Swift bridge and permission diagnostics.
6. Messages and Phone/Notes adapters.
7. Gmail adapter.
8. Transcript analysis and Learnings.
9. Backup/recovery hardening, packaging, and full acceptance suite.

This order may be split into independently reviewable implementation tasks, but invariants and tests precede dependent UI and integration work.

## 20. Release constraints and verification notes

- The product is a personal local utility, not a Mac App Store submission target in V1.
- Apple-owned databases and Accessibility surfaces are treated as versioned adapters, never assumed stable.
- Zero-click recording is app-open, best effort, and must visibly report unresolved identity, unavailable control, failed verification, and handoff limitations.
- Legal and consent language is configuration backed by separately verified policy; the software specification is not legal advice.
- The current conservative metadata-retention default is five years, with indefinite opt-out tombstones.
- No implementation may reintroduce a 0-100 or blended lead score under another name.

## 21. Primary implementation references

- Apple `CXCallObserver`: <https://developer.apple.com/documentation/callkit/cxcallobserver>
- Apple Phone recording on Mac: <https://support.apple.com/guide/phoneapp/phn4828a6/mac>
- Apple Calls on Other Devices: <https://support.apple.com/102405>
- Apple Contacts access: <https://developer.apple.com/documentation/contacts/accessing-the-contact-store>
- Gmail incremental synchronization: <https://developers.google.com/workspace/gmail/api/guides/sync>
- Gmail OAuth scopes: <https://developers.google.com/workspace/gmail/api/auth/scopes>
- FCC company-specific do-not-call rules, 47 CFR 64.1200: <https://www.ecfr.gov/current/title-47/section-64.1200>
- FTC telemarketing recordkeeping, 16 CFR 310.5: <https://www.ecfr.gov/current/title-16/section-310.5>
