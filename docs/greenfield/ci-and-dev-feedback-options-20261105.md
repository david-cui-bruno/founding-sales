# CI and development feedback: measured bottlenecks and options

November 5–6, 2026. Native parallel CI passed broad PR and main runs; focused local loops and explicit finite signed-browser rebuild are implemented. No paid runner, account or production control was activated. The main model retains screen-design ownership.

## Recommendation

Keep GitHub Actions. Run independent selected suites on separate standard runners before adopting another platform. Keep the existing conservative affected-suite selection, full shared static analysis, mandatory ops checks and migration/security gates. Do not replace real database checks with cached success or disable test isolation.

The repository is public and owned by the personal account `david-cui-bruno` (verified with the GitHub API). Standard public-repository Linux runners are free; `ubuntu-24.04` has 4 vCPU/16 GB according to [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). A paid runner would introduce spending rather than replace an existing standard-runner bill.

## What the latest main run actually did

Source: [Greenfield run 42107007773](https://github.com/david-cui-bruno/founding-sales/actions/runs/42107007773), job 127524361017, November 5. The whole workflow took 21m33s; its combined gate step took approximately 20m13s. Install took 7s. The following command times are rounded from timestamp boundaries, including npm overhead, rather than summed CPU time:

| Serial command | Approximate wall time |
| --- | ---: |
| Typecheck chain | 1m24s |
| Lint | 25s |
| Contracts, telemetry and social-publisher tests combined | 10s |
| Domain tests | 6m29s |
| API tests | 4m57s |
| Worker tests | 1m21s |
| Web tests | 2m02s |
| Ops tests | 3m25s |

[`select.mjs`](../../tools/ci/select.mjs) already chooses affected suites/dependent consumers for PRs and broad coverage on main. Preserve that conservative selection. The former [`run-selected.mjs`](../../tools/ci/run-selected.mjs) ran shared typecheck, lint and selected suites serially; its replacement exposes separate plan/static/suite invocations and retains actual per-command timings.

The measured critical-path opportunity is overlapping independent work, not shaving dependency-install seconds. Image workflows run separately; container-build acceleration does not directly shorten this test step. This Greenfield step invokes Vitest/Node tests, not the Playwright spec runner.

## Native implementation and acceptance

The workflow validates the existing selector's output, runs repository typecheck/lint once, and overlaps six isolated machine groups: domain, API, ops, web, worker and the three small packages. Each selected suite runs once; ops remains mandatory, and broad plans require all eight suites. The always-present required `greenfield` aggregate refuses missing, skipped, cancelled, failed or invalid prerequisites. Upgrade, workflow and secret gates remain separate and unchanged. PR cancellation is limited to the same attempt; main runs are not superseded.

The retained-original PostgreSQL authority now recognizes only the hosted `suites` job with `CI_MACHINE=domain`, preserving Linux/hosted-runner, pgvector, matching canonical template/service and local explicit-grant restrictions. The old job identity is not a compatibility alias. Its regression went from two failures before correction to23 passes afterward without allocating PostgreSQL. Four focused CI ops files passed43 checks; repository typecheck, lint, actionlint and workflow budgets passed. An actual selector→CLI publication produced six groups covering all eight suites; aggregate success exited0 while cancelled work and an unselected machine each refused with exit1. Temporary smoke inputs were removed. Combined/security reviews closed. The real hosted broad matrix, domain PostgreSQL authority and required aggregate all passed; live cancellation/rerun behavior was not independently exercised.

Completed Greenfield observations on standard free runners; elapsed time is run start through completion metadata, summed job time excludes the separate images workflow:

| Run | Shape | Workflow elapsed | Summed job time | Outcome |
| --- | --- | ---: | ---: | --- |
| [Serial main42131241245](https://github.com/david-cui-bruno/founding-sales/actions/runs/42131241245) | 4 jobs | 27m45s | 29m15s | Passed |
| [First parallel PR42132834751](https://github.com/david-cui-bruno/founding-sales/actions/runs/42132834751) | 12 jobs | 9m55s | 28m29s | Passed |
| [Final CI PR42135670578](https://github.com/david-cui-bruno/founding-sales/actions/runs/42135670578) | 12 jobs | 7m42s | 25m45s | Passed |
| [Parallel main42137468096](https://github.com/david-cui-bruno/founding-sales/actions/runs/42137468096) | 12 jobs | 7m02s | 25m48s | Passed |
| [Signed-rebuild PR42143462182](https://github.com/david-cui-bruno/founding-sales/actions/runs/42143462182) | 11 jobs | 11m19s | 27m10s | Passed |
| [Repaired main42144885902](https://github.com/david-cui-bruno/founding-sales/actions/runs/42144885902) | 12 jobs | 9m41s | 32m45s | Passed |

The first parallel main's [images workflow42137467967](https://github.com/david-cui-bruno/founding-sales/actions/runs/42137467967) passed in5m58s; publication is not production deployment. The longest suite varied between Domain and API. These are successful observations, not a controlled benchmark, median/tail or reliability guarantee. Parallelism reduces elapsed feedback, not necessarily aggregate runner time. The ten-minute target has been met on free runners, but not consistently; paid pilots remain deferred.

PR944's metadata shows86seconds before any job started; it does not establish the cause. Its Domain job spent523seconds in the selected-suite command versus10seconds installing dependencies. Existing logs report541 files/9520pass/3skip and522.43seconds, with per-file isolation retained. Measure ordinary-run variation and profile or shard the dominant suite before buying faster runners; do not disable isolation or weaken database ownership to improve a number.

The intervening [main42140214111](https://github.com/david-cui-bruno/founding-sales/actions/runs/42140214111) correctly failed the required aggregate after a Web privacy assertion mistook digits214 in an allowed expiry ending `.214Z` for phone data. The captured record contained no phone, source label or URL. PR944 fixed the clock case and excludes actual private fixture values from commands and storage, retaining same-command unknown recovery; runtime custody is unchanged. Both subsequent PR/main gates passed. The failed run remains fail-closed evidence, not a successful timing sample.

This CI/source change takes the existing protected `review_prepare`→`reviewed` release route when the useful M1/M2 application bundle is ready. Its domain-config and app-documentation paths also trigger the images workflow; published images are not a production release. Keep the application-only operator's audited CI-byte guard intact; neither a merge nor image publication establishes the new production baseline. See [the release procedure](../operations/lean-release-workflow.md#reviewed-infrastructure-or-protected-changes). No shell-only M1 release, production dispatch, hold change or spending follows.


## Tools and fit

| Tool/product | What it changes | Decision for this repository |
| --- | --- | --- |
| [GitHub Actions matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) | Separate machines run independent jobs | First choice. Run static analysis once, selected test suites independently, then retain one required aggregate check. Each DB job owns its disposable Postgres/template. Missing, failed or cancelled required work must not aggregate to success. |
| [Vitest sharding](https://vitest.dev/guide/improving-performance#sharding) | Splits test files across processes/jobs | Use if a suite still dominates after package-level parallelism. Splits are not historical-duration balancing; measure the longest shard and setup overhead. Keep per-file isolation. |
| [Turborepo](https://turborepo.dev/docs/crafting-your-repository/caching) | Task graph and local/remote task-output caching | Optional later for deterministic build/static-analysis work. Correct input, toolchain and environment keys are required; it is not a faster test machine. Existing affected selection already covers part of its value. |
| [Nx / Nx Cloud](https://nx.dev/docs/features/ci-features/distribute-task-execution) | Task graph, caching and distributed task execution | More platform than needed for the initial fix. Reconsider if measured task-graph imbalance remains after native parallelism. Prove our real-Postgres lifecycle on any remote workers first. |
| [Depot runners](https://depot.dev/docs/github-actions/overview), [Blacksmith](https://docs.blacksmith.sh/introduction/quickstart.md), [Namespace](https://namespace.so/docs/solutions/github-actions), [Ubicloud](https://www.ubicloud.com/docs/github-actions-integration/quickstart) | Different runner hardware and caches | Benchmark only if native changes are insufficient and spending is approved. Depot runners and Blacksmith require organizations. Namespace explicitly supports personal accounts but requests repository Administration and Actions read/write. Ubicloud personal-account eligibility was not verified. Vendor speed/pricing claims were not treated as measured gains. |
| [GitHub larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners) | More compute per job | Not a drop-in option: limited to organizations/enterprises on eligible plans, unlike this user-owned repository. Do not move repository ownership just to obtain faster CI. |

A third-party runner receives the job's source and any supplied credentials. A future trial must exclude production/provider credentials, examine GitHub App/fork-PR permissions and use synthetic data. Protected release execution must remain separate. Cache writes need trusted-branch ownership; never cache credentials, browser profiles, private notes or uncertain command custody.

## Paid shortlist and actual-volume cost forecast

David agreed with the native-first recommendation and requested paid-option costs; this is not purchase authority. First paid candidate: Namespace, whose personal-account support is documented. Lower-cost alternative: Ubicloud, subject to confirming personal-account installation and the selected tier. Do not relocate the repository to obtain Depot/Blacksmith runners.

The GitHub API returned 295 completed Greenfield workflow runs created October29–November4 UTC, with 297 `greenfield` job attempts including reruns, no missing jobs/timestamps and no failed data fetches. Summed job runtime was 5,500.33 minutes. A thirty-day projection at that activity rate is approximately 23,573 aggregate job-minutes. This is not a vendor bill: it includes failed/cancelled work, excludes other workflows/jobs and assumes unchanged runtime. Source: [workflow runs API](https://api.github.com/repos/david-cui-bruno/founding-sales/actions/workflows/362446615/runs?created=2026-10-29..2026-11-04&per_page=100), following every run's jobs endpoint with `filter=all`.

| Candidate and shape | Published plan/rate | Approximate monthly compute at that projected volume |
| --- | --- | ---: |
| Namespace Team, Linux8vCPU/16GB | $100/month includes100,000 unit-minutes, equivalent to12,500 job-minutes of this shape; additional usage $0.012/job-minute | $233 |
| Ubicloud standard x64,8vCPU/32GB | $0.005/job-minute; published $2.50 monthly account credit | $115 |
| Ubicloud premium x64,8vCPU/32GB | $0.008/job-minute; published $2.50 monthly account credit; premium is default for new users | $186 |

Sources: [Namespace pricing](https://namespace.so/pricing.md), [Ubicloud pricing](https://www.ubicloud.com/docs/about/pricing.md). USD, before tax, vendor rounding/startup differences and optional cache/storage. No speedup is assumed. Parallelization can lower elapsed workflow time without lowering summed job-minutes; repeated job setup can increase them. Do not multiply only the longest shard's time by run count to estimate spending.

Namespace also advertises a **Developer plan with no monthly commitment**. This is the preferred small-pilot starting point rather than prepaying Team, but its published table does not explicitly map Developer usage to the prepaid or overage rate. Budgeting at the overage rate gives an **unverified estimate** of $0.012/job-minute for8vCPU/16GB; confirm the actual billing rate before purchase. Namespace charges this shape8 units/minute, but8vCPU/32GB costs16 units/minute: extra memory is not free.

Ubicloud's current docs permit disabling premium; an older announcement said standard was closed to new customers, superseded by an August changelog. Confirm console availability before relying on the standard rate. Its source registers repository-level runners, suggesting personal-account compatibility, but no account installation or job verified that inference. The advertised free credit is per account, not per runner.

Defer a paid pilot: the recorded native PR/main runs already met the feedback target. If later measurements justify another runner, propose a **$25 total bounded pilot** using selected trusted runs without production/provider credentials. That is a proposed budget, not a guaranteed vendor-enforced cap; neither vendor's researched docs established a dollar hard stop. Verify billing, permissions and stop controls before enabling. Full-volume ongoing spend needs a separate decision. No signup, GitHub App installation, runner trial or spending occurred.

## Faster local loops using the existing stack

1. **Focused checks during edits.** Use the implemented web watch command documented in the [design system](workspace-design-system.md#enforcement-during-implementation), selecting one relevant test file. [`--changed` and `related`](https://vitest.dev/guide/cli) remain optional feedback shortcuts, not replacements for broad acceptance: dynamic fixtures and cross-package contracts can escape static selection.
2. **Incremental static feedback.** The web incremental/no-emit watcher checks source, tests and scripts; content-cached lint and per-worktree buildinfo use ignored `node_modules/.cache`. Commands and actual acceptance are in the design system. Keep final gates cold. LSP symbol navigation also needs the locked TypeScript SDK in the harness workspace; a neighboring worktree's installation alone did not satisfy discovery. Installing locked dependencies with lifecycle scripts held restored it without changing harness settings or tracked source.
3. **Fast presentation loop.** The actual shared-module `dev:patterns` gallery now uses [esbuild watch/rebuild](https://esbuild.github.io/api/#rebuild), successful-output reload and last-good preservation. Process-unique HTML/SSE markers detect server restarts at the same build ordinal. Real Chrome acceptance covered CSS/TSX changes, failure/recovery and offline-edit/restart; temporary changes were restored. This remains a development-only gallery without product connections.
4. **Real authenticated browser loop.** [Foreground opt-in rebuild](../../apps/web/scripts/localdemo.md#opt-in-frontend-rebuild-without-restarting-plain-foreground-only) reuses the finite exact-owned runtime. Explicit `r` builds validated frontend assets and replaces only the product handler on the same HTTPS listener; it never reloads Chrome. Actual signed acceptance covered dirty-note/page preservation, busy refusal, failed-build last-good bytes, recovery, manual reload/authentication and saved-note readback; all four pre-resource refusals and exact teardown passed. Preserve the existing lifetime, CSRF/CSP, `app_runtime`, fake providers and no-send checks. Reload discards memory-only scratch; do it deliberately, never on every file save.
5. **Cold acceptance remains distinct.** Run the affected signed-browser journey with a clean disposable database and browser context before merge/release. Reusing a dev session must not become acceptance evidence for clean startup, reload, sign-out or unknown-write recovery.

Do not start with a Vite/HMR migration. esbuild rebuild plus reload is the smaller change. Stateful hot refresh can preserve or recreate React state/effects that differ from production reload and call-custody behavior. Do not relax product CSP/authentication to make development work. Do not blanket-enable multiple browser workers through the existing exclusive owned-lane guards.

## Current implementation and success criteria

Native parallel CI, focused watch/incremental checks and gallery rebuild are implemented; the exact-owned authenticated rebuild seam has runtime proof and combined/privacy review. Monitor the longest actual suite before adding sharding or another platform; do not assume Domain is always the bottleneck.

The target remains required PR feedback around or below ten minutes over representative PRs and broad-main runs. The recorded native-parallel PR/main observations met it; they do not establish a median, tail or reliability guarantee. Continue comparing queue/setup, aggregate job minutes, failures and unchanged coverage. Migration-heavy runs may have an independent critical path.

Do not switch package managers to optimize this run's seven-second install. Do not purchase a CI platform or cache integration-test success to obtain a green timing number. No decision or credentials are needed from David for the current recommendation; a paid pilot would require approval.
