# RDS creates the managed master secret in the caller's session; the deployer may create exactly that secret

**Date:** 22 September 2026. **Status:** decided, on the error text of Actions 35679472666 and the RDS User Guide; the CloudTrail record of the window is requested and will be recorded here when the operator returns it.

## What happened

David's sixth credentialed rehearsal (`stage = create`, commit 04816ad9, after PR 164's `kms:DescribeKey` fix was installed and both roles checked at 100 of 100) created 125 resources and was refused exactly one, again `CreateDBInstance`:

```
Error: creating RDS DB Instance (fss-rh-202609220227-pg): operation error RDS: CreateDBInstance,
https response error StatusCode: 403 ... AccessDenied:
The user isn't authorized to create a secret in AWS Secrets Manager.
```

The teardown destroyed all 125 by name, reported `journal_bucket=gone`, and the production guard passed. The KMS path that refused the fifth run is proved: RDS got past the key and was stopped one service later.

## Why

`infra/modules/database` sets `manage_master_user_password = true` with the module's own customer key. RDS then creates the master secret, named `rds!db-<uuid>`, **using the caller's credentials** (a forward-access session), and tags it `aws:rds:primaryDBInstanceArn = <instance ARN>`. The RDS User Guide (*Password management with Amazon RDS and AWS Secrets Manager*, section *Required permissions*) lists what the caller must therefore hold: `kms:DescribeKey`, `secretsmanager:CreateSecret`, `secretsmanager:TagResource`, and with a customer key also `kms:Decrypt`, `kms:GenerateDataKey`, `kms:CreateGrant`. The KMS four were already allowed (PR 164 and the tag-scoped key statement). The Secrets Manager two were allowed only on `secret:fss-rh-*` and `secret:fss-prod-*` (`NamedResourcesInThisNamespace`), and `rds!db-` begins with neither.

## The change

- `infra/policies/deployment-role-policy.json.tftpl`: a new statement in both roles, `LetRdsCreateThisNamespacesManagedMasterSecret`: `secretsmanager:CreateSecret` and `secretsmanager:TagResource` on `arn:aws:secretsmanager:<region>:<account>:secret:rds!db-*`, under `StringLike aws:RequestTag/aws:rds:primaryDBInstanceArn = arn:aws:rds:<region>:<account>:db:<prefix>*`. The read statement for the same secret (`ReadTheRdsManagedMasterSecretOfThisNamespacesInstance`, conditioned on the resource tag) is unchanged, and so are the two `GetSecretValue` denies; production still cannot read any secret value.
- `infra/scripts/check-deployment-role.sh`: two rows. `CreateSecret` and `TagResource` simulated against an `rds!db-` ARN with the request tag RDS sends, and `DescribeSecret` against the same ARN with the resource tag it then carries. 103 actions per role.
- `infra/policies/terraform-resource-actions.json`: `aws_db_instance` names the two actions; `run_35679472666` records the class.
- `test/release/deploymentRolePolicy.check.ts`: the statement's shape (one statement, two actions, the namespace in the tag value, no blanket deny) for both roles; the run's actions allowed for both; the two check rows judged on the right ARN with the right tag key.
- `.github/workflows/greenfield-release.yml`: `include-hidden-files: true` on the reports upload, which had uploaded nothing because the directory is `.rehearsal-reports`.
- Both role policies must be rendered and put again (runbook 1.1a), then checked, before the next stage.

## Why this shape

- **Why not `secretsmanager:*` on `rds!*`.** The role would then be able to read, write, rotate and delete any RDS-managed secret in the account, including one belonging to an instance outside its namespace, and the blanket `GetSecretValue` deny is the only thing that would stop the reads. The two actions the User Guide names are the two granted.
- **Why the request tag and not the resource name.** The name `rds!db-<uuid>` carries nothing of the namespace; the instance ARN in the tag does. `aws:rds:primaryDBInstanceArn` is an `aws:`-prefixed system tag, which AWS refuses in any request a principal makes directly, so the condition is satisfiable only by RDS acting for the caller, and only for an instance whose name the role's `rds:*` on `db:<prefix>*` let it create.
- **Why not `aws:ViaAWSService`.** It would say the same thing less precisely (any service, any instance), and the read-only check passes context entries as strings, so a boolean key would need the check extended for no gain in scope.
- **Why not `DeleteSecret` and `RotateSecret` now.** The User Guide lists neither for the caller; RDS deletes the secret after `DeleteDBInstance` returns and rotates on its own schedule, both outside the caller's session. Granting them on the record of a documentation page would be the fifth run's mistake in reverse. If the next teardown is refused, the Secrets Manager record of the window names the action.

## What this refutes

Nothing that was decided; the fifth run's fix stands. What it corrects is the belief, written into release.md 8.1 item 9, that the master secret was only a *read* problem for the deploy stage. It is a *create* problem first, in the apply, and the read remains unproved.

## Consequences

Each deployment role can create the master secret of its own namespace's instances and nothing else under `rds!`. The production role still cannot read any secret value. The rehearsal `create` stage on the next commit is the proof of the creation; the `deploy` stage is the proof of the read.
