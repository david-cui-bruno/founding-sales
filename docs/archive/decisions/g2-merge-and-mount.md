# G2: how G5 and G2 were merged, and how the jobs route is mounted

Lanes G2 and G5 branched from the same main and both added a migration. G5 landed
first (PR 130); this note records how G2 merged onto it, because every one of these
was a choice rather than a transcription.

## Migration numbering

G2's branch carried a placeholder `0002_reserved_for_jobs_lane.sql` so that its own
gate could run: `loadMigrations` refuses a gap between 0001 and 0003, and that guard is
correct and stays. The merge deleted the placeholder and kept G5's real `0002_jobs.sql`.
No long-lived database ever applied the placeholder — greenfield test databases are
created and dropped per run, and no production database exists — so the checksum it
would have recorded is nowhere.

## Schema ranges

```ts
CURRENT_SCHEMA_VERSION         = 3
PREVIOUS_RELEASE_SCHEMA_RANGE  = { minimum: 1, maximum: 3 }
API_SCHEMA_RANGE               = { minimum: 3, maximum: 3 }
WORKER_SCHEMA_RANGE            = { minimum: 2, maximum: 3 }
```

The previous release's range takes the union, which is just `{1, 3}`. That widening
sits in the same pull request as the migration it covers, which is only honest because
nothing has been deployed; `docs/archive/decisions/g5-schema-range.md` makes the same point and
both notes say so.

The service ranges are not the union, and this is the part worth reading twice. G5's
rule is that "a binary that needs a column states so rather than starting and failing
on the first statement", and applying it to each service separately gives two different
answers:

* **The API needs 0002 and 0003.** It reads `dead_at` and `requeued_count` for the
  dead-job list, and no session, device credential or authorization request exists
  before 0003 — an API on a version-2 database could not authenticate anybody. Minimum
  3.
* **The worker needs 0002 only.** It writes `fencing_token`; it reads none of the
  identity tables. Minimum 2.

That difference is the point rather than an untidiness. Appendix G 22 asks that "old
API with new worker and reverse across every expand/contract phase obey schema ranges",
and a worker that still accepts 2 is exactly what lets a rolling deployment put a new
API beside an old worker without the worker refusing to start.

## The other three conflicts

* `lookupKeys.ts` — both lanes appended; both appends kept. G5's `canary_runs` and
  `critical_alerts`, G2's `sessions` and `device_refresh_credentials`.
* `constraints.test.ts` — both appended to the `cases` array. G5's cases are inline;
  G2's are a spread of `support/identityCases.ts`, which is why the merge was a
  two-line resolution rather than an argument in the middle of a 1,300-line literal.
  Later lanes should use the separate file.
* The two service tests assert the ranges above.

## Mounting `routeAdminJobs`

G5 left the route implemented, tested and unmounted because mounting it needs a
verified principal, which is G2's work. G2's dispatcher takes modules shaped
`(request, options) => Promise<RouteResult | null>` and `routeAdminJobs` has its own
shape, so the mount is a short adapter in `dispatch`, before the module loop.

Two things about it that are decisions:

**A salesperson's principal is passed through rather than flattened to `null`.** G5's
module answers 401 for a null principal and 403 for a non-admin, and both bodies are
the same redacted sentence — so the distinction is visible to an operator reading
status codes without telling a salesperson which endpoints exist. Flattening would have
thrown that away for nothing. `identity.test.ts` asserts both statuses and that the two
bodies are identical.

**The paths come from `ADMIN_JOBS_PATHS`, not a prefix match.** A future
`/admin/jobs/something-else` is `not_found` from the dispatcher rather than silently
falling into G5's module and out of its `switch`.

`AuthenticatedPrincipal` has every field of `VerifiedPrincipal` and one more
(`sessionId`), so it is assignable with no conversion. `authenticate` is the only thing
that makes one, so a revoked device or an ended membership never becomes a principal at
all — it arrives as `null` and gets the 401.
