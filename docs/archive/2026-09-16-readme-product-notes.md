# README product notes as of 16 September 2026

These two sections were removed from the repository `README.md` on 16 September 2026 (main `abfd259`) when it was rewritten as a short onboarding page. They are preserved verbatim as a historical record of how the meeting-first reporting rules, the explicit workflow transition and the legacy local customer-discovery shortlist were described at that point. They describe the legacy person/prospect routes and the schema-23 transition, not the current plan; see `docs/ROADMAP.md`.

## Meeting-first reporting and explicit legacy transition

Source-level reporting reads actual account call reports and canonical applied
calendar events. A queued message, connection acceptance, old Interviewed stage,
or generated pilot suggestion is not a real meeting or pilot. Booking updates and
cancellations retain meeting identity. Calendar operational `held` means an
execution hold, not attendance. Attendance and actual pilot starts require separate
owner-reported evidence, admitted through authenticated owner commands and the
ordered immutable event ledger. Attendance binds the account's existing calendar
identity and elapsed scheduled end. Source references and notes are owner testimony,
not external verification or model-generated facts. Missing costs, time and model
usage stay unknown, not zero. Renderer exposure and live acceptance remain gated.

Schema23 adds an initially empty workflow state and immutable transition receipts.
Migration alone does not change legacy mode or enroll historical owner rows.
The explicit `transitionWorkflow({commandId, expectedMode, manifestId})` domain
command atomically records the mode and preservation manifest. It parks only
proven superseded automatic acquisition work, preserves callbacks and ambiguous
obligations, and does not rewrite drafts, history, suppression or immutable
catalogs. Replay is idempotent and changed/stale commands fail. Parked legacy
identities remain historical records, not new founder homework. Source adapters'
live schedules are unchanged. Real workspace transition and whole-product D5
acceptance remain separately gated. No navigation or renderer redesign is claimed.

The incremental non-AI budget target is approximately $20/month. Genuine cold-email
transport, new grants and all live sends/calls/invitations require separate approval.

## Existing local customer discovery

While Callie is open, local processing assesses retained source evidence and prepares
an advisory shortlist in Today. It resumes pending work when the app reopens. It
is not an always-on service and does not process records while the app is closed.
No model account is needed for deterministic assessment and discovery questions.
Optional additional research is **not configured by default**. A shortlist is not
outreach permission, verified buying intent, or automatic paid enrichment.

Use **Prepared conversations → View evidence → Contact options**. Evidence remains
read-only until Contact options prepares that one selected Person and opens the
existing inspector. Unknown owners and ownership conflicts are not promoted into
verified contacts. Missing assessment means **Not assessed**, not zero Fit. Local
Fit and Timing remain separate from cloud scores. Due promises and follow-ups
stay ahead of new prospecting. Watch, exclude and reconsider decisions preserve
founder context without rewriting sales history.

Calls/messages remain explicit actions. Saved email drafts are durable and unsent
until explicitly dispatched. Updating default generation instructions does not
rewrite old saved draft text or history. Record an actual conversation, confirm Interviewed with its evidence,
and explicitly mark **I stated the price** when logging a real price communication
before separately confirming Offered. A generated pilot suggestion is not an
executed offer, booked meeting, paid pilot, payment, or Won outcome.

Local assessment and priority-refresh recovery is finite: the initial attempt has
at most **three shared lifetime retry/recovery credits per substantive-input
lineage**. Ordinary failures and interrupted-restart retries share those credits.
Restoration or successful recovery does not reset them. Exhaustion remains visible
as preparation needing attention, with original diagnostics retained. Changed
substantive evidence can create new work, but returning to exhausted old evidence
does not grant another budget.
