# Reviewed release backend contract

Source contract for [#652](https://github.com/david-cui-bruno/founding-sales/issues/652). Source selection and controlled tests are **not operational approval**. No live policy, encryption, credential, backend transaction or deployed readiness is attested here.

## Actors and encryption

| Stage | S3/DynamoDB backend credentials | Terraform AWS provider credentials |
| --- | --- | --- |
| Reviewed prepare | Ambient `fss-prod-ci-plan`, `FSS_PRODUCTION_PLAN_ROLE_ARN`, `production-plan` | Same planner, explicit `assume_deployment_role=false` |
| Reviewed execute | Ambient existing `fss-prod-deploy`, `FSS_PRODUCTION_REVIEWED_ROLE_ARN`, protected `production-release-review` | Same deployment role, saved `assume_deployment_role=false` |
| Separately approved local human plan/bootstrap preparation | Explicitly approved ambient human identity, not the provider's assumed role | Root default assumes `fss-prod-deploy`; provider assumption does not grant backend rights |
| App-only deploy / routine maintenance | None | None, no Terraform initialization |

The existing `infra/roots/production/backend.hcl` is the only reviewed init input: bucket `callie-sourcing-tfstate-326255650484`, key `fss/greenfield/production/terraform.tfstate`, region `us-east-1`, table `callie-sourcing-tflock`, `encrypt=true`, `use_lockfile=true`. S3 state and native lock objects retain SSE-S3/AES256, with **no `kms_key_id` or S3 KMS grants**. The separate existing DynamoDB lock table uses a customer-managed CMK and needs the narrowly constrained Decrypt permission below. This does not change any key, key policy, table/bucket encryption or stored state. S3 SSE-KMS overrides remain refused.

The supported `reviewed-release.mjs prepare` and `execute` commands validate the source backend/configuration before Terraform. They refuse environment-injected Terraform arguments/variables/workspaces/data/config files, AWS profile/role/endpoint overrides, root automatic variable/override files, changed account/region/key/encryption and missing planner backend rights. Existing live caller checks, workflow provenance, hold, unchanged source/images, stable baseline, saved-plan hash and state lineage/serial remain enforced. Execute also refuses a saved provider-role assumption. The guard checks source configuration, **not attached/effective live IAM**. Real init/read/lock failures stop the existing command without retries or resource apply.

## Exact permissions

Both callers get `ListBucket` only for the state key and `.tflock` key, state `GetObject`, native `.tflock` `GetObject/PutObject/DeleteObject`, lock table `DescribeTable`, and DynamoDB lock-row `GetItem/PutItem/DeleteItem`. Planner checksum-row access is **GetItem only**. Execute additionally gets state `PutObject` and checksum `PutItem`. Neither grants state deletion (including `DeleteObjectVersion`) or checksum deletion. The validator refuses alternate checksum mutations through UpdateItem, BatchWriteItem and PartiQL item writes as well as Put/Delete outside the stage's exact rights. DynamoDB leading keys are exactly `<bucket>/<key>` and the separate `<bucket>/<key>-md5` row, never a wildcard or combined writable checksum grant.

Both prepare and execute add only `kms:Decrypt` on existing lock-table key `arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404`, with all three exact `StringEquals` conditions: `kms:ViaService=dynamodb.us-east-1.amazonaws.com`, `kms:EncryptionContext:aws:dynamodb:tableName=callie-sourcing-tflock`, and `kms:EncryptionContext:aws:dynamodb:subscriberId=326255650484`. No direct decrypt, other key/service/region/table/account, Encrypt, GenerateDataKey, ReEncrypt or CreateGrant is added. This is existing-table access, not table creation or encryption configuration. The validator requires the exact grant, evaluates relevant explicit denies and refuses missing/widened conditions and unsupported relevant conditions.

`infra/policies/production-backend-plan.json` is shared with the prospective planner Terraform policy and checked against the CLI contract. App-only and maintenance policy composition stays unchanged. The historical deployment role is **not** replaced with the prospective deployment template.

## Offline proposal, using the actual supplied baseline

These source-only commands neither call AWS nor initialize Terraform:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node infra/scripts/reviewed-release.mjs backend-contract prepare
node infra/scripts/reviewed-release.mjs backend-contract execute
node infra/scripts/reviewed-release.mjs backend-contract local-plan
node infra/scripts/reviewed-release.mjs backend-proposal /private/actual-baseline.json > /private/backend-proposal.json
node infra/scripts/reviewed-release.mjs backend-policy-check execute /private/proposed-policy.json
```

The supplied baseline envelope must contain `roleArn` exactly `arn:aws:iam::326255650484:role/fss-prod-deploy`, `policyName` exactly `fss-prod-deploy-scope`, and `policy` containing the **actual existing** inline policy JSON. Additional supplied metadata such as trust (including CurrentAdministrator), session duration and attachment inventory is retained unchanged, not edited or applied. The original input is untouched and the output retains a separate complete `baseline` alongside `proposed`. Keep actual evidence private. The tests use controlled historical-shape fixtures, not an invented account readback.

Preserved namespace-tagged KMS rights are excluded from this backend key only when the envelope explicitly supplies observed `lockKeyNamePrefix:null` (tag absent) or a nonmatching literal string. Missing, malformed or `fss-prod*`-matching classification refuses. Recognition is limited to the existing exact `StringLike`/`aws:ResourceTag/NamePrefix=fss-prod*` condition on `Resource="*"`; it never drops or rewrites that statement. Separately verify the actual tag before any policy write, since caller-supplied metadata is not live attestation. The exported `validatePolicy(policy, stage, {lockKeyNamePrefix})` accepts the same classification for private readback checks. The plain `backend-policy-check` CLI has no metadata input and deliberately refuses a full role policy needing this evidence, rather than treating omission as absence. The minimal source backend policy needs no namespace classification.

The only changed existing statement is the actual unconditional `NoDeploymentDataAccess` deny with `Resource="*"` and the exact `s3:GetObject*` action. Its other actions retain their Sid and blanket denial. The object-read portion is split into a deny everywhere except the **two exact state/lock objects**, with only exact `s3:GetObject` grants added. Other denied data, secret access, older rights, resource controls, trust and duration remain intact. Broad pre-existing object-read allows that could activate ACL/version/other read access through this exception are refused. Unexpected identity, deny shape, Sid collision, unsupported relevant condition, remaining effective deny or unsafe state/delete rights refuse the proposal, rather than substituting a template or silently broadening scope. The output is a review artifact, not a policy writer.

## Separate live boundary and validation

Before bootstrap or held-backlog rollout, obtain separate exact operational approval and refresh actual role trust/inline/attached policies, boundaries/session/resource policies, encryption and backend identity. Review the proposed delta against that real baseline and its effective denies. Only a separately authorized real transaction can establish init, state read, native/DynamoDB lock acquire/release, checksum consistency and applicable narrowly scoped state writes. Hold, release serialization, current state and exact saved-plan approval remain independent gates. No source choice lifts the hold or authorizes IAM, deployment, migration, Enable or sending.

Controlled acceptance uses the ordinary CLI and reviewed prepare/execute seams in `test/ops/releaseBackendContract.check.ts`, `releaseBackendKms.check.ts`, `reviewedBackendExecution.check.ts`, `reviewedRelease.check.ts` and `reviewedWorkflow.check.ts`. The lock-CMK correction covers exact service/context rights, explicit denies, malformed/missing tag evidence, unchanged eighteen-statement baseline rights and a synthetic existing twenty-five-statement delta. Terraform assertions retain planner/app/maintenance separation. Current correction verification and independent review are not live access acceptance. No Terraform test plans, backend init/plan/apply, actual AWS validation or IAM write is performed by these source tests.
