# The rehearsal fills its own two database entries (lane G12h)

`infra/modules/secrets` creates every Secrets Manager entry **empty** and Terraform
never holds a value: "Terraform creates the container; a human puts the value in once,
following `docs/greenfield/infra-apply-runbook.md`." That rule is why nothing secret
is in the repository, in a plan or in state, and it is not being changed.

G12h adds two entries — `<prefix>/migration-database` and
`<prefix>/app-runtime-database` — and they are different from the other six in one
respect: **a rehearsal cannot start without them.** The six application secrets can be
empty in a rehearsal, because the rehearsal runs with recorded dependencies and
nothing resolves them. These two carry the credentials the migration task and the two
services connect with, and an empty one is two services that never start.

A rehearsal is unattended. Nobody is going to paste a value into an environment that
exists for an hour and is destroyed at the end of the job.

## What the rehearsal does instead

One workflow step, after the apply and before the deploy:

- `migration-database` gets the **RDS-managed master credentials**, copied from the
  entry RDS manages into the entry the migration task reads. On a database that has
  never been migrated there is no other login role that can run DDL — migration 0001
  creates `app_runtime` and `migration` as `NOLOGIN` **group** roles, and `fss migrate`
  is the command that creates them — so the master is the only credential that exists.
- `app-runtime-database` gets a password generated in the runner
  (`openssl rand -base64 48`) and nowhere else, in the JSON shape the other database
  secrets use. `fss admin database-users ensure`, on the migration task, creates the
  login user it names as a member of `app_runtime`.

Both values are masked with `::add-mask::` before they can reach a log, neither is
echoed, and both are written by `put-secret-value --secret-string` from a value the
step already holds rather than from an argument assembled elsewhere.

## What it costs, and what it does not

It costs one grant on David's side: `secretsmanager:PutSecretValue` on `fss-rh-*`
secrets, on `fss-rh-deploy` only. That role is already scoped to the `fss-rh-`
namespace by an IAM condition, so the grant cannot reach a production entry, and
`release.md` 8.1 names it as the next thing likely to be refused on a real run.

It does **not** change production. David fills both entries by hand from stdin
(`release.md` 5.1, `infra-apply-runbook.md` 3.3), exactly as he fills the other six,
and the production deployment role holds no `PutSecretValue` at all.

## Why this is a real difference and is written down as one

A rehearsal is supposed to be a smaller copy of production, and here it is not: in
production a person chose the runtime password and in a rehearsal a runner did. The
difference is in the *provenance* of a value, not in the shape of anything the
deployment reads — the same two entries, resolved by the same two execution roles,
through the same references. What a rehearsal proves about this path is that the
entries are reachable by the right identities and unreachable by the wrong ones, and
that `database-users ensure` creates the user. What it cannot prove is that David
pasted the right thing, and no rehearsal ever could.
