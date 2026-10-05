# Scheduled candidate source monitoring

Spec: `docs/superpowers/specs/2026-10-04-targeted-lead-sourcing-design.md`.

Use executing-plans inline. Reuse the current isolated branch and draft PR397.

## Scope and rulings
- Monitor kept candidates only. Keeping enables weekly source rechecks; returning to review or dismissing stops monitoring. Surface this behavior in the candidate UI.
- Add an indexed next-check timestamp. The worker scans hourly, at most 25 due candidates per workspace per sweep, oldest due first. A successful enqueue advances the timestamp seven days; explicit checks reset it too. No catch-up burst for missed weeks.
- Research settings/holds and the shared daily count apply. Exhaustion leaves candidates due. Provider configuration gates scheduling. No model/search calls, admission, outreach or deployment.
- Reuse the existing source-check job. Failed/dead checks retain old evidence; weekly attempts are bounded by cadence/count. Invalid URLs advance a week to avoid starving later candidates. Late results cannot overwrite newer requests.
- New-firm discovery remains dependent on selecting/configuring a bounded search provider; this slice implements the independent monitoring part of the approved design.

## Tasks
1. [x] Domain tests RED then migration48, next-check DTO, kept-state lifecycle, bounded scoped sweep using existing enqueue. Test due/fresh/dismissed, budget defer, workspace isolation, replay, failed/dead jobs and manual reset.
2. [x] Worker tests RED then hourly source/handler registration and provider flag. Exercise real scheduler/job runner, no external calls during sweep and disabled composition.
3. [x] UI test RED then show monitoring due date and keep/stop explanation. Run affected tests, full gate, independent final review, address substantive findings with regressions, commit/update draft PR.

## Review focus
No repeated hourly network requests, no lost due work on exhausted counters, no duplicate checks after restart, no non-kept monitoring or model calls. Candidate review races must serialize with sweep. No source payload in jobs/audit. Existing manual-check and research behavior must remain intact.

## Verification record
- Domain sourcing/counter/constraint tests: 1,322 passed in the affected run. Worker source/check runner: 2 passed. Desktop candidate UI: 10 passed.
- New monitoring behavior and UI were observed failing before implementation. Scheduled-check cancellation and missing-provider registration regressions were observed failing, then fixed.
- Independent code review found no substantive issues. No additional reviewer-run tests or live network requests.
- Repository checks passed: typecheck/lint plus 6,843 tests (16 existing skips). The initial gate caught a missing scheduler documentation row; after correcting it, the worker/desktop/ops suites passed on rerun. No product code changed after the earlier contracts/domain/API passes. Not deployed; sending unchanged.
