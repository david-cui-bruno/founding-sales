# The rehearsal database URL is derived in the job, not stored as a secret

**Lane:** G12c · **Spec:** 16.2, 4.1 · **Files:** `.github/workflows/greenfield-release.yml`, `infra/modules/{database,stack}/outputs.tf`, `infra/roots/rehearsal/outputs.tf`, `docs/greenfield/release.md` 1.3

## What was asked for and why it cannot be a secret

`release.md` 1.3 listed `FSS_REHEARSAL_DATABASE_URL` as a `rehearsal` environment
secret: *"the rehearsal database URL the suite runs against"*. There is no value it
could hold.

The database the Appendix G suite runs against is created by that run's own
`terraform apply`, four steps earlier in the same job, with a hostname derived from the
run prefix; and it is destroyed at teardown, which runs `if: always()`. A stored URL
would name either a database that no longer exists — every run after the first — or,
worse, one that does, which would mean a rehearsal was reusing data from a previous
run and Appendix G 11's restore drill was measuring the wrong thing.

The password cannot be stored either, and not because of policy. RDS generates it,
stores it in its own Secrets Manager secret encrypted with the stack's customer key,
and rotates it (`manage_master_user_password = true`). Terraform never sees it; it is
not in state. There is nothing for a human to copy into a GitHub secret except a value
that will stop being correct.

## The decision

The secret is **removed**, and the URL is assembled inside the job from three things
the run's own root already knows:

| Part | Source |
|---|---|
| host and port | `terraform output -raw database_endpoint` |
| database name | `terraform output -raw database_name` — added by this lane |
| username and password | `aws secretsmanager get-secret-value` on `terraform output -raw database_master_secret_arn`, read with the rehearsal role |

assembled by a short `python3` block that URL-encodes both halves of the credential
(`urllib.parse.quote`, `safe=""`, because a generated password can contain `@`, `/`
and `:` and a naively concatenated URL would parse as a different host), and handed to
the suite as `FSS_TEST_POSTGRES_URL` through `$GITHUB_ENV`.

### What keeps it out of the log

* Both the password and the finished URL go through `::add-mask::` **before** the URL
  reaches `$GITHUB_ENV`, so any later step that prints it prints `***`. The password is
  masked separately as well as the URL, because a step that logged only the credential
  — a `psql` error, say — would not be covered by masking the whole string.
* Nothing is echoed. The one progress line names the database and the **host**, which
  is public and already in the plan, and nothing else.
* The secret is read once, in one step, by the role that created it. `fss-rh-deploy` is
  scoped to `fss-rh-*`, so this step could not read a production credential if it tried.

### Why not a temporary IAM database authentication token instead

That would remove the password read entirely, which is better. It needs
`iam_database_authentication_enabled` on the instance, a database role created with
`rds_iam`, and a token minted per connection with a fifteen-minute lifetime — three
changes to a module and a migration, in a lane whose job is to unblock the first
release. Recorded here as the thing to do next, not as something rejected.

## What this could not verify

Nothing has been applied. Unverified on the first real run:

1. Whether the RDS-managed master secret's JSON really carries `username` and
   `password` and no other required field. It is documented to; the step will fail
   loudly with a `KeyError` if not, which is the right failure.
2. Whether `fss-rh-deploy` has `secretsmanager:GetSecretValue` **and** `kms:Decrypt` on
   the database key for the managed secret. The role is scoped by name prefix and the
   secret RDS creates is named `rds!db-...`, which does **not** begin `fss-rh-`. This is
   the most likely first-run failure in this lane's work: the policy may need a
   statement allowing `GetSecretValue` on the ARN the root outputs. Noted in the runbook
   too.
3. Whether the suite needs a superuser or the migration role. It connects as the master
   user here, which is the widest option and the one that cannot fail for a privilege
   reason; narrowing it is a later change.
