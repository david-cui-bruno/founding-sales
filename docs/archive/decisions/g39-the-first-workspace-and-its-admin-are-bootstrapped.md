# The first workspace and its admin are bootstrapped, and the first sign-in adopts the row

**Lane:** g39 · **Date:** 23 September 2026 · **Spec:** 5.1, 5.2, Appendix D · **Evidence:** rehearsal full run 35919040315 at 12b559e7, step 19

## What happened

The eighth full rehearsal passed create, the secret fill, the deploy path and the
schema-range refusals — every one of them for the first time. Step 19, the production
smoke, then failed after ten one-minute attempts: "the rehearsal environment published
no `CanaryCompletionAgeSeconds` datapoint in ten minutes".

Nothing was broken. `apps/worker/src/scheduler/sources.ts` inserts one canary **per
workspace** (`SELECT id FROM workspaces`), and a freshly migrated database has none, so
the scheduler correctly had nothing to do. The `canary_stale` alarm is
`treat_missing_data = "breaching"`, so the environment also sat in ALARM for being
empty.

Underneath that was the gap that matters for production. Three rules, each of which
presupposes the others:

* `apps/api/src/auth/signIn.ts` refuses with `workspace_unknown` unless the `workspaces`
  row exists;
* it refuses with `membership_required` unless an **active** `workspace_memberships` row
  exists for the user;
* the `users` row is created only at the end of a successful sign-in, keyed by
  `google_sub`.

Nothing in `apps/` or `packages/` ever inserted the first of the three:
`grep 'INSERT INTO workspaces'` finds tests and nothing else.
`apps/api/src/routes/admin/memberships.ts` is the way memberships are managed and needs
an authenticated admin, which is precisely the thing that cannot exist yet.
`docs/greenfield/identity.md` stated the requirement and never said who satisfies it
first, and `docs/greenfield/carry-runbook.md` assumes a workspace UUID already exists.
A production release would have deployed cleanly, passed both verifies, and left an API
nobody could sign in to.

## The decision

**One operator command, run once per environment, as a release step.**

`fss admin workspace bootstrap --slug S --display-name N --admin-email E [--time-zone Z]`
(`apps/worker/src/tools/fss/bootstrapWorkspace.ts`) validates every shape before it
sends a statement — the slug against `workspaces_slug_shape`, the address against
`users_email_shape`, the zone against the column's shape and then against `Intl`, which
is the only thing that knows the catalogue — and then, in one transaction:

* selects the workspace by slug and inserts it if absent;
* finds or writes the admin's `users` row;
* ensures an **active `admin`** membership, inserting it or reactivating an inactive
  one;
* writes an `audit_events` row.

It runs under the **runtime** identity, like `fss verify` and unlike `fss migrate`: it
writes business rows, and the runtime credential's privileges on those three tables are
what is in doubt. Its report is the one output, and it names the workspace UUID because
that is what a person types into the desktop's Workspace field. Exit 0, 20 for a
refusal, 21 for a failure.

`infra/scripts/release-bootstrap-workspace.sh` launches it on the operations task
definition through `release_run_task` — the same wrapper, digest comparison, network
plan and log-stream read as every other one-off task. The rehearsal runs it between
step 17 and step 18; production runs the same script with `--environment production`,
which is the one argument the rehearsal does not pass and the one this script requires
that `release-deploy.sh` does not. Writing the first business rows of production is
worth naming out loud.

**`actor_kind` is `system`, not `operator`.** `audit_events_actor_kind_known` (migration
0001) allows exactly `user`, `admin`, `system`, `worker`, and
`audit_events_user_actor_identified` requires a user id for the first two. An operator at
a command line is none of the four, so the event is `system` and the command names itself
in the detail — which carries the three outcomes and the admin's user id, and no e-mail
address, because a detail never carries one.

## The adoption rule, and why it is safe

The real Google `sub` cannot be known before that person signs in: Google mints it, and
nothing outside a signed id token may assert one. So the bootstrap writes
`google_sub = 'pending-email:' || <lowercased address>`, and the **first** successful
sign-in with that address replaces it. One statement, immediately before the existing
`ON CONFLICT (google_sub)` upsert:

```sql
UPDATE users
   SET google_sub = $1, display_name = $3, updated_at = now()
 WHERE google_sub = $4 || $2
   AND NOT EXISTS (SELECT 1 FROM users WHERE google_sub = $1)
```

`$1` is the validated `sub`, `$2` the validated lowercased e-mail, `$3` the validated
display name, `$4` the prefix — bound rather than spliced into the text. When it touches
a row, an `auth.provisional_user_adopted` audit event says so.

Three reasons this is not a way in:

1. **The e-mail is not the caller's.** It comes from an id token whose RS256 signature
   against Google's published keys, issuer, audience, `azp`, nonce, `email_verified` and
   `hd` equal to the configured Workspace domain `validateIdToken`
   (`apps/api/src/auth/idToken.ts`) has already enforced. Nothing an unauthenticated
   request says reaches the statement.
2. **A provisional row exists only because an operator wrote one.** The only thing that
   writes the sentinel is this tool, run with the runtime database credential — a
   principal that could already write any row in any of these three tables. Adoption
   grants nothing the act of bootstrapping did not already grant.
3. **The sentinel cannot collide with a real identity.** A Google `sub` is a decimal
   string of digits, so no token can carry `pending-email:<address>`. And an address that
   already has a real account is never overwritten: the `NOT EXISTS` guard makes the
   update a no-op, the upsert finds the real row as it always did, and the pending row is
   left for an operator to resolve.

The prefix is **one exported constant**, `PROVISIONAL_GOOGLE_SUB_PREFIX` in
`@fss/contracts` beside the `users` schema, imported by the tool and by the API. Two
copies of it are two facts that can disagree, and the disagreement is a workspace whose
admin can never sign in, with nothing anywhere saying so.

## What this does not change

**Memberships are still checked on every command.** Adoption changes which `users` row a
sign-in finds. It does not decide access: the membership check runs after it at the
callback, again at the claim, and again on every authenticated command (5.1). A
provisional row with no membership authenticates nobody, and nothing can present an id
token for one.

**An operator with the runtime credential could already write any of these rows.** This
command is not a new privilege. It is the same three inserts, in one transaction, with
the shapes validated first, the outcomes reported, and an audit row — instead of three
`psql` statements typed at three in the morning with the slug misspelt.

**The last-active-admin rule still holds.** `workspace_memberships_last_active_admin`
refuses any update that would leave a workspace with no active admin, so the membership
this command reactivates was always deactivated while somebody else held the role.

**Nothing creates a second workspace.** The command selects by slug, and the slug is
unique. A re-run reports `existing`, `provisional_existing`, `existing` and writes no
row. If two `users` rows carry the admin address with real subs, it refuses
(`admin_email_ambiguous`) and rolls back rather than picking one.

**The rehearsal's admin never signs in.** It writes `rehearsal-admin@usecallie.com` as a
provisional row and the environment is destroyed at the end of the job. What the
rehearsal proves is the step, the wrapper and the report — the adoption half is proved by
`apps/api/test/auth/identity.test.ts` against a real database.

## What is still unverified

That a production `fss admin workspace bootstrap` clears the `canary_stale` alarm within
the couple of minutes the 60-second scheduler pass and the 60-second metrics publisher
imply. The rehearsal's own smoke step is where that is first measured end to end, and
the failure direction is legible: no datapoint after ten minutes, named as the cause,
exactly as run 35919040315 reported it.
