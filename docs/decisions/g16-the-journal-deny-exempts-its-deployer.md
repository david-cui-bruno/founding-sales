# The suppression journal's denies exempt the principal that created it, when the root says so

**Lane:** G16 · **Date:** 21 September 2026 · **Spec:** 10.2, Appendix E step 2 · **Evidence:** Actions run 35628963637

## What happened

David's fourth credentialed rehearsal applied a whole environment and then could not
remove it. The teardown failed with

```
S3 DeleteBucketPolicy … 403 AccessDenied because of an explicit deny in the resource-based policy
```

and the same for `PutBucketObjectLockConfiguration`. The residue was the bucket
`fss-rh-202609211659-suppression-journal-326255650484` with its policy, its object lock
(GOVERNANCE, one day), its versioning and its public-access block, plus one state object
`fss/greenfield/rehearsal/fss-rh-202609211659/terraform.tfstate` holding those four
resources.

The deny was ours. `infra/modules/journal`'s `DenyAnyDeletionOrLockWeakening` names
`Principal { AWS = ["*"] }` with no condition and lists `s3:BypassGovernanceRetention`
among its actions, so **no principal but the account root could ever tear the bucket
down** — and the rehearsal teardown script's own `--bypass-governance-retention`
emptying step could never have worked either. Both of those had been written, reviewed
and tested offline, because every offline test asked whether the deny was *there* and
none asked who it applied to.

## The decision

A new journal variable, `administrative_principal_arns` (list of IAM role ARNs, default
`[]`). When it is non-empty, every `Deny` in the bucket policy **except**
`DenyUnencryptedTransport` gains

```hcl
Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.administrative_principal_arns } }
```

merged into whatever condition that statement already had. The rehearsal root passes
`arn:aws:iam::<account>:role/<deployment_role_name>` — a literal, not a variable, because
there is no value a caller should be able to pass that makes a rehearsal journal
un-removable or that exempts somebody else. The production root passes `[]` and takes
`journal_administrative_principal_arns` so that David can opt in with one `-var` and a
line in a plan he reads.

Four things about the shape, each of which was a choice:

**Merged, never replaced.** Conditions inside one statement are conjunctive, so
`DenyWritesFromAnyoneButTheTaskRoles` carrying both `ArnNotLike` (not a writer) and
`ArnNotEquals` (not an administrator) fires only for a principal that is neither.
Replacing the condition would have opened the journal to writes from everything that is
not the deployer.

**The condition key is omitted, not emptied.** With the list empty the module emits no
`Condition` key on the deletion deny at all. `"Condition": {}` is a statement that claims
a condition and has none, and a person reading a production bucket policy should see no
exemption rather than an empty one.

**The transport deny keeps applying to everyone.** A teardown reaches S3 over TLS like
everything else; an exemption there would be a hole with no use.

**Role ARNs, and exact ones.** `aws:PrincipalArn` carries the **role** ARN for an
assumed-role session, not the session ARN, which is why the condition can be
`ArnNotEquals` on one exact string rather than a pattern. (The writer denies next to it
list both forms under `ArnNotLike` — that is a hedge from an earlier lane, not a
requirement.) Variable validation refuses a wildcard and a bare role name: a pattern here
would either exempt every role in the account or, under `ArnNotEquals`, compare literally
and exempt nobody, and neither is what a caller typing one would mean.

## What this is not

**It is not permission to empty a production journal.** Two things have to be true for
that: the bucket policy has to let the principal through, and the principal's own policy
has to allow the action. `infra/policies/deployment-role-policy.json.tftpl` denies
`s3:BypassGovernanceRetention` and `s3:GetObject*` to `fss-prod-deploy` outright, so
naming that role in this variable is necessary and not sufficient. Both halves would have
to change, in two files, in one pull request, and the release suite asserts the production
half.

**It is not a way for the rehearsal deployer to read suppression events.** The exemption
covers `DenyReadsFromAnyoneButTheTaskRoles` — it has to, because the teardown's
`s3api list-object-versions` is a `ListBucketVersions` — but `fss-rh-deploy` is separately
denied `s3:GetObject*` everywhere except its own Terraform state keys. It can enumerate
the journal's versions and delete them; it cannot read one.

## What `force_destroy` and the one-day retention actually buy

Three things have to hold for `terraform destroy` to remove a journal bucket that holds
objects still inside their retention:

1. **`force_destroy = var.destroyable`**, or Terraform refuses to delete a non-empty
   bucket at all and the policy is never consulted.
2. **The bucket policy lets the principal delete**, which is this decision.
3. **`s3:BypassGovernanceRetention` is allowed to the principal by IAM**, which is
   `BypassGovernanceOnRehearsalBucketsOnly` in the rehearsal document and denied in the
   production one.

All three, and only for GOVERNANCE. In COMPLIANCE mode nothing above helps: a compliance
lock cannot be bypassed by any principal including the account root, which is why the
production journal's mode is a variable David can raise and the rehearsal's is a literal
`GOVERNANCE`.

What the rehearsal's one-day retention means for a run that wrote journal objects: those
objects refuse deletion until the day passes **unless** the bypass is used, and a
rehearsal is same-day by construction, so the bypass is the normal path rather than the
exception. `infra/scripts/rehearsal-teardown.sh` step 3 already does it — it lists every
version and every delete marker and deletes them in batches with
`--bypass-governance-retention` — and until this change the bucket policy was refusing
that step as well as the two the teardown reported. A run that created the bucket and
wrote nothing to it was still stuck, because `DeleteBucketPolicy` and
`PutBucketObjectLockConfiguration` are denied whether the bucket is empty or not.

## The orphan

`fss-rh-202609211659` is still standing, and its bucket carries the **old** policy — S3
evaluates the policy on the bucket, not the one in the repository.

What makes it recoverable is that `s3:PutBucketPolicy` is not in the deny list. The deny
covers deletion and lock weakening; replacing the policy is not either. And a bucket
policy's `Deny` on `Principal *` applies to every principal in the account including
David's admin user — what it cannot deny is the account **root** — so `put-bucket-policy`
from his own credentials is enough, and no root session is needed.

That run never reached its deploy stage, so the bucket holds no objects at all: the
one-day GOVERNANCE lock is locking nothing and no bypass-governance is involved.
`docs/greenfield/release.md` 3.0 has the exact command and the `stage = teardown`
dispatch that follows it, and names the alternative — a `create` run at a commit carrying
this change, which also works and creates a whole Multi-AZ environment to fix one bucket
policy.

Every run after this one applies the fixed policy from the start and needs only the
teardown.

## What is still unverified

Nothing here has been applied. Specifically:

- that `aws:PrincipalArn` in an S3 bucket policy resolves to the role ARN for a session
  of `fss-rh-deploy` rather than to `arn:aws:sts::…:assumed-role/fss-rh-deploy/<session>`.
  It is documented and it is the basis of the `ArnNotEquals`. If it were the session ARN
  the exemption would not match, the deny would fire, and the teardown would fail closed
  with the bucket preserved — which is the safe direction and the same symptom as before,
  so it is legible;
- that a `Deny` with both `ArnNotLike` and `ArnNotEquals` on the same key behaves
  conjunctively in S3's evaluation. Also documented, also fails closed;
- that `s3:PutBucketPolicy` really is absent from the old deny's action list, which is
  what makes the orphan recoverable at all. Read off the policy in `main.tf` and off the
  bucket by `aws s3api get-bucket-policy`, which is the first thing to do before the
  teardown stage is dispatched for that run.
