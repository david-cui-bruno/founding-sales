# Issue742 P1 owner/Firm stop acceptance, October 22 2026

## Finished scope

Source correction is separately owned commit `5f5466148`. This new acceptance addresses only ST742-1 / R742-RISK-1 from the complete private standards/risk reviews. It does not replay the prior seven-case automatic supply suite, migration catalog, or issue738–741 suites.

NEW `apps/web/test/e2e/automaticSupplyHolds.spec.ts` uses the existing real local HTTPS `createBrowserServer`, signed synthetic OIDC, migrated disposable PostgreSQL, installed headless Chrome and registered discovery/qualification scheduler/runner. Controlled source/page/extraction adapters remain synthetic, not live-provider usefulness evidence. Existing closed helpers and domain source are unchanged by this acceptance.

## Four NEW actual cases

1. A matching sourcing-owner research hold prevents automatic creation/publication and scheduler recovery from committed qualification. After explicit release, the same evidence publishes without provider redispatch. A new matching owner hold refuses the exact existing TodayV4 open/list while retaining the publication unchanged.
2. An exact preexisting canonical Firm research hold prevents linkage. The prerequisite Firm is created through ordinary domain `seedFirm`, with research disabled only during fixture setup, before real approved-source ingestion/qualification. No manual candidate preparation/link substitutes for automatic publication. After release, the published Firm ID must equal that preexisting canonical ID. A subsequent matching Firm hold refuses current open/list and blocks an observable evidence-fingerprint/revision refresh. Release permits exactly one revision refresh on the same publication/Firm.
3. Matching owner stop changes after actual controlled publication and read waits refuse current authority. An independent runtime session holds the ordinary send gate, the scheduler recovery is observed blocked using `pg_blocking_pids`, then that stop-fact transaction opens the owner hold through `openHold` and commits. Recovery refuses the refresh. Separately, a real HTTPS proof open is observed blocked on owner membership, an ordinary owner hold commits, and releasing the membership lock returns null proof and excludes the action.
4. The same actual publication/read wait sequence matches the exact canonical Firm ID, not a candidate ID, and refuses the Firm-held proof.

Unrelated owner and Firm research holds, plus same-subject `email_send` holds, remain unreleased during successful publication and exact reads. The tests verify hold IDs remain active and release only their own fixtures. Acquisition and qualification run once per candidate, with page-fetch/extraction counters fixed at1/1 after recovery/holds. Refusal leaves publication rows/revisions/fingerprints unchanged. Zero outbound rows and `sendingEnabled:false` are inherited and checked by the existing host/teardown.

## Exact checks and corrections

- Initial non-PG web typecheck failed two new fixture enum values: `send_email` is not the existing blocked-action kind. Corrected both to `email_send`. Same-session hold transactions were also serialized during inspection. No PostgreSQL run preceded these corrections.
- Corrected web typecheck and new-file ESLint passed, as did `git diff --check`.
- Only NEW cases executed: `FSS_LOCAL_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e --workspace apps/web -- automaticSupplyHolds.spec.ts --workers=1 --max-failures=1`.
- Terminal task `291858225h`: **4 PASS,0 FAIL**, Playwright10.1 seconds, wrapper10.75 seconds. No failing PG/browser attempt or full-suite replay.

The sole disposable lane was acquired after frozen source readiness. Owned cluster `/Users/davidcui824/.jcode/scratch/fss-pg-7xFZn9`, PG PID45143, DB `fss_test_4360311c9b484b9b8ce50352d8d9f697`, TLS directory `fss-browser-tls-IKaVOZ` were explicitly released. Each of four Chrome profiles and recorded root/child PIDs was checked absent. HTTPS listener, database, template, cluster/storage directory, TLS and PG PID absence all passed. Homebrew PostgreSQL PID1412 remained unchanged. No provider/cloud/spawn/push/deploy/send operations occurred.

Focused source-owner read-only review of the full new spec and relevant fixture/lock helpers was CLEAN, no correction requested. The actual waits exercise the publication entry send gate and owner-membership proof wait. They do not specifically force the post-audit final-savepoint branch, which the source owner's synthetic no-PG case covers. No broader real-PG final-branch claim is made.

Normal workflow/scoped-scan terminal results are recorded in the private `fss-automatic-supply-20261022/P1-ACCEPTANCE-FINISHED.md` handoff. Production/main/schema and hosted usefulness are not reverified or claimed by this local correction.
