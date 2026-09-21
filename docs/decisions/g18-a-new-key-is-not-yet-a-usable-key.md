# A new key is not yet a usable key: the database instance waits for its key's tag

**Date:** 21 September 2026, late evening. **Status:** decided; the CloudTrail record of the run and the next `create` confirm or refute the explanation.

## What happened

David's fifth credentialed rehearsal (Actions 35660873276, `stage = create`, commit ae53e7d2) created 125 resources and was refused exactly one:

```
Error: creating RDS DB Instance (fss-rh-202609212206-pg): … KMSKeyNotAccessibleFault: The specified KMS key
[arn:aws:kms:us-east-1:326255650484:key/80bcdb9c-…] either doesn't exist, isn't enabled, or isn't accessible by the current user.
```

The key is the database module's own customer key, created in the same apply about twenty seconds before `CreateDBInstance` was issued (key created 22:07:16Z, instance requested about 22:07:38Z). The teardown then destroyed all 125 resources by name and the production guard passed, so the run also proved PR 162's teardown.

## Why the policy is not the cause

The deployment role's policy (`infra/policies/deployment-role-policy.json.tftpl`, `ManageTaggedKmsKeysInThisNamespace`) allows every action RDS makes on the caller's behalf when it is given a customer key — `kms:DescribeKey`, `kms:CreateGrant`, `kms:GenerateDataKey*`, `kms:Decrypt`, `kms:Encrypt`, `kms:ReEncrypt*`, `kms:ListGrants`, `kms:RevokeGrant` — on any key tagged `NamePrefix=fss-rh-*`. The key has that tag from its creation: `kms:CreateKey` is allowed only with `aws:RequestTag/NamePrefix`, and the creation succeeded. The pre-apply check simulates exactly these actions with the tag in context and reports them allowed. The key's policy is the default one, which delegates to IAM. Nothing in that chain changed between the check and the apply.

## The explanation

From the ABAC page of the AWS KMS Developer Guide (read 21 September 2026):

> It might take up to five minutes for tag and alias changes to affect KMS key authorization. Recent changes might be visible in API operations before they affect authorization.

RDS asked KMS on the deployer's behalf about twenty seconds after the key and its tag were created. KMS's authorization did not yet see the tag, so the tag-conditioned allow did not match, and the deny on data actions against keys without the tag (`NoDeploymentKmsDataAccessOutsideThisNamespaceOrTerraformState`, a `StringNotLike` that is true when the tag is absent) may have fired as well. The secrets module's key, asked about ten seconds after its creation by `secretsmanager:CreateSecret`, had propagated by then; propagation is per key and not uniform.

What would refute this: a CloudTrail record showing RDS's KMS call refused for a reason other than a tag condition (a missing action, or a condition key the check does not model), or the next `create` failing identically after the wait.

## The change

`infra/modules/database/main.tf`: a `time_sleep` of five minutes — the bound AWS documents — between the key (and its alias) and the instance, keyed to the key's ARN so it runs once per key and never on an ordinary apply. The `hashicorp/time` provider is declared in the module; it makes no cloud call. The module's tests and the two root tests that apply the stack mock it, so no test sleeps.

## What was considered and not done

- **A shorter wait.** Two minutes would probably do; the cost of being wrong is another thirty-minute rehearsal, and the cost of five minutes is three more minutes beside the twenty a Multi-AZ instance already takes.
- **A key-policy statement granting the deployment role directly** (`DescribeKey`, `CreateGrant` with `kms:GrantIsForAWSResource`). It would remove the tag dependence for the allow side but not for the explicit deny in the identity policy, which also reads the tag; and it adds a per-environment principal to the key policy and a new module input for a problem a wait solves entirely. Revisit if the wait is ever shown insufficient.
- **Scoping the KMS allows by alias or by `kms:ViaService`** instead of by tag. Aliases are subject to the same documented delay; `kms:ViaService` widens the allow to every key in the account for those services.
- **Retrying the instance.** The provider does not retry `KMSKeyNotAccessibleFault`, and a failed create tears the whole environment down.

## Consequences

Every fresh environment takes five minutes longer to apply. Production's first apply pays it once. The rehearsal `create` stage is the proof; `docs/greenfield/release.md` 8.0e records the run.
