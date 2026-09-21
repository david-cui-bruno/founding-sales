# Three one-off task definitions, not one (lane G12h, 21 September 2026)

David's decision of 21 September chose Option A — database work runs as one-off ECS
tasks inside the VPC — conditional on, among eleven points, "a distinct migration task
role and task definition" and "the runtime task role has no path to DDL credentials".

The obvious reading is two definitions: one for the migration identity and one for
everything else. This lane shipped three, and the reason is `fss drill`.

## What each command needs

| Command | PostgreSQL as | Suppression journal | DDL |
|---|---|---|---|
| `fss migrate`, `fss admin database-users ensure` | the migration user | no | yes |
| `fss verify` | `app_runtime` | no | no |
| `fss drill` (Appendix E steps 1 to 9) | `app_runtime` | **read** (step 2 replays it) | **yes** (step 7 reapplies migrations forward) |

`fss drill` is the only command that needs the journal and a DDL credential at the same
time. Every way of giving it both from an existing identity breaks one of the two walls:

- **On the migration task definition.** The migration task role would then need
  `s3:GetObject` and `s3:ListBucket` on the journal and `kms:Decrypt` on its key. The
  DDL identity would be able to read every suppression event the system has ever
  recorded, for the sake of a command that runs once per rehearsal.
- **On the operations task definition** (the worker task role). The definition would
  reference `migration-database`, so a task running as the worker's own identity would
  hold a credential that can perform DDL. That is exactly the path David's first
  condition removes, and the fact that the deployment role could have launched the
  migration task anyway is not an answer: the condition is about the *task role*, and
  a boundary that holds only because of who can call `run-task` is a boundary that
  stops holding the day somebody grants `run-task` more widely.

So `fss drill` has its own task role and its own execution role, used by nothing else,
existing in both environments and launched only by a rehearsal.

## What the drill identity does and does not hold

It reads the journal and never writes it. A drill that could append to the suppression
journal could manufacture the evidence step 2 is checked against, which would make the
one step that proves the journal is a recovery prove nothing.

It holds no envelope key. The envelope key unwraps per-mailbox Gmail refresh tokens,
and the drill task definition fixes `FSS_DEPENDENCIES=recorded`, so the three mailbox
commands reach the recorded adapters and there is no real token to unwrap. A key
granted to an identity with nothing to use it on is a grant nobody can justify a year
later.

## Why the dependency mode is in the task definition

`reconcile-sent`, `recover` and `watch-renew` all reach Gmail when dependencies are
`live`. A rehearsal that reached a real mailbox would send real mail. The tool already
refuses to run them in any mode but `recorded` (G12g's `COMMAND_DEPENDENCIES`), and
this is the second lock on the same door: the mode is a property of the definition, so
there is no invocation — not a hand-typed `run-task`, not a retried step, not a future
script — that can ask the drill to run against live Gmail.

## What this costs

One extra task definition and one extra role pair per environment, none of which is
billed until a task runs. `infra/modules/cluster/tests/migration_identity.tftest.hcl`
asserts each boundary from the policy JSON, so a later edit that merged two of them is
a red offline gate rather than a discovery during a restore.
