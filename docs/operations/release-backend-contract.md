# Reviewed release backend contract

Source contract for [#652](https://github.com/david-cui-bruno/founding-sales/issues/652). Source selection and controlled tests are **not operational approval**. No live policy, encryption, credential, backend transaction or deployed readiness is attested here.

## Actors and encryption

| Stage | S3/DynamoDB backend credentials | Terraform AWS provider credentials |
| --- | --- | --- |
| Reviewed prepare | Ambient `fss-prod-ci-plan`, `FSS_PRODUCTION_PLAN_ROLE_ARN`, `production-plan` | Same planner, explicit `assume_deployment_role=false` |
| Reviewed execute | Ambient existing `fss-prod-deploy`, `FSS_PRODUCTION_REVIEWED_ROLE_ARN`, protected `production-release-review` | Same deployment role, saved `assume_deployment_role=false` |
| Separately approved local human plan/bootstrap preparation | Explicitly approved ambient human identity, not the provider's assumed role | Root default assumes `fss-prod-deploy`; provider assumption does not grant backend rights |
| App-only deploy / routine maintenance | None | None, no Terraform initialization |

The existing `infra/roots/production/backend.hcl` is the only reviewed init input: bucket `callie-sourcing-tfstate-326255650484`, key `fss/greenfield/production/terraform.tfstate`, region `us-east-1`, table `callie-sourcing-tflock`, `encrypt=true`, `use_lockfile=true`. This selects existing SSE-S3/AES256 for state and lock writes, with **no `kms_key_id` and no backend KMS data grants**. It does not migrate/rewrite state or verify bucket defaults. SSE-KMS is deliberately refused. A change needs a separately reviewed exact key, key policy and caller contract including Encrypt, Decrypt and GenerateDataKey for state and lock writers.

The supported `reviewed-release.mjs prepare` and `execute` commands validate the source backend/configuration before Terraform. They refuse environment-injected Terraform arguments/variables/workspaces/data/config files, AWS profile/role/endpoint overrides, root automatic variable/override files, changed account/region/key/encryption and missing planner backend rights. Existing live caller checks, workflow provenance, hold, unchanged source/images, stable baseline, saved-plan hash and state lineage/serial remain enforced. Execute also refuses a saved provider-role assumption. The guard checks source configuration, **not attached/effective live IAM**. Real init/read/lock failures stop the existing command without retries or resource apply.

## Exact permissions

Both callers get `ListBucket` only for the state key and `.tflock` key, state `GetObject`, native `.tflock` `GetObject/PutObject/DeleteObject`, lock table `DescribeTable`, and DynamoDB lock-row `GetItem/PutItem/DeleteItem`. Planner checksum-row access is **GetItem only**. Execute additionally gets state `PutObject` and checksum `PutItem`. Neither grants state deletion (including `DeleteObjectVersion`) or checksum deletion. The validator refuses alternate checksum mutations through UpdateItem, BatchWriteItem and PartiQL item writes as well as Put/Delete outside the stage's exact rights. DynamoDB leading keys are exactly `<bucket>/<key>` and the separate `<bucket>/<key>-md5` row, never a wildcard or combined writable checksum grant.

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

The only changed existing statement is the actual unconditional `NoDeploymentDataAccess` deny with `Resource="*"` and the exact `s3:GetObject*` action. Its other actions retain their Sid and blanket denial. The object-read portion is split into a deny everywhere except the **two exact state/lock objects**, with only exact `s3:GetObject` grants added. Other denied data, secret access, older rights, resource controls, trust and duration remain intact. Broad pre-existing object-read allows that could activate ACL/version/other read access through this exception are refused. Unexpected identity, deny shape, Sid collision, unsupported relevant condition, remaining effective deny or unsafe state/delete rights refuse the proposal, rather than substituting a template or silently broadening scope. The output is a review artifact, not a policy writer.

## Separate live boundary and validation

Before bootstrap or held-backlog rollout, obtain separate exact operational approval and refresh actual role trust/inline/attached policies, boundaries/session/resource policies, encryption and backend identity. Review the proposed delta against that real baseline and its effective denies. Only a separately authorized real transaction can establish init, state read, native/DynamoDB lock acquire/release, checksum consistency and applicable narrowly scoped state writes. Hold, release serialization, current state and exact saved-plan approval remain independent gates. No source choice lifts the hold or authorizes IAM, deployment, migration, Enable or sending.

Controlled acceptance runs through the ordinary CLI and reviewed prepare/execute seams in `test/ops/releaseBackendContract.check.ts`, `reviewedBackendExecution.check.ts`, `reviewedRelease.check.ts` and `reviewedWorkflow.check.ts`. Terraform role assertions also retain planner/app/maintenance separation. Before review fixes, pinned Node24 validation passed all 775 operations tests in 45 files, full repository lint, touched infrastructure-script lint and operations TypeScript checking. After the narrow review fixes, all 53 tests across the four backend/reviewed-release suites passed, including six new policy-check/proposal safety regressions and the production-only runbook regression; workflow fast gate, touched lint and operations types also passed. Terraform 1.15.8 format checks passed for the touched Terraform/test files. Gitleaks 8.30.1 passed the staged diff and established history/context verification with zero findings (24,037 history versions, 6,222 paths, 3,546 context files). Independent review identified state-version deletion, alternate checksum mutation and stale production-init instructions; those findings are corrected, and all three same-reviewer rechecks are clean. The full operations suite was not repeated for the narrow fixes. Terraform test plans, backend init/plan/apply and actual AWS validation were intentionally not run.
