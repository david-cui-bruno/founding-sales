# The suppression journal lets its deployer see the bucket, and read nothing in it

**Lane:** G37 · **Date:** 23 September 2026 · **Spec:** 10.2, Appendix E step 2 · **Evidence:** the first production apply, CloudTrail `CreateBucket` at 17:36:12Z

## What happened

The first production apply created `fss-prod-suppression-journal-<account>`. CloudTrail
names the principal: `arn:aws:sts::…:assumed-role/fss-prod-deploy/fss-prod-terraform`,
17:36:12Z. The next plan proposed to create the same bucket again, and to replace every
resource hanging off it.

The bucket policy is why. `DenyReadsFromAnyoneButTheTaskRoles` denied
`s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucket` and `s3:ListBucketVersions` to
`Principal *` with an exemption only for the principals the root names administratively
— and production names none, by David's decision 4 of 21 September
(`g16-the-journal-deny-exempts-its-deployer.md`). **`HeadBucket` is authorised as
`s3:ListBucket`**, so the role that had just created the bucket could not ask whether it
existed. The AWS provider treats a 403 on `HeadBucket` as "the bucket is gone": it
removed `aws_s3_bucket.journal` from state and planned a create.

Applying that plan is where it cost something. The deletes it attempted against the
bucket it thought was a different one were refused where `DenyAnyDeletionOrLockWeakening`
covered them — the bucket policy and the object-lock configuration both survived — and
went through where nothing covered them: the **server-side-encryption configuration** and
the **ownership controls** were deleted. A deny list protects what it lists.

The same cause explains the rehearsal bucket
`fss-rh-202609211659-suppression-journal-326255650484` left standing on 21 September,
which was created before the rehearsal root passed any exemption at all.

## The decision

The reads deny becomes two statements, and the journal module takes a second variable.

* **`DenyObjectReadsFromAnyoneButTheTaskRoles`** — `s3:GetObject`,
  `s3:GetObjectVersion`, `s3:ListBucketVersions`, on the bucket and its objects, denied to
  every principal that is not a named reader. Unchanged in meaning; `s3:ListBucket` has
  left it.
* **`DenyListingFromAnyoneButTheTaskRolesAndTheDeployer`** — `s3:ListBucket` on the
  bucket ARN alone, because listing is a bucket-level action and
  `arn:aws:s3:::<bucket>/*` is not a resource S3 ever evaluates it against. Denied to
  every principal that is neither a named reader nor a principal in the new
  `bucket_listing_principal_arns`.

Both roots pass `[local.deployment_role_arn]` there, **production included and
unconditionally**. This is not the opt-in `administrative_principal_arns` is: an
environment whose deployer cannot see its own bucket recreates it, and recreating it is
how the encryption configuration and the ownership controls were lost. Naming the role is
the whole of the exemption — it may list keys, and it may read no object, no object
version and no version list.

**One `ArnNotEquals`, not two.** The administrative and listing exemptions are separate
lists and the same condition key, and `merge` of two maps that both carry `ArnNotEquals`
keeps the last and drops the other without saying so. The module combines them first
(`distinct(concat(…))`) and builds one condition from the result, so a rehearsal — which
names the same role in both variables — carries it once.

## What this does not change

**Production still passes no administrative exemption.** Deletion, lock weakening and
writes are denied to `fss-prod-deploy` exactly as before, and tearing the production
journal down stays an act of the account root unless David sets the variable. Decision 4
of 21 September stands.

**Deletion and lock weakening stay denied to everyone.** `DenyAnyDeletionOrLockWeakening`
is untouched, `DenyUnencryptedTransport` still applies to every principal including the
deployer, and no principal is allowed to set a per-object retention.

**Listing is not reading.** The bucket policy denies the deployer every object, and
`infra/policies/deployment-role-policy.json.tftpl` denies `fss-prod-deploy`
`s3:GetObject*` outright in IAM as well. Both halves would have to change for a deployer
to read one suppression event. IAM says nothing about `s3:ListBucket`, which is why the
bucket policy was the only refusal and why removing it is the whole fix.

**It does not protect what no deny covers.** The encryption configuration and the
ownership controls were deleted because nothing denies their deletion, and that is still
true. What has changed is the thing that made the provider try: it can see the bucket now.

## What is still unverified

That a `HeadBucket` by `fss-prod-deploy` succeeds against the repaired policy. The repair
applied to the live bucket was made by hand by the account administrator, and the policy
this lane renders is the same shape; the next production plan is where the two are first
compared. The failure direction is legible either way — a refused head request produces
the same phantom create as before, in a plan, before anything is applied.
