# RDS describes an AWS-managed key on the deployer's behalf; the deployer may describe any key

**Date:** 22 September 2026. **Status:** decided, on the CloudTrail record of Actions 35660873276.

## What happened

David's fifth credentialed rehearsal (`stage = create`, commit ae53e7d2) created 125 resources and was refused exactly one: `CreateDBInstance` answered `KMSKeyNotAccessibleFault`, naming the database module's own customer key. The teardown destroyed all 125 resources by name and the production guard passed.

## What the record showed

The operator listed CloudTrail's KMS events for the create window. On the module's own key (`80bcdb9c…`, tagged `NamePrefix=fss-rh-202609212206` from creation), RDS's calls on the deployer's behalf **succeeded**: `CreateGrant` and `DescribeKey` at 22:07:39Z, about twenty seconds after the key was created. The single refusal in the window, at the same second, was:

```
kms:DescribeKey  AccessDenied  invokedBy rds.amazonaws.com
User: arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/fss-rh-202609212206 is not authorized to perform:
kms:DescribeKey on resource: arn:aws:kms:us-east-1:326255650484:key/89caff99-6669-437c-b0bf-94c8732637f6
because no identity-based policy allows the kms:DescribeKey action
```

That key was not created by the run. It is `alias/aws/secretsmanager`, the account's AWS-managed default Secrets Manager key (`KeyManager: AWS`, confirmed by the operator on 22 September): RDS describes it while creating the instance's managed master password, even though the module's own key was given for that secret. The deployment role's policy allowed `kms:DescribeKey` only on keys tagged with the namespace (`ManageTaggedKmsKeysInThisNamespace`); AWS-managed keys carry no tags, so no statement allowed it, and the implicit deny surfaced through RDS as "the specified key isn't accessible", naming the key we had specified rather than the one it had asked about.

## What this refutes

The first explanation, written before the record was read, was tag propagation: the KMS Developer Guide bounds tag changes affecting authorization at five minutes, and PR 163 added a five-minute wait between the key and the instance. The record shows the tagged key was authorized within twenty seconds, so the wait solved nothing; it is removed in the same change that fixes the policy. The lesson is recorded in the release document: read the service's own record of a refusal before choosing a fix, because the message a service returns names the resource the caller specified, not necessarily the one it was refused.

## The change

- `infra/policies/deployment-role-policy.json.tftpl`: `kms:DescribeKey` joins the `AccountMetadata` statement (`Resource: "*"`, no condition), beside `kms:ListAliases` and `kms:ListKeys`. `DescribeKey` returns a key's metadata (state, manager, description) and grants no use of it; it is exactly the class of read-only account metadata that statement already holds. The tag-scoped statement keeps every action that uses or manages a key.
- `infra/scripts/check-deployment-role.sh`: a group simulates `kms:DescribeKey` against an untagged key ARN with no context, so the check answers the question this run asked.
- `infra/modules/database`: PR 163's `time_sleep` and the `time` provider are removed, and the module's tests and the two root tests go back to their previous text.
- Both role policies must be rendered and put again (runbook 1.1a), then checked, before the next stage: the change is in the policy, not in Terraform.

## What was considered and not done

- **Leaving the wait in** "for safety". It costs five minutes per fresh environment and the record shows it addressed nothing; a wait that fixes nothing teaches the next reader the wrong lesson about the failure it sits beside.
- **Allowing `kms:DescribeKey` only on the one AWS-managed key** by ARN or alias. The alias would have to be confirmed per account and region and the ARN differs per account; RDS may describe others in other operations; and `DescribeKey` on any key reveals nothing the role cannot already learn from `ListKeys` and `ListAliases` plus the console.
- **Letting RDS use the default Secrets Manager key for the master password** instead of the module's key. The refusal is on describing a key, not on using ours, and the design keeps the master secret under the module's customer key.

## Consequences

The deployment roles can read the metadata of every key in the account. They still cannot use, grant, or manage any key outside their namespace. The rehearsal `create` stage is the proof.
