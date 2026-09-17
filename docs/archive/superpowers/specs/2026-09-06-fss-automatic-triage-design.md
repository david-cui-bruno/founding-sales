# FSS automatic triage: discovery to founding customer

**Date:** 2026-09-06

**Status:** Approved by the user on 2026-09-06 at 23:25 UTC after reviewing the summary. Implementation planning is in progress. No application behavior has changed yet.

**Source baseline:** `9d83fdf3215a6ed610313e3268fd3b7ebd127d98`.

This approved design supersedes the routine manual triage and founder-only qualification authority in `2026-09-04-lead-review-triage-design.md` sections 3, 5, 7 and 8 where they conflict with the assessment workflow below. It retains explicit outreach initiation, fresh authorization, truthful contact evidence and one-lead enrichment. Historical decisions and communication evidence are not rewritten.

## Outcome

Replace a founder-facing backlog of 2,881 manual qualification decisions with a small, prepared list of worthwhile conversations. FSS handles routine evidence collection and triage. The founder spends time talking to people, learning about their actual maintenance workflow, and offering Callie when a real need is established.

Discovery and selling are one progression, not competing modes:

`source evidence -> prepared prospect -> conversation -> demonstrated need -> trial/pilot next step -> recorded outcome`

Being worth a conversation is not evidence of willingness to buy. No score or generated brief may manufacture interest, a booking, a payment, or a successful repair.

## Current product evidence

- Callie's public landing page and `/start`, fetched on September 6, advertise contractor quote collection, owner-selected booking, tenant texting, recordings, and a $20/month founding offer with a free first job.
- The dispatch repository contains September 5–6 tenant/contractor triage, owner approval, updates and follow-up implementation. This supports offering a supervised founding-customer pilot, not claiming proven unattended customer outcomes.
- Existing documents/commits report founder signup activation and internal acceptance. This investigation did not establish an external completed customer repair, non-comped customer payment, or measured ROI.
- A specific offer mismatch needs correction before taking payment under the advertised terms: `src/dispatch/onboard/start.py:420–424` sends billing-enabled signup to checkout; `src/dispatch/stripe_billing.py:110–128` creates a subscription without a deferred first charge; `src/dispatch/billing.py:185–192` grants a free job only to the separate local trialing state. This is a source/copy inconsistency, not an observed erroneous charge.
- Product billing correction and an explicitly authorized real maintenance/checkout acceptance are a separate lane. They do not block FSS development or discovery conversations. No new pricing tier is proposed.

## Why the existing review loop is insufficient

- `FounderSalesDomain.triageQueueSql` orders unreviewed cycles by stable ID, not by best opportunity.
- Unreviewed qualification stops canonical prioritization before scoring. Missing projections are displayed as zero/Low/Cold defaults. Missing assessment is therefore easily mistaken for genuinely poor fit.
- Cloud scores and local Fit/Timing are different models. Cloud Fit uses normalized observable proxies; local Fit uses stable portfolio/management/property facts. Copying one number into the other would be wrong.
- The existing read-only triage snapshot and Markdown formatter collect/present evidence but do not perform assessment or research.
- Existing `reviewToReady` also creates actions/cadence and records founder review. Calling it automatically unchanged would misattribute the decision and could create thousands of unnecessary follow-ups.

## Proposed experience

### Today

Keep due promises, replies and existing follow-ups ahead of prospecting. Replace the prominent manual backlog with:

1. **Prepared conversations:** an initial maximum of ten prospects, within existing capacity limits, with a short reason to talk, supporting facts, relevant dates, a contact/research state and a suggested discovery opener.
2. **Research in progress:** the app's work, not a list the founder must manually clear. Missing owner identity, management information or contact evidence produces a specific research task.
3. **Needs your judgment:** only a concrete ambiguity the system cannot resolve, phrased as a question with the evidence attached. Do not ask the founder to approve every routine assessment.

Keep the full Leads library and an explanation/override view available. Do not hide excluded records or require them to be manually dismissed.

### The lead brief

Show:

- Who the record actually represents: person, organization or unresolved owner entity.
- Why the prospect fits the current target, with evidence and explicit unknowns.
- Why a conversation could be timely, or that no current trigger is established.
- Best supported contact path and what remains unverified.
- Two or three discovery questions based on the evidence, without treating inferred pain as a known fact.
- After a real conversation, the specific pilot next step supported by the founder's recorded notes or accepted conversation evidence.

The existing 5–30-unit self-managing-landlord rubric is the starting targeting rule, not a new universal product restriction. Missing contact information is not poor Fit. US-wide product claims do not imply identical delivery evidence in every geography; Texas license coverage is stronger and should be represented honestly rather than silently changing Fit.

## Assessment and authority

Add a main-process incremental assessment worker, not writes inside getters:

`retained source events + linked facts -> supported fact set -> deterministic assessment -> research/brief job -> prepared shortlist`

- Persist assessment status separately from lifecycle: prepared candidate, needs research, watch, or excluded with a specific evidenced reason. Unknown values remain unknown rather than being converted to false or zero.
- Use existing pure Fit/Timing calculations where facts support them. Preserve separate axes and their existing units. Label an absent assessment as **Not assessed**.
- Evaluate all relevant linked properties/organizations rather than assuming the first linked row is representative. Municipal recorded ownership does not prove self-management, buyer role, or interest. An LLC name alone does not prove the absence of a property manager.
- Cite factual claims with a linked source-event ID and field/value, or activity/transcript/utterance ID and quote. Validate reference existence and linkage to this prospect. Preserve the observed date and distinguish fact, inference and unknown. Unsupported claims become discovery questions. The model can extract supported facts, suggest questions and write the brief, but a structured validator and domain rules determine which facts and dispositions can be applied.
- Materialize canonical qualification and its priority projection when the founder chooses a prepared next action. This is not another review/approval task. Record automated-assessment provenance explicitly and create the appropriate primary action atomically. Do not mass-enroll the whole database into a cadence.
- Existing founder decisions take precedence. A rejected or overridden assessment is not silently reapplied on the same evidence. New evidence can produce a visibly revised assessment, but superseding an assessment never rewinds actual sales history or closes a cycle automatically.
- Do not change outreach permission, initiate calls/messages, invent manual communication events, or enable bulk paid contact enrichment as a side effect of triage. The existing one-lead enrichment command retains its medium/high local Fit, qualification, identity/address, suppression and rate conditions. Never turn an unknown-owner placeholder or merely nonempty name into verified ownership for enrichment.

## Jobs, research and failure behavior

- Backfill the existing backlog in bounded, resumable batches. Reassess changed records after ingestion and when timing evidence expires or the app's local day changes.
- Work runs while FSS is open. This slice does not install an always-on daemon or promise processing while the app is closed.
- Wire the actual fact/trigger/projection refresh path. Do not merely add an AI label over stale or absent local projections.
- Reuse validated retained source events first. The deterministic assessment and evidence-based discovery questions work without a model. Additional public-source research and model-written briefs are optional adapters with explicitly configured credentials. Never borrow the dispatch application's credentials or assume the Jcode conversation is an embedded always-running service.
- Missing provider configuration is a one-time setup state. Show research as awaiting setup, not actively running, when its adapter is unavailable. A timeout or incomplete research result leaves an honest research state, not a failed business qualification.
- Key work by evidence fingerprint and assessment-rule version, recording model version when used, evaluated time and expiry separately from source observed/fetched times. Check freshness again when applying a result. A stale result cannot overwrite a newer founder decision or changed identity.
- Keep cancellation, retries and concurrency bounded. Do not rerun the whole backlog on every renderer refresh.

## Wordmark

On macOS, keep the native traffic-light controls in the top drag row. Put **Callie** on a separate row directly below them, left-aligned within the navigation rail. Remove the current 78px horizontal avoidance layout. Preserve window dragging and leave non-macOS layout unchanged. This is a small `NavigationRail`/`shell.css` layout change, not a new navigation system.

## Acceptance

- Unassessed prospects never appear as confirmed zero-Fit/Low solely because a projection is missing.
- Known source fixtures yield supported, cited assessments. Missing facts and heuristics never become verified management or buyer claims. Invalid or cross-person citations cannot support applied facts, and unknown-owner placeholders cannot gain enrichment eligibility.
- Initial backlog processing resumes after restart without duplicate assessments, actions, paid enrichment, or communications.
- Prepared ranking is based on the stated assessment and existing capacity/ordering policy, not arbitrary cycle IDs or an undocumented blended score.
- Choosing a prepared next action applies the correct automated qualification/projection/action once, without a separate manual review loop or false founder-review attribution.
- Founder overrides, new source revisions, source expiry and canceled/in-flight jobs behave correctly.
- Due follow-ups remain ahead of new prospects. Empty/partial research yields a useful explanation rather than “queue done” beside thousands of unprocessed records.
- The normal renderer path demonstrates a prepared prospect, evidence inspection, an ambiguous question and a manual conversation-to-pilot next step. No real contact or customer charge is part of fixture acceptance.
- Browser/package layout checks prove the wordmark is below the native controls, with no overlap and working navigation/drag regions.

## Scope boundaries

This slice is automatic prospect assessment, research preparation, truthful display and the sidebar adjustment. It is not an autonomous outreach agent, generic CRM redesign, new billing system, or broad Callie hardening effort. The running real workspace and its preserved backup are not test fixtures. No existing lead decisions have been changed by this design investigation.
