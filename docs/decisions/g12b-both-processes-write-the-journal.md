# Both task roles append to the suppression journal, and neither can delete

**Lane:** G12b · **Spec:** 10.2, Appendix A, Appendix E 2 · **Files:** `infra/modules/cluster/main.tf`, `infra/modules/journal/{main,variables}.tf`, `infra/modules/stack/main.tf`, both modules' `tests/*.tftest.hcl`

## What was open

G12 reported it twice and could not fix it (`g12-what-the-rehearsal-cannot-prove.md`,
gap 1): `infra/modules/cluster` gave the worker task role `s3:GetObject`,
`s3:ListBucket` and `kms:Decrypt` on the journal — read, which is what Appendix E step
2's replay needs — and no `s3:PutObject` and no `kms:GenerateDataKey`. But the worker's
mail pipeline records prospect opt-outs during sync, and 10.2 requires the journal
write *before* acknowledgement, so the first opt-out a credentialed worker imported
would have been refused by IAM. The command fails closed, which is the right direction,
but it fails on every opt-out — the commonest way a suppression enters the system at
all.

The infrastructure said the opposite in two places, which is why the fix is two files.
`infra/modules/cluster` is an identity-based policy; `infra/modules/journal`'s bucket
policy is resource-based and **deny-first**, with
`DenyWritesFromAnyoneButTheApiTaskRole` naming exactly one writer. An explicit Deny
beats any Allow, so granting the worker `s3:PutObject` in the cluster module alone
would have changed nothing and looked like a fix.

## The decision

`writer_role_name` (one string) becomes `writer_role_names` (a list, refused when
empty), and the stack passes both task role names. The statement is renamed to
`DenyWritesFromAnyoneButTheTaskRoles` and `AllowTheApiTaskRoleToAppendEvents` to
`AllowTheTaskRolesToAppendEvents`, because a Sid that names one principal and permits
two is a comment that lies. The empty-list validation exists because that deny is the
only thing between "the named writers" and "anybody": a list that silently became empty
would open the bucket rather than close it.

### Put, encrypt, and nothing else

| Action | Both roles | Why |
|---|:--:|---|
| `s3:PutObject` on `<bucket>/*` | yes | 10.2's pre-acknowledgement write. Scoped to the object prefix, not `*`. |
| `kms:GenerateDataKey`, `kms:Encrypt` on the journal key | yes | What a put into an SSE-KMS bucket needs. Without `GenerateDataKey` the put fails with an access error that reads as an S3 problem. |
| `kms:Decrypt` on the journal key | yes | Appendix E 2's replay. |
| `s3:DeleteObject`, `s3:DeleteObjectVersion` | never | An append-only journal one of its own writers can erase is not one. |
| `s3:PutObjectRetention`, `s3:PutObjectLegalHold` | never | See below. |
| `s3:BypassGovernanceRetention` | never | It is on `fss-rh-deploy` for same-day teardown and must never be anywhere else (`release.md` 1.2). |

## Why no `s3:PutObjectRetention`, when the brief allowed for it

The brief said to grant it "if the journal uses object lock per object". It does not.
`aws_s3_bucket_object_lock_configuration.journal` sets a **default retention** on the
bucket — GOVERNANCE for 3650 days in production — and S3 applies that to every object
as it is written, with no per-object header from the writer. Both writers confirm this
in code: `loadS3SuppressionJournal` and `loadJournalPutObject` send `Bucket`, `Key`,
`Body`, `ContentType` and `IfNoneMatch` and nothing else.

More than unnecessary, it would be wrong. The bucket policy already denies
`s3:PutObjectRetention` to every principal, because a writer that could set a retention
could set a *shorter* one, and the whole point of the lock is that the retention is not
the writer's to choose. Granting it in the task role would be a permission with nothing
behind it and an invitation to somebody later to remove the deny so that the grant
"works". The cluster test asserts the absence rather than leaving it to be noticed.

## What is proved and what is not

Proved offline: both role policies contain exactly one `s3:PutObject` statement, scoped
to the journal object prefix; neither contains any `s3:Delete*`, retention or bypass
action; both carry `GenerateDataKey` and `Encrypt` on the journal key ARN and no other;
the bucket policy names both roles as writers in both their role and assumed-role forms
and still denies every other principal.

Not proved: that a real put succeeds. That needs a credential and a bucket, and the
first opt-out the worker imports in production is where it is settled. A remaining IAM
refusal surfaces as `suppression_journal_write_failed` and the immediately-critical
`SuppressionJournalWriteFailures` metric, which is named in `release.md` section 8 as
the thing to watch when Gmail sync is first enabled.

## Ownership

`infra/modules/journal` is not in this lane's ownership list; `infra/modules/cluster`
is. Changing only the cluster module would have produced a worker that still could not
write, with a test asserting it could — a worse state than the one G12 reported.
The journal change is minimal (one variable's type, two Sids, the principal lists) and
is reported here rather than made quietly.
