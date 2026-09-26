# The RDS-managed master secret is read, and every other value read denied, by the global tag key

**Date:** 22 September 2026. **Status:** decided, on the check's output at 01968250 and AWS's machine-readable service reference for Secrets Manager (`servicereference.us-east-1.amazonaws.com/v1/secretsmanager/secretsmanager.json`, fetched the same day).

## What happened

Both role policies rendered from 01968250 (PR 168) were installed and the rehearsal role was checked. One action of 103 was denied, and it was the row PR 168 added to ask, for the first time, about the read statement:

```
DENIED  secretsmanager:DescribeSecret (implicitDeny) on arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-11111111-2222-4333-8444-555555555555-AbCdEf
```

The row supplied `secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn = arn:aws:rds:…:db:fss-rh-example-pg`, exactly the key `ReadTheRdsManagedMasterSecretOfThisNamespacesInstance` is conditioned on. The two rows beside it, `CreateSecret` and `TagResource` under `aws:RequestTag/aws:rds:primaryDBInstanceArn` with the same colons in the tag key, were allowed. The production role was not checked (it would have reported the same row).

## What the evidence says

- The simulator evaluates a condition only from a context value it is given; a key it does not recognise or cannot match is an implicit deny (IAM User Guide, *How condition key evaluation works in the IAM policy simulator*). The check gave it the value under the service-specific key and it still denied, while the global-key rows passed: the simulator, for this key, evaluates `aws:RequestTag/…` and, by the same family, `aws:ResourceTag/…`, and not `secretsmanager:ResourceTag/…`. A read-only diagnostic (the same simulation with `MissingContextValues`, and three custom-policy simulations isolating the key family from the colons) was issued to the operator; its answer is recorded in release.md when it arrives.
- The service honours both keys. AWS's service reference lists, for `DescribeSecret` and for `GetSecretValue`, both `aws:ResourceTag/${TagKey}` and `secretsmanager:ResourceTag/tag-key` among the action's condition keys. Neither is "more correct" for the service; only one of them can be checked before an apply.

## The change

- `infra/policies/deployment-role-policy.json.tftpl`: `ReadTheRdsManagedMasterSecretOfThisNamespacesInstance` (`StringLike`) and `NoDeploymentSecretValueAccessButTheRdsManagedMasterSecret` (`StringNotLike`) both condition on `aws:ResourceTag/aws:rds:primaryDBInstanceArn`. Same values, same shape, one key. No service-specific `ResourceTag` key remains in either policy.
- `infra/scripts/check-deployment-role.sh`: the read row supplies the global key and is appended for the rehearsal role only, because production holds neither the read statement nor the carve-out (PR 168 wrote the row into the common table, where the production check would have failed it); and every denial now prints the simulator's `MissingContextValues` beneath it, which is the line that would have explained this stop without a second round trip.
- `test/release/deploymentRolePolicy.check.ts`: both statements use the global key for both roles and no `secretsmanager:ResourceTag/` remains; the check prints the missing context on a denial and nothing extra on an allow; the recording asserts the read row's key.
- Both policies must be rendered and put again (runbook 1.1a), then checked: 103 of 103 for `fss-rh-deploy`, 102 of 102 for `fss-prod-deploy`.

## What was considered and not done

- **Dropping the read row from the check** and leaving the policy as it was. The service would very likely have honoured the statement; but the check would then be asserting nothing about the one statement the `deploy` stage depends on, and the row's purpose was to make the read checkable before an apply.
- **Both keys in the policy** (two statements, one per key). Doubles the surface for one read and leaves the deny with a choice to make; the deny must name one key, and it should be the one the simulator can evaluate.

## Consequences

The rehearsal role can describe and read the master secret of an instance whose ARN carries its namespace, and nothing else; the production role can describe it and still read no secret value. The `deploy` stage is the proof against the service; the check is now the proof against the simulator.
