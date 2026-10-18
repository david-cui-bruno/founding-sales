# Ask bounded history and continuity preparation — October 12, 2026

## Source outcome

PR592 is integrated at `0a761e9f`. Continuing #551 through the approved authenticated API → configured SDK → registered worker seam, with disposable PostgreSQL and fake model adapters, found one reproducible defect: after a human stage change, a pronoun follow-up lost the prior question because public history correctly marked the old answer stale. The no-change diagnostic retained that question.

The repair shares current source/access checks between public history and internal session context. Only an exact-observation freshness mismatch can preserve the dated prior question, with `answer: null`. Public stale reads still erase question, answer and fallback. Source deletion, changed access, conflict state, invalid dependencies and scope narrowing do not gain this exception. The next turn executes current tools; old prose and exact handles are absent. No public contract, schema, sending control or activation policy changes.

Separate-note cancellation discovery already worked and needed coverage rather than a fabricated repair. Tests cover discovery, original citation navigation, follow-ups, source deletion, mixed original/SQL context, scope changes and final history/session erasure.

## Controlled verification

The combined relevant API check passed 55 tests across nine files; the opt-in actual-provider test remained skipped. Seven history evaluation preflights include four normal journeys, ambiguous provider acceptance stopping, visible source-deletion failure, and preservation of an ambiguous stopping reason when cleanup also fails. Domain/API/worker typechecks and focused lint are required before integration; PR checks remain authoritative for the frozen source.

The four normal preflights used fourteen fake generations. Maximum framed input was 24,482 UTF-8 bytes including the existing 2,048-byte framing allowance. These counts are controlled observations, not actual provider cost, quality or latency.

## Prepared actual comparison, pending fresh approval

The fixed [synthetic labels](../../../../tools/ask-evaluation/fixtures/ask-history-continuity-v1.json) define three bounded history questions and a two-turn session: separately retained cancellation; conditional mapping offer with a different firm excluded; ambiguous pilot; current stage followed by a human change and pronoun follow-up. Expected/forbidden labels are capture-only and never model input. Pasted dates remain reported content, not observed authorship. Initial history source lists are empty so the model must discover retained originals through tools.

Use the existing opt-in actual runner and budget conservation, not a new harness. Freeze source commit, actual tracked source hash, labels, exact questions and critical driver hashes. Proposed comparison: Sonnet4.6 and Haiku4.5 US profiles, thinking disabled, six generations per answer, 30,000 input bytes, 1,000 output tokens, no retries. Each run allows one counted transport probe plus five answers × six generations: 31 calls/$10 per model, combined 62 calls/$20. A ceiling is not funding; prior grants are consumed. No dispatch until actual owner approval of the frozen proposal.

Capture candidates, body-free diagnostics, native transport, original navigation, public stage-change readback, source-deletion-only readback, final history/session deletion and conserved allocations. Unknown provider acceptance stops further scenarios. Cleanup failures remain failures even if later explicit history deletion succeeds. Review every actual answer for support/usefulness, cost and latency; a valid citation alone does not prove entailment. No general model ranking or representative-quality claim follows from these familiar synthetic journeys.

## Remaining gates

#551 remains open for actual history/session outcomes, applicable responsiveness/readiness and deployed scoped operation. Gmail-backed claims additionally need #549 evidence. Source targets schema105; production remains the last observed d49/schema88 under the release hold. No production writes, provider calls, activation or sending occurred in this preparation. Cap5/lower caps, recipient-local windows, Shirley identity/cancelled follow-up and automatic admission/routine replies/autonomous calling OFF remain unchanged.
