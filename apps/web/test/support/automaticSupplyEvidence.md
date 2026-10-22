# ADR0014 local automatic supply acceptance, October 22 2026

## Scope and result

Contract `ffe1e1759`, ADR0014. New `automaticSupply` test paths only, plus new migration0131 constraint cases and two-line, zero-net-line catalog registration. Closed issue738–741 helpers were not edited and their suites were not replayed. The original first-edit policy scaffold was removed rather than retained as a tautological OFF assertion.

The NEW seven-case Playwright suite exercises actual `createBrowserServer`, real local HTTPS/TLS, signed synthetic OIDC with PKCE/JWKS verification, a migrated disposable PostgreSQL database, installed headless Google Chrome, and actual web TodayV4. Acquisition, page fetching and extraction are controlled synthetic adapters, not live providers, inference quality or business usefulness evidence.

`runDiscovery` and `runApolloDiscovery` retain actual completed source attempts and source associations. The existing qualification scheduler, `HandlerRegistry`, real `sourcingQualificationHandler` and `runOnce` perform qualification completion. No manual discovery preparation, per-candidate create/link clicks, direct `finishQualification`, injected browser principal or new enrollment authority substitutes for this path.

## Acceptance coverage

- Search-hit and Apollo organization positives automatically produce one canonical research Firm. Native identity/residential-management/service-area facts and independently retained eligible email evidence contain no phone fact. Exact owner, source attempt/URL, candidate/run/current revision, publication revision, fingerprint and retained citations reach TodayV4 and visible browser proof after reload.
- Actual reads leave Firm rows, publication count, job count and command-receipt count unchanged. Browser storage contains no private proof. Research grants no contacts, routes, opportunities, calling admissions, promotion IDs, campaign source/admission or enrollment. The host remains `sendingEnabled: false`, and real outbound-message rows remain zero.
- One controlled fault refuses only the runner's final `UPDATE jobs SET state='done'` acknowledgement, after the unchanged registered qualification handler committed evidence and owner-based publication refusal. The job remains running, evidence is committed, and the existing scheduler recovers after authority restoration without provider redispatch. Duplicate scheduler passes and actual concurrent publication transactions preserve one publication/Firm and one qualification reservation.
- Current source URL association, candidate revision, run policy, owner role/assignment, research settings, automatic approval, reviewed evaluation and a research channel hold independently refuse exact targets.
- Native and email observations expire independently. Each starts with a current proof, then an actual HTTPS open is observed blocked on a real PostgreSQL membership-row lock until after expiry. Fresh wall-clock rechecks return null rather than transaction-start-time proof. Auth fixture time is not advanced to manufacture evidence expiry.
- Ambiguous literal identities and raw discovery-v1 remain internal. Deleting retained search/Apollo source association removes publication visibility. Ordinary Firm privacy preview/commit redacts the Firm in place and removes the publication. Reload and committed recovery do not resurrect either. Unrelated Firm rows survive.
- The privacy deletion support action uses the existing API dispatcher with a separate real signed synthetic OIDC grant. Browser deletion is deliberately not allowlisted. It does not inject a principal or bypass ordinary deletion dependencies with raw snapshot cleanup.
- A real successful proof response held until second-tab logout cannot repopulate projections, including across workspace transition. Real device revocation refuses another open. Mutable source lineage is rejected by the actual database trigger.
- Fourteen new failing declarative catalog cases plus the existing full-catalog completeness assertion pass. Other 3,030 catalog tests were skipped, not claimed as rerun acceptance.

## Observed failures and corrections

1. Initial non-PG typecheck caught two fixture mistakes: narrow `SessionQueryable` has no `end`, and `releaseHold` takes a string. Corrected to database-owned session teardown and the actual API.
2. First browser attempt failed all six then-existing cases at fixture configuration: searches-per-day 20 violated the existing maximum10. Corrected the fixture to10 without changing production limits. Each failed worker released its own resources.
3. Next attempt failed its first assertion because the existing verified-Firm owner legitimately advances a draft from revision1 to current revision2. Corrected the assertion to compare current candidate/run/publication lineage, not the stale ingest snapshot.
4. Next split was three passed, one failed, two not run. An isolated diagnostic repeated the expiry failure. The fixture appended `Z` to a session-zone timestamp, accidentally aging native evidence by four additional hours. Corrected formatting with `AT TIME ZONE 'UTC'` and strengthened the case to actual in-request row-lock waits.
5. Next split was four passed, one failed, one not run. A raw Firm DELETE hit the existing Today snapshot FK. Replaced it with the ordinary signed-auth privacy preview/commit workflow, rather than deleting snapshot dependencies.
6. The next scoped deletion attempt exposed a mistaken physical-deletion expectation. Ordinary privacy deletion preserves the redacted business-history Firm. Corrected assertions to `[deleted]`/null website and coordinated publication privacy-erasure integration with the domain owner. Domain fixes are separate commits, not hidden in this test commit.
7. The isolated late-auth case passed. The scoped catalog run passed15 assertions. The complete NEW seven-case browser suite then passed7. After adding explicit automatic-approval/evaluation/owner refusal steps, the final finished suite passed7 again in24.1 seconds, including Apollo and actual lost completion acknowledgement. Every owned resource teardown check passed.
8. The same domain reviewer performed a finished read-only review and targeted recheck of the lost-completion/Apollo deltas: clean, no additional requested changes. This was not a spawned worker or another PostgreSQL run.

## Commands and limits

- Pinned Gitleaks8.30.1 through the repository's approved `scanWithGitleaks` API: seven exact owned files, zero findings. Private scan staging was removed and checked absent. This is a scoped current-file scan, not a full-history scan.
- `npm run typecheck --workspace apps/web`: passed.
- `npx eslint --max-warnings 0 apps/web/test/e2e/automaticSupply.spec.ts apps/web/test/support/automaticSupply*.ts packages/domain/test/db/support/automaticSupplyCases.ts`
- `npm run gate:workflow`: passed. Existing counts remain86 files over800 lines,7 over2,000,46 functions over500. The catalog registration adds zero net physical lines.
- `npm run test --workspace packages/domain -- test/db/constraints.test.ts --maxWorkers=1 -t 'sourcing_automatic_research|has a case for every constraint'`:15 passed,3,030 skipped.
- `FSS_LOCAL_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e --workspace apps/web -- automaticSupply.spec.ts --workers=1 --max-failures=1`

Only one disposable PostgreSQL lane runs at a time, after server/domain readiness. Browser/root/child PIDs and profile directories are recorded and checked absent on teardown. The reused HTTPS host explicitly verifies listener shutdown, fixture DB absence and TLS-directory removal. Database/template/cluster/PG PID absence is verified after release. Unrelated Homebrew PostgreSQL PID1412 is checked unchanged and never adopted/stopped.

No live/provider/cloud calls, paid services, UI automation outside installed headless test Chrome, production changes, pushes, deployments, Gmail capture, LinkedIn actions or sends were performed. Production/main/schema129/OFF retained checkpoints are not reverified by this local acceptance. Hosted usefulness and campaign integration for this separate source kind remain outside this result.
