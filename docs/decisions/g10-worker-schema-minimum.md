# G10: the worker's schema minimum moves to 5, and what that gives up

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 4.2, 13.2, Appendix G 22

## The change

`packages/domain/db/schemaRange.ts`:

```
API_SCHEMA_RANGE     { minimum: 4, maximum: 4 }  →  { minimum: 5, maximum: 5 }
WORKER_SCHEMA_RANGE  { minimum: 2, maximum: 4 }  →  { minimum: 5, maximum: 5 }
```

The API's minimum moves for the same reason it moved from 3 to 4: its routes read
tables the migration creates — `research_settings`, `research_providers`,
`research_route_policies` and `research_suggestions` — and a binary that needs a column
should say so at startup rather than fail on its first statement.

The worker's minimum is the interesting one, because it was 2, and G5's comment says
why: *"The worker reads none of those tables yet, so its minimum is still 2, which is
what lets a rolling deployment run an old worker beside a new API (Appendix G 22)."*

## Why the worker's minimum has to move

Appendix C gives both research kinds `business_uniqueness`, and that protection is not
a property of the handler — it is a property of two unique constraints that migration
0005 creates:

```
research_pages_one_per_result       UNIQUE (workspace_id, query_hash, page_hash)
research_firm_runs_one_per_revision UNIQUE (workspace_id, firm_id, revision)
```

A worker on a version-4 database has the handlers and not the constraints. Under a
stolen lease it would run a discovery page twice and create the firms twice, because
nothing would refuse the second page row. That is the exact failure the schema range
exists to prevent, and it is worse than refusing to start: a duplicate firm is a
prospect contacted twice by two salespeople.

The runner would also fail on the first statement, which is the cheaper failure — but
"it would crash anyway" is not a reason to let a binary start. A refusal at startup
names the reason in one log line and exits with `WORKER_EXIT_CODES.schemaOutOfRange`;
a crash on the first claim burns an attempt per job and buries the cause in a handler
error.

## What is given up

Appendix G 22 — "old API with new worker and reverse across every expand/contract phase
obey schema ranges" — is still satisfiable, but the *specific* overlap G5 preserved is
not: a version-2 worker can no longer run beside a version-5 API.

That overlap was never a promise to a running system. Nothing has been deployed, and
G5's own comment says the same thing about `PREVIOUS_RELEASE_SCHEMA_RANGE`: the honesty
of these constants begins at the first real deployment.

From that deployment onwards the ordering in `docs/greenfield/migrations.md` applies
without exception, and the consequence of a narrow worker range is real: the worker has
to be deployed *after* the migration, not before. `PREVIOUS_RELEASE_SCHEMA_RANGE` is
widened to `{1, 5}` in this change, which is what makes the next migration's deployment
legal; the compatibility test in `test/db/migrations.test.ts` is the gate that keeps
saying so.

## The alternative that was rejected

Keep `WORKER_SCHEMA_RANGE.minimum` at 2 and have the research handlers check for their
tables at registration. That trades a loud refusal for a quiet degradation: a worker
that silently declines to claim `research.page` looks identical to a worker with no
providers configured, and the operator's first symptom is a queue that never drains.
The range is the mechanism the specification names for exactly this, and using it is
cheaper than inventing a second one.
