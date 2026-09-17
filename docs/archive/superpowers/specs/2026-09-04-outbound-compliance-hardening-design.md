# Outbound Compliance Hardening Design

**Status:** Approved

**Date:** 2026-09-04

**Product:** Callie Founder Sales System

## 1. Purpose

Prevent Callie from treating missing, stale, or incomplete compliance evidence as permission to contact a prospect. This design makes federal DNC, TCPA, person-level opt-out, state clearance, and suppression synchronization fail closed before any founder-initiated call or text can begin.

The immediate operational rule is simple: no prospect outreach resumes until the affected gates and suppression replay are verified.

## 2. Confirmed problems

The audit established the following defects:

1. Contact records store DNC and TCPA as booleans. Missing vendor fields and manual intake can become `false`, making unknown evidence indistinguishable from verified clear evidence.
2. Existing phone handles may be skipped during later intake, so a new positive DNC or TCPA result does not reliably upgrade an existing contact to blocked.
3. The local suppression exporter reuses a date-derived S3 object key. The cloud ledger records only the object key, so a later same-day overwrite can be skipped permanently.
4. Malformed suppression rows are skipped while the containing object is still marked processed.
5. Scrub provenance, covered area code, scrub time, and expiration are not retained per contact.
6. State-specific registration and DNC obligations are unresolved for Massachusetts, Rhode Island, and Connecticut.
7. Call-window and jurisdiction checks are not coupled to the final outbound execution gate.

## 3. Non-negotiable behavior

- Unknown compliance state is blocked, never treated as clear.
- A positive block is monotonic. Later intake may add or strengthen a block but may not silently clear one.
- Person-level opt-out remains an unconditional permanent block.
- Every outbound call or text requires fresh, area-code-covered federal evidence and an explicit jurisdiction clearance decision.
- Compliance is a hard eligibility gate, not a lead score or ranking factor.
- All suppression objects are immutable and replayable.
- One invalid suppression record fails the whole object. The object is not ledgered and an alert is emitted.
- The founder still initiates every outreach touch. Passing the gate does not initiate communication.

## 4. Contact compliance model

Replace the ambiguous boolean-only interpretation with an explicit verification record for phone contacts:

```ts
type FederalContactStatus = 'unknown' | 'verified_clear' | 'listed';

type ContactComplianceEvidence = {
  federalStatus: FederalContactStatus;
  tcpaFlag: boolean | null;
  coveredAreaCode: string | null;
  source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
  scrubbedAt: string | null;
  expiresAt: string | null;
};
```

Interpretation rules:

- Missing evidence becomes `unknown`.
- `listed` blocks calls and texts regardless of other fields.
- `tcpaFlag === true` blocks calls and texts.
- `tcpaFlag === null` is unknown and blocks calls and texts.
- `verified_clear` is usable only when the phone area code equals `coveredAreaCode` and `expiresAt` is in the future.
- Legacy rows migrate to `unknown` unless a retained evidence artifact proves a stronger status.

The existing booleans may remain temporarily as compatibility projections, but authorization must use the explicit evidence model.

## 5. Monotonic intake and merge rules

Contact ingestion must merge compliance evidence independently of whether the phone handle already exists.

Merge precedence is:

1. Person opt-out
2. Federal `listed`
3. TCPA `true`
4. Unknown or expired evidence
5. Fresh `verified_clear`

A fresh clear result may replace an earlier unknown result. It may not clear a prior listed or TCPA-positive state without a separate, audited correction command containing new authoritative evidence.

The contact upsert transaction must:

1. Normalize the phone.
2. Locate or create the contact method.
3. Merge compliance evidence using the precedence rules.
4. Append an audit event containing the old state, new state, source, and evidence timestamp.
5. Recompute outbound eligibility before committing.

## 6. Immutable suppression protocol

### 6.1 Object naming

Each local upload uses an immutable key:

```text
upstream/suppression/YYYY-MM-DD/<timestamp>-<batch-id>.ndjson
```

No suppression object is overwritten.

### 6.2 Ledger identity

The cloud ledger records:

- bucket
- object key
- S3 version ID when present
- ETag
- processed timestamp
- valid row count
- object checksum

A ledger hit requires the same key, version ID, ETag, and checksum.

### 6.3 Atomic validation

The suppression Lambda validates every line before writing any processed marker. If any row is invalid:

- no rows from the object are applied
- the object is not ledgered
- the invocation fails
- structured diagnostics identify the key and line number without logging the contact value
- an alarm is emitted

### 6.4 Historical replay

Before re-enabling enrichment:

1. Enumerate every version of existing suppression objects.
2. Parse them in version order.
3. Build the union of all valid person and contact tombstones.
4. Quarantine invalid versions for manual repair.
5. Apply the union idempotently.
6. Verify the resulting suppression membership against the local export.

## 7. Outbound authorization gate

One domain service owns final authorization for calls and texts. It accepts the person, contact method, current time, recipient jurisdiction, and evidence record.

It refuses when any of these are true:

- person or contact opted out
- contact kind does not match the requested channel
- contact validation is not usable
- federal status is unknown, listed, stale, or not area-code-covered
- TCPA status is positive or unknown
- jurisdiction clearance is missing or blocked
- the recipient-local calling window is closed
- a required state registration or state DNC subscription is missing

The refusal returns a stable reason code for UI display and audit logging. Contact values are not logged.

The gate is evaluated immediately before the actual communication handoff. A prior UI render or scheduling decision is never sufficient authorization.

## 8. State clearance

Store recipient jurisdiction separately from phone area code. Property and residence evidence may establish jurisdiction; area code alone may not.

Until counsel and registration questions are resolved:

- Massachusetts consumer and sole-proprietor calls remain blocked.
- Rhode Island and Connecticut outreach remains blocked when the applicable registration or consent rule is unknown.
- Call-recording eligibility remains separate from call eligibility and requires its own consent decision.

The product records the clearance source, effective date, and expiration or review date.

## 9. UI behavior

Every phone displays one of:

- Verified clear until `<date>`
- Federal DNC listed
- TCPA blocked
- Compliance unknown
- Scrub expired
- Area code not covered
- State clearance required

Call and Text controls remain disabled for every status except fresh verified clear with state clearance. The disabled control explains the exact refusal without exposing internal implementation details.

## 10. Rollout sequence

1. Pause scheduled cloud enrichment.
2. Add the explicit compliance model and fail-closed authorization tests.
3. Implement monotonic contact evidence updates.
4. Implement immutable suppression objects and version-aware ledgering.
5. Replay historical suppression versions and reconcile membership.
6. Add state and calling-window authorization.
7. Verify representative allowed and refused outbound workflows.
8. Re-enable enrichment only after suppression reconciliation and alarms pass.
9. Keep prospect outreach paused until the final outbound gate is verified in the packaged application.

## 11. Verification requirements

Automated tests must prove:

- missing vendor fields produce unknown and blocked status
- manual and legacy contacts are blocked without evidence
- a later DNC hit upgrades an existing phone
- a later clear result cannot silently clear a positive block
- two same-day suppression uploads are both processed
- a malformed suppression row prevents ledger completion
- replaying the same immutable object is idempotent
- stale or wrong-area evidence is refused
- state-uncleared and outside-window calls are refused
- the gate runs immediately before the outbound handoff

Operational verification must reconcile local tombstones against the replayed cloud membership and retain a dated evidence report.