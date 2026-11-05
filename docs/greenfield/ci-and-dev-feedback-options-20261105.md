# CI and development feedback: measured bottlenecks and options

November 5, 2026. Recommendation, not tooling adoption. No workflow, compiler, package manager, paid runner, account or production control was changed for this research. The main model retains screen-design ownership.

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

[`run-selected.mjs`](../../tools/ci/run-selected.mjs) uses synchronous child processes: shared typecheck, lint, then a serial loop over suites. It already records per-command times in the GitHub summary. [`select.mjs`](../../tools/ci/select.mjs) already chooses affected suites/dependent consumers for PRs and broad coverage on main. Neither mechanism should be replaced by a weaker changed-file heuristic.

The measured critical-path opportunity is overlapping independent work, not shaving dependency-install seconds. Image workflows run separately; container-build acceleration does not directly shorten this test step. This Greenfield step invokes Vitest/Node tests, not the Playwright spec runner.

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

Recommendation: after the free native-parallel benchmark, request a **$25 total bounded pilot**, using only explicitly selected trusted runs and no production/provider credentials. This is a proposed budget, not a guaranteed vendor-enforced cap; neither vendor's researched docs established a dollar hard stop. Verify billing, permissions and stop controls before enabling. Full-volume ongoing spend is a separate decision, not included in that pilot budget. No signup, GitHub App installation, runner trial or spending occurred.

## Faster local loops using the existing stack

1. **Focused checks during edits.** Use one relevant Vitest file/test in watch mode or `related` for static import relationships; check the touched workspace rather than invoking the entire nine-program typecheck chain after each edit. [`--changed` and `related`](https://vitest.dev/guide/cli) are feedback shortcuts, not replacements for broad acceptance: dynamic fixtures and cross-package contracts can escape static selection.
2. **Incremental static feedback.** Evaluate [TypeScript incremental/no-emit checking](https://www.typescriptlang.org/tsconfig/#incremental) with per-worktree buildinfo under ignored `node_modules/.cache`, plus [ESLint's content-based cache](https://eslint.org/docs/latest/use/command-line-interface#--cache-strategy). Keep final gates cold. **LSP discovery restored:** the harness's original workspace lacked the TypeScript SDK installed in the implementation sibling. Installing its locked dependencies with lifecycle scripts held restored symbol navigation; the active implementation's `WorkspaceSection` reference query returned16 correct source locations. No harness settings or tracked source were changed for that repair.
3. **Fast presentation loop.** Reuse the actual shared-module `dev:patterns` gallery, not another mock product or new component platform. Add [esbuild rebuild/watch](https://esbuild.github.io/api/#rebuild) and reload support. The current gallery builds once; watch/reload has not been implemented.
4. **Real authenticated browser loop.** Reuse the existing finite, exact-owned synthetic session for edits instead of restarting Postgres, migrations, TLS, OIDC and Chrome each time. Dev-only asset rebuild/reload support is required: the host captures assets at construction. Preserve the current lifetime limits, real sign-in/CSRF/CSP and `app_runtime` role, fake providers, no-send assertions and exact teardown. A listener/runtime reuse mechanism needs smoke proof before adoption. Reload must respect unsaved-work and calling custody; do not silently discard it on every file save.
5. **Cold acceptance remains distinct.** Run the affected signed-browser journey with a clean disposable database and browser context before merge/release. Reusing a dev session must not become acceptance evidence for clean startup, reload, sign-out or unknown-write recovery.

Do not start with a Vite/HMR migration. esbuild rebuild plus reload is the smaller change. Stateful hot refresh can preserve or recreate React state/effects that differ from production reload and call-custody behavior. Do not relax product CSP/authentication to make development work. Do not blanket-enable multiple browser workers through the existing exclusive owned-lane guards.

## Proposed order and success criteria

First, split independent CI suites while preserving existing check names/coverage through an aggregate gate. Then measure whether Domain needs sharding. In parallel, add focused watch/incremental local checks and gallery rebuild support; prove any owned authenticated reload seam separately.

The target remains a required PR feedback path around or below ten minutes, evaluated over representative PRs and broad-main runs. Package-level parallelism makes that plausible from this run's longest suite, but this is an inference, not an achieved benchmark. Compare median/tail wall time, queue/setup, job minutes, failures and coverage before/after. Migration-heavy runs may have an independent critical path.

Do not switch package managers to optimize this run's seven-second install. Do not purchase a CI platform or cache integration-test success to obtain a green timing number. No decision or credentials are needed from David for the current recommendation; a paid pilot would require approval.
