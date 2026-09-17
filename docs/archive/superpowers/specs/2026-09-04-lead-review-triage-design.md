# Lead Review, Contact Presentation, and Triage Design

**Status:** Approved

**Date:** 2026-09-04

**Product:** Callie Founder Sales System

## 1. Purpose

Make lead review understandable and evidence-driven without encouraging the founder to treat raw enrichment candidates as verified contacts. After the compliance and runtime work is safe, Jcode will perform a read-only triage of the top 20 to 30 unreviewed leads and present recommendations for founder confirmation.

## 2. Confirmed current behavior

One explicit enrichment request returned ten vendor-ranked phone candidates and one email for one resident. The intake mapper stored every candidate, marked rank one primary, and retained DNC/TCPA flags. The Overview then rendered separate Call and Text buttons for every stored phone. Four of the ten phones were DNC-listed.

The current presentation makes raw alternatives look equally actionable. It does not show vendor rank, evidence source, verification freshness, or why one number is primary.

All 2,881 leads were unreviewed at audit time. The app therefore had no qualified P0 or P1 execution lane despite having cloud scores and timing signals.

## 3. Non-negotiable behavior

- Raw vendor candidates are labeled as candidates, not verified ownership.
- Only one primary contact is prominent.
- Alternatives are collapsed by default.
- Every number displays source, rank, validation, and compliance status.
- Blocked or unknown numbers never expose an enabled Call or Text control.
- Enrichment remains one explicit founder action after qualification. There is no bulk enrichment.
- Triage is read-only by default. Jcode does not contact, enrich, dismiss, mark ready, edit scores, or change stages without a separate founder confirmation.
- Fit and Timing remain separate axes.
- Compliance eligibility is a hard gate and never increases lead priority.

## 4. Contact presentation

### 4.1 Primary contact card

The Reach out section displays one primary phone card when available:

- formatted phone number
- `Primary candidate` label
- vendor or source label
- vendor rank
- ownership-validation state
- federal/TCPA status
- evidence timestamp and expiration
- enabled or disabled Call/Text controls

Rank one may be displayed as primary only when it is not positively blocked. Rank does not establish ownership or compliance clearance.

### 4.2 Alternatives

Remaining phones appear behind a control such as `Show 9 alternative numbers`.

Each alternative row shows the same evidence fields. Rows are ordered by:

1. positively blocked numbers last
2. fresh verified-clear numbers before unknown numbers
3. ownership confidence when available
4. vendor rank
5. stable normalized phone ordering

The UI never hides blocked alternatives because they are useful evidence, but it does not make them visually resemble recommended actions.

### 4.3 Contact status vocabulary

Ownership and compliance are separate:

Ownership:

- Verified for this person
- Vendor candidate
- Conflicting identity
- Unknown ownership

Compliance:

- Verified clear until `<date>`
- Federal DNC listed
- TCPA blocked
- Compliance unknown
- Scrub expired
- Area code not covered
- State clearance required

## 5. Founder review workflow

For each unreviewed lead, the Overview presents this sequence:

1. **Identity:** Is this a real person with a relevant ownership or operating relationship?
2. **Fit:** Does the existing evidence support the Low, Medium, or High fit band?
3. **Timing:** Is there a current Cold, Warm, or Hot trigger with dated evidence?
4. **Reachability:** Is there a direct, indirect, or missing contact path?
5. **Data confidence:** Are name, property, organization, and source relationships trustworthy?
6. **Compliance:** Is outreach blocked, unknown, or verified clear?
7. **Decision:** Mark ready, dismiss with an exact gate reason, or leave unreviewed pending evidence.

`Find contact info` is shown only when:

- the lead is founder-approved for qualification
- the fit gate passes
- the identity and address requirements pass
- there is no existing usable direct contact
- suppression permits enrichment
- the request is outside the rate-limit window

## 6. Priority interpretation

The existing matrix remains authoritative:

- P0: High Fit and Hot Timing with direct reachability
- P1: Medium Fit and Hot Timing
- P1: High Fit and Warm Timing
- P1 `find_direct_line`: High Fit and Hot Timing without direct reachability

Compliance may demote a lead from actionable to blocked, but a compliance status never promotes a lead.

A P0 recommendation therefore requires:

- high fit evidence
- hot timing evidence
- direct ownership-validated reachability
- sufficient data confidence
- current federal and state clearance

## 7. Read-only Jcode triage

### 7.1 Candidate selection

Jcode requests the standard triage queue and reviews the first 30 distinct unreviewed people. Selection follows the application's existing ordering so the audit evaluates what the founder would see next. No hidden blended score is introduced.

If the first 30 contain obvious duplicates or unresolved identity collisions, those records remain in the report and additional records may be read only to produce 30 distinct recommendations.

### 7.2 Evidence collected

For each lead, collect:

- stable person and sales-cycle identifiers
- display name
- property locality, region, and postal code
- organization and property relationship evidence
- Fit points and band
- Timing value, band, trigger names, and trigger dates
- cloud signals and contributions
- reachability and data confidence
- contact counts and contact evidence summary
- compliance status summary
- duplicate or identity concerns

Sensitive contact values are not copied into the triage report unless necessary for the founder to distinguish records. Phone numbers are masked by default.

### 7.3 Recommendation labels

Each lead receives exactly one recommendation:

- `ready_candidate`: evidence supports review-to-ready after founder confirmation
- `needs_identity`: person or ownership relationship is unresolved
- `needs_compliance`: fit/timing may qualify but outreach evidence is blocked or unknown
- `needs_contact`: qualified enough to consider a single enrichment request after gates pass
- `watch`: plausible fit without sufficient current timing
- `dismiss_candidate`: an exact qualification gate appears to apply

### 7.4 Report format

The report contains:

| Rank | Lead | Fit | Timing | Reachability | Confidence | Compliance | Recommendation | Evidence and concerns |
|---|---|---|---|---|---|---|---|---|

It also includes:

- count by recommendation
- likely P0 candidates
- likely P1 candidates
- records blocked by compliance
- records needing identity repair
- suggested founder review order

No recommendation changes application state.

## 8. Founder confirmation phase

After reading the report, the founder may approve a batch of explicit actions. Every action names the target lead and intended mutation.

Allowed confirmed actions are:

- Mark ready
- Dismiss with one exact reason
- Override a cloud score up or down
- Request contact enrichment for one lead
- Leave unreviewed

Calls, texts, emails, and bulk enrichment are outside the triage confirmation phase.

## 9. UI and accessibility requirements

- The primary phone card and alternatives control have explicit accessible names.
- DNC or unknown status is conveyed by text and badge, not color alone.
- Keyboard users can expand alternatives and reach each evidence row.
- Disabled communication controls expose the refusal reason.
- Contact list density remains compact enough for the inspector without presenting ten equal action buttons.

## 10. Rollout sequence

1. Complete and verify outbound compliance hardening.
2. Complete the required runtime, credential, and backup containment.
3. Add contact evidence fields needed by the UI.
4. Replace the flat phone-button list with primary and alternatives presentation.
5. Enforce the qualification gate for `Find contact info`.
6. Verify UI behavior with one, zero, and many phone candidates, including mixed blocked and unknown states.
7. Run Jcode's read-only triage on 20 to 30 leads.
8. Present the triage report for founder review.
9. Apply only separately confirmed state changes.

## 11. Verification requirements

Automated tests must prove:

- ten candidates render as one primary card plus nine collapsed alternatives
- vendor rank and source are visible
- blocked and unknown contacts have no enabled outbound actions
- alternatives order is deterministic
- `Find contact info` is unavailable before qualification or when suppression blocks it
- the review flow preserves Fit and Timing separately
- triage collection performs no mutations
- the report assigns exactly one recommendation per lead

A packaged-app walkthrough must verify the review flow on a representative unreviewed lead and the enriched resident with ten phone candidates.