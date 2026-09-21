# The deployment roles' policies are code, and the Terraform tree judges them

**Lane:** G16 · **Date:** 21 September 2026 · **Spec:** Appendix G 39, 16.2 · **Evidence:** Actions run 35628963637

## What happened

`docs/greenfield/infra-apply-runbook.md` 1.1 described the two deployment roles'
permissions in prose — *"may act only on resources whose name begins `fss-rh-`"* — and the
repository shipped no policy document. David wrote both roles' inline policies from that
prose. On 21 September the fourth credentialed rehearsal applied with them and reported
**25 errors in six classes**, then failed its teardown.

Nothing offline could have caught any of them, not because the checks were weak but
because there was nothing for them to check: no artefact in the repository claimed what
the roles could do, so nothing could be compared with the Terraform that needed it.

## The decision

The policy is a template in the repository, rendered by a script:

| Thing | Path |
| --- | --- |
| The template | `infra/policies/deployment-role-policy.json.tftpl` |
| The map from resource type to actions | `infra/policies/terraform-resource-actions.json` |
| The renderer | `infra/scripts/render-deployment-role-policy.sh <fss-rh\|fss-prod>` |
| The pre-apply check | `infra/scripts/check-deployment-role.sh <role> <prefix>` |
| The offline judge | `test/release/deploymentRolePolicy.check.ts` |
| The commands David runs | `docs/greenfield/infra-apply-runbook.md` 1.1a |

It **starts from David's two live policies**, retrieved on 21 September, rather than from
a clean sheet: his structure is right, most of his Sids are right, and the
`NamePrefix`-tag conditions are the correct answer for every resource whose ARN carries no
name. What changed is listed statement by statement below. The rendered document replaces
the whole inline policy named `<prefix>-deploy-scope`; it is not a delta.

The prefix is the only argument. Everything else is derived from it — the namespace glob
`${name_prefix}*`, the deployment role ARN, the state key glob — or overridable by an
environment variable for values that are account facts rather than repository facts. Two
Sid sets are per-role and the renderer refuses to emit either for the wrong prefix; the
release suite asserts that every statement the two share is the production one with the
namespace substituted, so "the prefix is the only difference" is checked rather than
claimed.

## What changed against David's hand-written policies, and why

**The six classes of run 35628963637.**

1. **`ec2:AuthorizeSecurityGroupIngress` / `Egress` denied (eight rules).** His `ec2:*`
   allow was conditioned on `ec2:ResourceTag/NamePrefix` and a security-group *rule* being
   created carries no resource tag yet; the `RequestTag` statement beside it covered only
   `ec2:Create*`, and these actions are not `Create*`. The module tags the rules
   (`infra/modules/network/main.tf`), so both actions now appear in
   `CreateTaggedResourcesInThisNamespace` under `aws:RequestTag/NamePrefix` **and** stay
   in the `ec2:*` tagged statement, because IAM evaluates the security group and the
   security-group rule as separate resources and one statement has to pass for each.
   `Revoke*` and `ModifySecurityGroupRules` act on a rule that already carries the tag and
   need only the second.

2. **`kms:CreateAlias` denied (all five aliases).** An alias operation needs permission on
   the alias *and* on the key. His `kms:*` on `alias/fss-rh-*` covered the first; his
   tagged-key statement listed neither `CreateAlias` nor `UpdateAlias` nor `DeleteAlias`.
   All three are now in `ManageTaggedKmsKeysInThisNamespace`.

3. **Secrets Manager `Access to KMS is not allowed` (all eight entries).** Not a missing
   allow: his explicit deny `NoDeploymentKmsDataAccessOutsideTerraformState` covered
   `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey*` and `kms:ReEncrypt*` on every key
   but the Terraform state key, and Secrets Manager checks key use at `CreateSecret`. See
   the next section: this is the one change that needed David's decision.

4. **`cloudwatch:PutCompositeAlarm` denied (both composite alarms).** Unexplained. The
   alarms are named `<prefix>-critical` and `-warning` and his `cloudwatch:*` covered
   `alarm:fss-rh-*`. The shipped policy names the action explicitly in
   `CloudWatchAlarmsCarryTheNamespaceInTheirName` and the pre-apply check asks about it,
   but nobody has read the decoded authorization message for that call, so a repeat is
   open rather than a regression. **This is the one class this lane has not explained.**

5. **`cloudfront:CreateOriginAccessControl` denied.** It was under his `RequestTag`
   condition and an origin access control cannot be tagged — its id is assigned by AWS and
   there is neither a name in the ARN nor a request tag to condition on. It moves to
   `OriginAccessControlsCannotCarryATag`, `Resource: "*"` with no condition, and that Sid
   is in the map's `unconditional_sids` with the reason.

6. **`InvalidParameterCombination: Cannot find version 16.8 for postgres`.** Not IAM.
   `docs/decisions/g16-postgresql-is-pinned-by-major.md`.

**Predicted, not yet hit, and now covered.**

- `arn:aws:ecs:…:task/<prefix>*/*` — the teardown stops any one-off task still running,
  and his resource list had `cluster`, `service` and `task-definition` but no `task`.
- `arn:aws:rds:…:snapshot:<prefix>*` — the drill leaves a manual snapshot and the
  teardown deletes it.
- `arn:aws:wafv2:…:regional/webacl/<prefix>*/*` and `wafv2:*` — the tree has
  `aws_wafv2_web_acl` and its association. Dormant (`enable_waf` is false in both roots)
  and in the tree, so the map names it and the policy covers it.
- `secretsmanager:GetSecretValue` on `rds!db-*` — the rehearsal assembles its database URL
  from the RDS-managed master secret, whose name does not carry the prefix. Allowed under
  `StringLike` on `secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn` matching
  `arn:aws:rds:…:db:<prefix>*`, and the blanket `GetSecretValue` deny is narrowed by the
  same condition negated, so the deny still catches every application secret. Runbook 6.5
  and release.md 8.1 item 9 predicted this; it is closed in the document and unproved in
  the cloud.
- `ec2:RevokeSecurityGroupIngress` / `Egress` on an **untagged** security group. The AWS
  provider revokes the rules on a new VPC's default security group before it tags it, so
  `ec2:ResourceTag/NamePrefix` cannot match at the moment of the revoke.
  `AdoptTheVpcDefaultSecurityGroupBeforeItCarriesATag` narrows those three actions to
  security groups carrying **no** `NamePrefix` tag, which excludes every group either
  environment has ever applied. It is in `unconditional_sids` with that reason, because
  the narrowing is by absence rather than by namespace.
- `iam:CreateServiceLinkedRole` under an `iam:AWSServiceName` condition naming the four
  services that need one.

**Two denies added that David's policies did not have.**

- `NoSelfModificationOfTheDeploymentRole`. `iam:*` on `role/<prefix>*` matches
  `<prefix>-deploy` itself, so either role could write itself a policy granting anything
  in the account. The deny is `iam:*` on exactly the deployment role's ARN.
- `NoManagedPolicyButTheOnesTheStackAttaches`. `iam:AttachRolePolicy`'s resource is the
  role, not the policy, so `iam:*` on `role/<prefix>*` let either role attach
  `AdministratorAccess` to a task role it controls. The deny is conditioned on
  `ArnNotEquals` for `iam:PolicyARN`, and the release suite derives the permitted list
  from the `policy_arn` values in `infra/modules/**` — so a lane that attaches a third
  managed policy turns the suite red rather than discovering the deny mid-apply.

**One thing deliberately not shipped.** The exact ACM certificate ARNs. They are the
`rehearsal` environment secret `FSS_REHEARSAL_CERTIFICATE_ARN` and its production
counterpart, and a repository holding them would hold a value the workflow deliberately
keeps out of it. The default is every certificate in the account and region,
`acm:DescribeCertificate` is read-only, and `FSS_POLICY_CERTIFICATE_ARN` narrows it back
to David's one ARN per role.

## The KMS decision David made, and the two alternatives he rejected

**Approved, 21 September, late.** Each deployment role may use keys tagged `NamePrefix`
with its own prefix: `kms:GenerateDataKey*`, `kms:Encrypt`, `kms:Decrypt`,
`kms:ReEncrypt*`, `kms:CreateGrant` with `ListGrants` / `RevokeGrant` / `RetireGrant`,
`kms:DescribeKey`, and `CreateAlias` / `UpdateAlias` / `DeleteAlias`. The blanket KMS
deny is narrowed so it no longer catches tagged keys:
`NoDeploymentKmsDataAccessOutsideThisNamespaceOrTerraformState` denies those four data
actions with `NotResource` the state key **and** `StringNotLike` on
`aws:ResourceTag/NamePrefix`, so it fires for every key that is neither in the namespace
nor the state key — production's keys from the rehearsal role, and anybody else's from
either.

**The reason.** Secrets Manager and RDS check key *use* at creation, not at read:
`CreateSecret` with a customer key requires `kms:GenerateDataKey` and `kms:Decrypt` on
that key from the caller, and `CreateDBInstance` with `kms_key_id` requires
`kms:CreateGrant` and `kms:DescribeKey`. There is no configuration in which Terraform
creates these resources and the caller holds none of those actions.

**What it does not open.** The role has no path to any ciphertext, because the two
data-read denies remain in both documents: `secretsmanager:GetSecretValue` is denied on
everything except the RDS-managed master secret of a namespaced instance (rehearsal) or
denied outright (production), and `s3:GetObject*` is denied on everything except the
role's own Terraform state objects (rehearsal) or denied outright (production). So the
role may ask KMS to wrap a key for a secret it is creating and may not read the secret;
it may enumerate the journal bucket's versions and may not read an object. Production
additionally keeps its denies on `secretsmanager:PutSecretValue` and
`s3:BypassGovernanceRetention`.

**Rejected: AWS-managed keys instead of customer keys.** `aws/secretsmanager`,
`aws/rds`, `aws/s3` — the deployment role would need no KMS permission at all, and
`infra-topology.md` section 4's six-key line would go to zero. Rejected because spec 4.1
wants the envelope key for Gmail refresh tokens separate from application secrets, and
separating the journal key from the log key is what makes an operator who can read logs
unable to decrypt suppression history. An AWS-managed key cannot be separated from
anything, its policy cannot be read or constrained, and its rotation is not ours. The
cost of the decision is that the deployment role holds `GenerateDataKey` on six keys it
created, which the denies above make uninteresting.

**Rejected: a bootstrap-only identity.** A second role, used once to create the keys and
the secret entries and then never again, with the deployment role holding no KMS data
actions at all. Rejected because it is not once: every release plans the whole root, and
a plan that refreshes an `aws_secretsmanager_secret` reads `DescribeSecret` and not the
key — but any apply that *recreates* one, or adds a secret entry, or changes the RDS key,
needs the same permissions again. So the second identity would be needed on an unknown
subset of releases, which is the worst kind of operational rule: one that is usually
unnecessary and occasionally the reason a release stops at three in the morning. It also
adds a trust relationship and a second thing to keep in step with this template.

## What the offline judge actually does

`test/release/deploymentRolePolicy.check.ts` is a small IAM evaluator, not a string
search, and that distinction is the whole value of it. For each action:

- **allowed** — some `Allow` statement's `Action` glob matches it;
- **killed** — some `Deny` statement matches it with `Resource: "*"`, no `Condition` and
  no `NotResource`. That is the eight-secret failure, and a string search for
  `kms:GenerateDataKey` would have found the allow and reported a pass;
- **narrowed** — some `Deny` matches it but carries a `Condition` or a `NotResource`. The
  map entry has to *name* that deny in `deny_carve_out`, so a scoped deny nobody declared
  is red.

It requires the map's keys to equal exactly the `resource "aws_*"` types the tree
declares, so a lane that adds a resource type and forgets the actions it needs is red
here rather than in a credentialed run. It requires every `Allow` to name the namespace in
every resource ARN, or to carry a condition that names it, or to have its Sid in
`unconditional_sids` with a reason over eighty characters — and it also requires every Sid
*in* that list really to be unscoped, so the list cannot be padded. And it measures the
rendered document against IAM's 10,240-character inline-policy limit (whitespace
excluded), which the renderer also refuses to exceed: 8,034 for the rehearsal, 5,893 for
production today.

## What is unscoped, and why each has no resource to scope to

Five Sids, and no others. They are the answer to "what can either role do outside its
namespace":

| Sid | Actions | Why there is nothing to scope to |
| --- | --- | --- |
| `AccountMetadata` | `Describe*`, `Get*`, `List*` across eleven services, `sts:GetCallerIdentity`, `tag:GetResources` | Read-only. Almost none of these APIs takes a resource; `tag:GetResources` and `sts:GetCallerIdentity` take none at all, and the production-inventory comparison Appendix G 39 is measured with is one of them. No action here changes anything. |
| `OriginAccessControlsCannotCarryATag` | the six `*OriginAccessControl` calls | A CloudFront origin access control cannot be tagged and its id is AWS's. There is no name in the ARN and no request tag. This is the class the 21 September denial was. |
| `TaskDefinitionApisTakeNoResource` | `ecs:DeregisterTaskDefinition`, `ecs:ListTaskDefinitions`, `ecs:ListTaskDefinitionFamilies` | Documented with no resource-level permission. Registering is separately conditioned on `aws:RequestTag/NamePrefix`, and a task definition is inert until a service or a `run-task` names it (both ARN-scoped) and until a task role is passed (`iam:*` on `role/<prefix>*`). |
| `AdoptTheVpcDefaultSecurityGroupBeforeItCarriesATag` | `ec2:RevokeSecurityGroupIngress`, `Egress`, `ec2:CreateTags` on `security-group/*` | Narrowed by the *absence* of a `NamePrefix` tag rather than by its value, because the provider revokes before it tags. Excludes every security group either environment has applied. |
| `UseTheEnvironmentCertificate` | `acm:DescribeCertificate` | The exact ARN is a repository environment secret. Read-only, and `FSS_POLICY_CERTIFICATE_ARN` narrows it to the one ARN. |

Three further statements have `Resource: "*"` but carry a condition, so they are scoped in
practice and are not in the list above: `kms:CreateKey` and the two CloudFront creation
actions under `aws:RequestTag/NamePrefix`, `ec2:*` under `ec2:ResourceTag/NamePrefix`,
`kms:*` data and alias actions under `aws:ResourceTag/NamePrefix`, and
`iam:CreateServiceLinkedRole` under `iam:AWSServiceName`.

## What is still unverified

Every condition key and every resource-ARN shape here comes from the AWS service
authorization reference, read offline. This lane has no credential and made no call. What
settles them, in order:

1. `infra/scripts/check-deployment-role.sh` against the real roles. It is read-only and
   answers every action of run 35628963637 plus one per service in seconds. **Do this
   first.** Note that `simulate-principal-policy` does not evaluate a condition key it
   was not given, so the script passes `--context-entries` for the four `NamePrefix`
   keys; an action it reports as `implicitDeny` because a key was missing would be a
   false negative, and the script's own context table is what prevents it.
2. A local production plan, then the `plan` stage, then `create`.
3. The two things the check cannot answer: whether
   `secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn` is really the tag RDS puts on
   a managed master secret (documented; the fallback is a statement naming the ARN the
   root outputs), and why `cloudwatch:PutCompositeAlarm` was denied at all.
