# The rehearsal role holds a wide allow for one pass, and the exact policy is derived from what that pass asked for

**Date:** 22 September 2026. **Status:** decided by David, after the coordinator's account of why six credentialed runs had each moved one permission.

## The loop

Runs four to six (Actions 35628963637, 35660873276, 35679472666) and the step 0 stop at 01968250 each found exactly one thing the deployment role could not do, and each finding cost a cycle: a forty-minute `create` (apply and teardown of 125 resources) or a step 0 round trip, then a pull request, then step 0 again. The findings were not guessable in advance. RDS describes an AWS-managed key the role could not see; RDS creates the master secret in the caller's own session; the simulator evaluates one tag-key family and not another. The database, where the last two refusals were, is created after the first 125 resources, so nothing behind it can be seen until it is passed. Least privilege for a deployment role was being discovered empirically, one refusal per cycle, and the honest forecast for `deploy` and `full` was one to three more.

## The decision

For **one** pass of `create`, `deploy` and `full`, `fss-rh-deploy` holds a wide allow on the services the Terraform tree uses. The CloudTrail record of that pass is the source of the exact policy; the exact policy is proved by one more run before anything touches production. `fss-prod-deploy` is never widened, and the renderer refuses to render discovery for it.

## What the discovery document is

`infra/scripts/render-deployment-role-policy.sh fss-rh <mode> --discovery` renders the normal rehearsal document with `infra/policies/rehearsal-discovery-statements.json.tftpl` appended:

- `DiscoveryAllowOnTheServicesTheTreeUsesRemoveAfterTheFirstFullRun`: `acm:*`, `cloudfront:*`, `cloudwatch:*`, `ec2:*`, `ecr:*`, `ecs:*`, `elasticloadbalancing:*`, `kms:*`, `logs:*`, `rds:*`, `s3:*`, `secretsmanager:*`, `sns:*`, `tag:GetResources`, `wafv2:*` on `*`. **Not** `iam`, `sts` or `dynamodb`: the role keeps the scoped grants it has for those, and IAM is the escalation path a wide allow must never open.
- Six guards, all `Deny`: `*` on anything whose ARN contains `fss-prod` (and `role/fss-prod*`, and `s3:::fss-prod*`); `*` on anything tagged `NamePrefix = fss-prod*`; `*` on any request tagging `NamePrefix = fss-prod*`; `*` on anything named `delegated-worker` and on the old stack's secrets, topics, log groups, key aliases, clusters, databases and repositories; the state bucket's configuration (bucket-level puts and deletes, never the objects); and the state key's management (deletion, disabling, policy, aliases, tags, grants).
- Every `Deny` of the normal document stays: no self-modification of the role, no managed policy but the stack's, no KMS data action outside the namespace or the state key, no secret value but the tagged master secret, no S3 data outside the state.
- The Allows of the normal document whose every action is on a widened service are not emitted. They grant nothing the wide allow does not, and with them the document measures past IAM's 10,240-character limit. The metadata statement, the scoped IAM grant and the lock-table grant stay. The renderer prints the list it left out.

The discovery document measures under 6,000 characters. The check still runs against it and must still pass: a guard that denied something the apply needs would show there first.

## What the pass produces

`infra/scripts/deployment-role-actions-used.sh <start> <end> fss-rh-deploy` reads CloudTrail's 90-day event history (read-only, no trail needed, no request parameter printed) and lists every distinct action the role made, with counts, error codes, the services that invoked it on the role's behalf, and up to five resource ARNs. That list, against the normal document and the check's table, is the diff the exact policy is written from.

## What was considered and not done

- **Keep iterating.** Correct at every step, and the forecast was one to three more cycles before `full`, then whatever `full` found. David chose speed for one day over that.
- **A database-only stage.** Shorter cycles for `create`, nothing for `deploy` and `full`, and more workflow code.
- **Widening production as well.** Never on the table. Production's role is checked against the same rendered template, and the exact policy is proved on the rehearsal before the production apply.
- **A wide allow with no guards.** The wide allow's services include S3, Secrets Manager and KMS, where the account holds production's and the old stack's resources; the guards are the cost of the widening.

## The exit

The normal document is put back and checked before `fss-rh-deploy` is used for anything else. Discovery mode has no place in a release record: `full` under discovery produces a `releaseGateReference` that proves the scripts and the stack, not the policy, and release.md says so in 8.0h.

## Addendum, 22 September, evening: the first document was malformed

`put-role-policy` refused the first discovery document: `Resource vendor must be fully qualified and cannot contain regexes`. Two guards were written as `arn:aws:*:*:*:*fss-prod*` and `arn:aws:*:*:*:*delegated-worker*`; IAM's ARN grammar requires the service segment to be literal (region, account and the resource may carry wildcards). The put is atomic and the role kept its normal document. The guards now name their services: production's version of every named shape the role can address (alarms, repositories, clusters, services, tasks, task definitions, load balancers, target groups, listeners, listener rules, roles, key aliases, log groups, databases, parameter and subnet groups, snapshots, buckets, secrets, topics, web ACLs), and the old worker's log groups, buckets, secrets, topics, aliases, repositories, clusters and databases. The renderer refuses any resource whose service segment is not literal, the test asserts the guard covers production's version of each named shape, and the runbook validates every document with `accessanalyzer validate-policy` before it is put. The tests had checked only that the strings were present; that is the lesson.

## Addendum 2, 22 September, night: narrowed after the independent review

The review's evaluator showed the wide `s3:*` on `*` would have allowed `s3:DeleteObject` on `fss/greenfield/production/terraform.tfstate` and on every other stack's state in the shared bucket. S3, ECR, SNS and ACM leave the wide allow: none of the four ever refused a credentialed run, and their scoped statements now stay in the discovery document. A seventh guard denies every object action on production's state keys by name. The remaining widened services are the ones that have refused a run or that `deploy` and `full` have yet to exercise: CloudFront, CloudWatch, EC2, ECS, load balancing, KMS, logs, RDS, Secrets Manager, WAF.
