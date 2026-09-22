# G21: the rehearsal teardown removes its own state object, and only an empty one

**Decided 21 September 2026, under spec silence.** Specification revision 3 says
production and each rehearsal run use distinct state keys (section 2, "Terraform
state"; Appendix G 39) and says nothing about who removes a key when the run is over.

## What was happening

Terraform's S3 backend writes state and never removes it. `terraform destroy` empties
the resource list and puts the object back; the object stays. So every rehearsal run
left `fss/greenfield/rehearsal/<prefix>/terraform.tfstate` in
`callie-sourcing-tfstate-326255650484`, one per run, for ever. David deleted the first
by hand on 21 September, after the fourth credentialed run, together with the journal
bucket that teardown had also missed (`release.md` 8.0d, 8.0f).

Two objects a person has to remember to delete is two objects a person will eventually
forget.

## The decision

The teardown deletes its own state object as step 6/6, under three conditions, each of
which exists because the state object is the *only* record of what a failed destroy
left standing:

1. **After the destroy.** Step 6 runs only when step 4 reported `DESTROYED=true` or
   `nothing_created`. Deleting the object a destroy is about to write would throw away
   the record of what is still there.
2. **This run's key, by equality.** The key is derived from the run prefix by
   `rehearsal_state_key`, the bucket is read out of `infra/roots/rehearsal/backend.hcl`
   — the same file the workflow's init step passes as `-backend-config` — and the pair
   goes through `rehearsal_refuse_production_arguments` and
   `rehearsal_classify_state_key` before the teardown's *first* delete of the run, not
   beside its last. Anything but `fss/greenfield/rehearsal/<this prefix>/terraform.tfstate`
   is refused and named.
3. **Provably empty.** The object is read, parsed, and deleted only if it is a JSON
   object with an integer `version`, a string `lineage`, and a `resources` member that
   is absent or an empty list. A parse failure, a non-state document, or a resource
   still in the list leaves the object where it is, reports `state_object=refused`, and
   **fails the step**: a destroy that returned zero while its state still holds
   resources is not a teardown anybody should read as clean. An absent object is
   `state_object=absent` and is not a failure, because a run that created nothing never
   wrote one.

`NoSuchKey` joins `REHEARSAL_ABSENCE_ERROR_CODES`, so "it is not there" and "I was not
allowed to look" still report differently: an `AccessDenied` on the read stops the
teardown.

## Why the registry key is refused by name

`infra/roots/rehearsal-registry/terraform.tfstate` is the state of the two durable ECR
repositories — `fss-rh-api` and `fss-rh-worker` — that every run deploys from and no
run creates. It is the only key in the rehearsal space that belongs to no run.

`infra/scripts/offline-gate.sh` already refuses to let that key live *inside* the
per-run space, and the new IAM statement's glob
(`fss/greenfield/rehearsal/*/terraform.tfstate`) cannot reach it, because the registry
key has `-registry` where the glob needs a `/`. Those are two good boundaries and the
classifier is a third, because the three fail in different ways: the gate check is
about where the key is configured, the IAM glob is about what the role may do, and
`rehearsal_classify_state_key` is about what *this script* may address — the layer that
is still there if somebody renders the policy by hand, or runs the teardown with an
administrator's credential to finish an orphan off. The registry key is named in one
constant, `REHEARSAL_REGISTRY_STATE_KEY`, and a refusal that says
`rehearsal-registry` is a refusal an operator can act on.

Production's key (`fss/greenfield/production/...`) is refused by the same function and
needs its own clause: it carries no `fss-prod`, so
`rehearsal_refuse_production_arguments` cannot see it.

## What is left behind, and why

The DynamoDB digest item the S3 backend keeps beside the lock,
`<bucket>/<key>-md5` in `callie-sourcing-tflock`. The teardown does not delete it.

* It is tens of bytes, and it is keyed by this run's own path, so it accumulates at
  exactly the rate the state objects did but costs nothing and collides with nothing.
* Deleting it is a second mutation, in a second service, whose "is this mine?" guard
  would be a different shape from the S3 one (a `LockID` string rather than a key), for
  an object that is not the thing this lane was asked to remove.
* `ThisNamespacesStateDynamoLock` already permits `dynamodb:DeleteItem` on it under a
  `dynamodb:LeadingKeys` condition, so this is a choice and not a permission problem.

**The one case where it matters** is re-creating a prefix that has already been torn
down: Terraform reads the digest, finds no object at the key, retries for about ten
seconds and stops with "state data in S3 does not have the expected content". Run
prefixes are `fss-rh-<UTC timestamp>` by default, so this needs a deliberate reused
`run_suffix`. The fix is a new suffix, or one command:

```bash
aws dynamodb delete-item --table-name callie-sourcing-tflock \
  --key '{"LockID":{"S":"<bucket>/fss/greenfield/rehearsal/<prefix>/terraform.tfstate-md5"}}'
```

It is in `release.md` 3.0 beside the teardown's own paragraph, which is where somebody
about to reuse a suffix will be reading.

## The grant, and the one it is not

`ThisRunsStateObjectCleanup` — `s3:DeleteObject` on
`arn:aws:s3:::<state bucket>/fss/greenfield/rehearsal/*/terraform.tfstate`, rendered for
`fss-rh` only. It is deliberately not the existing
`ThisNamespacesStateLockFileCleanup` glob (`fss/greenfield/rehearsal*.tflock`) widened,
and deliberately not `s3:DeleteObject` on the state glob
`fss/greenfield/rehearsal*`: that would reach the registry key, every backup object
beside any key, and every `.tflock`. The narrowest glob that covers a run's state
object and nothing else is the one with `/terraform.tfstate` on the end.

`s3:DeleteObjectVersion` is **not** granted. The state bucket is versioned, so the
delete leaves a delete marker and the old versions stay non-current — which is the
right outcome: versioning on a state bucket exists so that a mistaken write can be
recovered, and a teardown that could erase version history would defeat it. The
bucket's own lifecycle, not a rehearsal role, is where non-current state versions
expire.

Production gets neither statement. `fss-prod-deploy` needs no state access at all: the
production apply is local and its state is read by David's own admin principal.
