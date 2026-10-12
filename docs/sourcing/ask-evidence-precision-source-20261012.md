# Ask contextual evidence guidance — October 12, 2026

## Problem and scoped implementation

The actual [history/session comparison](ask-history-continuity-results-20261012.md) found three Sonnet failures despite global instructions: an anonymous author called “the contact,” current opportunity status described as historical at `openedAt`, and SQL opportunity names embedded in an original-only claim. Existing host guards validate reference membership/current authority; they do not establish free-text entailment.

Keep the existing configured SDK and registered worker. The source change places short interpretation guidance beside selected-note and exact opportunity evidence, and a concrete split-or-mixed citation example in the final-answer tool. Firm association does not identify a speaker; body attribution stays reported text. Current stage/status are distinct from the opening timestamp. Each mixed claim needs both authorities; a neighboring claim's SQL citation cannot support it.

Canonical source text, SQL values, handles, public schemas, persisted output and tool authority are unchanged. No automatic reference insertion, prose rewriting, keyword-based semantic checker, added model call or framework is introduced. These are targeted guidance changes, not mechanical prevention of semantic errors.

## Verification and limitations

TDD uses the agreed authenticated commands → configured SDK with fake external LanguageModel → registered worker, real disposable PostgreSQL. New tests first fail on missing contextual guidance, then verify its delivery. Scripted answers test canonical reference decoding, original navigation, diagnostics, current SQL preservation and subsequent original-deletion erasure. They do not test hosted-model compliance or usefulness.

The existing empty-opportunity projection assertion is updated to retain its absence limit while allowing the additional temporal limit; the substantive assertion remains. Three new configured regressions cover the changed guidance, alongside passing focused API/worker checks, typechecks and lint. Eight configured evaluation preflight tests also pass without provider dispatch; maximum history framing is25,679 UTF-8 bytes including2,048 overhead, below the30,000 limit. Exact-source CI and frozen independent Standards/Spec reviews precede integration.

Earlier paid runs remain measured failures/limited successes on their original sources; their grants are consumed. Semantic quality after this change needs a separately approved actual run on frozen source. Do not declare affected hosted readiness accepted based on controlled tests. #551 remains open for applicable actual outcomes/readiness and deployed scoped operation.

PR594 merged as `7c7f0eca`, preserving actual history results. Production remains the last observed d49/schema88; source targets schema105 under the release hold. No provider calls, production writes, activation or sending occur in this source repair. Cap5/lower caps, recipient-local windows, Shirley identity/cancelled follow-up and automatic admission/routine replies/autonomous calling OFF remain unchanged.
