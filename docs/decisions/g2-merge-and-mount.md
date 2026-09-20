# G2: what the coordinator has to do when G5 and G2 meet

Lanes G2 and G5 branched from the same main and both added a migration. `main` had not
moved when G2 finished, so G2 could not do the merge itself. This is the whole of what
is left, written out so it is mechanical.

## 1. Migration 0002

Delete `packages/domain/db/migrations/0002_reserved_for_jobs_lane.sql` and keep G5's
real `0002`. The placeholder exists only so that G2's branch could run its own gate:
`loadMigrations` refuses a gap between 0001 and 0003, and that guard is correct and
stays.

Nothing outside the migrations directory names migration 0002, so there is nothing
else to change. No long-lived database ever applied the placeholder — greenfield test
databases are created and dropped per run, and no production database exists — so the
checksum it would have recorded is not a problem anywhere.

## 2. `packages/domain/db/schemaRange.ts`

Both lanes edited the same four lines. The resolved values:

```ts
export const CURRENT_SCHEMA_VERSION = 3;
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 3 };
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 3 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 3 };
```

A maximum of 3 accepts 2 as well, so there is nothing to add for G5. Keep G2's comment
explaining why the widening is in the same pull request as the migration — it is only
allowed because no release has shipped.

One test asserts the range: `apps/api/test/api.test.ts` expects
`declaredRange: { minimum: 1, maximum: 3 }` and `databaseVersion: 3`. If G5 changed the
same assertion to 2, take 3.

## 3. `packages/domain/db/lookupKeys.ts`

Both lanes appended entries. G2's are at the end of `FOUNDATION_LOOKUP_KEYS`
(`sessions`, `device_refresh_credentials`) and it also added a second key tuple to
`command_receipts`. Take both lanes' additions; they touch different keys.

## 4. `packages/domain/test/db/constraints.test.ts`

G2 moved its cases into their own file (`support/identityCases.ts`) and appended one
spread at the end of the `cases` array, precisely so this merge would not be a fight in
the middle of a thousand-line literal. If G5 did the same, both spreads go in. If G5
edited the array inline, keep both.

## 5. tsconfig and vitest aliases

G5 adds `@fss/domain/jobs` alias lines to `apps/api` and `apps/worker`. G2 did not
touch those two files, so this should not conflict; if it does, it is adjacent-line and
both sides are additive.

`apps/desktop` is new and needs no jobs alias: the Mac never sees a job.

## 6. Mounting `routeAdminJobs`

G5 left the route implemented, tested and unmounted, because mounting it needs G2's
verified principal. G2's dispatcher takes modules of the shape
`(request, options) => Promise<RouteResult | null>`, and `routeAdminJobs` has its own
shape, so the mount is an adapter rather than a name in the list.

In `apps/api/src/server.ts`, add the imports:

```ts
import { ADMIN_JOBS_PATHS, routeAdminJobs } from './routes/admin/jobs.ts';
import { authenticate } from './auth/index.ts';
```

and, inside `dispatch`, immediately before the `for (const module of […])` loop:

```ts
  // G5's admin job and alert routes. They take a verified principal rather than a
  // request, so authentication happens here and a non-admin arrives as `null` — which
  // those routes refuse. The domain commands check `isAdminScope` again, so this is
  // the first of two gates rather than the only one.
  if (routing.auth !== undefined && (ADMIN_JOBS_PATHS as readonly string[]).includes(request.path)) {
    const outcome = await authenticate(routing.auth, request.headers['authorization']);
    const principal = outcome.authenticated && outcome.principal.role === 'admin' ? outcome.principal : null;
    const answer = await routeAdminJobs({
      method: request.method,
      path: request.path,
      principal,
      body: request.body as Readonly<Record<string, unknown>> | undefined,
      db: routing.auth.db,
    });
    if (answer !== null) return answer;
  }
```

`AuthenticatedPrincipal` has every field of `VerifiedPrincipal` and one more
(`sessionId`), so it is assignable and no conversion is needed.

Two things to notice about that adapter:

* **A non-admin arrives as `null`, not as a principal.** G5's routes refuse a null
  principal with a redacted `unauthenticated`, which is deliberately the same answer a
  stranger gets: an admin-only endpoint must not tell a salesperson it exists.
* **The paths are taken from `ADMIN_JOBS_PATHS`** rather than a prefix match, so a
  future `/admin/jobs/anything-else` is `not_found` from the dispatcher rather than
  silently falling into G5's module.

A test worth adding with the mount: a salesperson's session gets 403 on each of the
four paths, and no session gets 401 — the shape `identity.test.ts` already uses for
`/admin/memberships` and `/admin/devices`.
