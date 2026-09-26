# The rehearsal journal can be torn down by the role that created it.
#
# Offline only: a mocked apply, no backend, no credentials. Every ARN below is
# the AWS documentation example account, never a real one.
#
# ## Why this file exists
#
# David's fourth credentialed rehearsal (21 September 2026, Actions run
# 35628963637, `stage = create`) applied and then could not tear itself down:
#
#     S3 DeleteBucketPolicy … 403 AccessDenied because of an explicit deny in
#     the resource-based policy
#
# and the same for `PutBucketObjectLockConfiguration`. `infra/modules/journal`
# denies deletion and lock weakening to `Principal *` with no exemption at all,
# including `s3:BypassGovernanceRetention` — so no principal but the account
# root could ever remove the bucket, and the teardown script's own
# `--bypass-governance-retention` emptying step could never have worked either.
# The residue was a bucket, its policy, its object lock, its versioning and its
# public-access block, plus one state object naming all four.
#
# The fix is an exemption the *root* names, not one the module assumes, so
# production keeps the posture it has: `administrative_principal_arns` on the
# journal module, passed by the rehearsal root as its own deployment role and
# left empty in production unless David sets it.
#
# ## The vacuous-pass trap
#
# Asserting that the policy *mentions* the role would pass against an exemption
# on one deny and not the others — which is exactly the shape of the 21
# September failure, where the bucket could be emptied and not deleted. And
# asserting the exemption exists everywhere would pass against an exemption on
# the transport deny, which would let the deployer talk to the journal over
# plain HTTP.
#
# Closed by partitioning the statements: every `Deny` whose Sid is not
# `DenyUnencryptedTransport` must carry the exemption with this run's role in
# it, the transport deny must carry no `ArnNotEquals` at all, and the count of
# exempting statements is compared with the count of non-transport denies so a
# statement that quietly stopped being a `Deny` cannot make the first assertion
# true by disappearing.

# Since G37 the reads deny is two statements, and the second of them — listing —
# is the one the rehearsal root exempts twice over: once as its administrator
# and once as the principal that may see the bucket. A rehearsal is where the
# recreate-and-strip failure of 23 September would have been found first, had
# the run that left `fss-rh-202609211659-suppression-journal-326255650484`
# behind ever been planned a second time.
#
# The other two halves of this deliverable are elsewhere, because the rehearsal
# root passes the exemption as a literal and has no variable a run block could
# vary: `infra/modules/journal/tests/object_lock.tftest.hcl` has the empty-list
# and merge cases against the module, and
# `infra/roots/production/tests/journal_teardown.tftest.hcl` has production's
# default of nobody and its opt-in.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-bucket"
      id                          = "mock-bucket"
      bucket_regional_domain_name = "mock-bucket.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/1111111111111111"
      dns_name = "mock-1111111111.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  # These runs are applies, not plans, so the provider validates arguments that
  # a plan leaves unknown: an unmocked target-group ARN is rejected by the
  # listener and by the service as "an invalid ARN: arn: invalid prefix". The
  # isolation tests next door are all plans and need none of this.
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/mock/1111111111111111"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:mock-alerts"
    }
  }

  # The same, for the daily alarm digest's schedule target (lane g99).
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:mock-alarm-digest"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E111111111111"
      id          = "E111111111111"
      domain_name = "d111111111111.cloudfront.net"
    }
  }
}

variables {
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname        = "rehearsal.example.invalid"
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
}

# Every statement names the bucket ARN, which is computed, so `policy_json` is
# unknown for the whole plan phase once the mock stops pretending otherwise
# (`override_during = apply`). A real plan is exactly as blind. An apply run
# under a mocked provider reaches nothing and needs no credential.
# `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "every_deny_but_the_transport_one_exempts_this_runs_deployment_role" {
  command = apply

  # The floor: a policy that could not be read would make everything below
  # vacuously true.
  assert {
    condition     = length(jsondecode(module.stack.journal_policy_json).Statement) >= 6
    error_message = "The rehearsal journal policy was read as having almost no statements; nothing below would mean anything."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      contains(try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], []), "arn:aws:iam::326255650484:role/fss-rh-deploy")
      if statement.Effect == "Deny" && statement.Sid != "DenyUnencryptedTransport"
    ])
    error_message = "Every deny but the transport one must exempt the role that created the bucket, or its own deployer cannot tear it down. The fourth credentialed rehearsal left a bucket behind for exactly this reason."
  }

  # The count, so that a statement dropping out of `Deny` cannot satisfy the
  # assertion above by no longer being examined.
  assert {
    condition = length([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      statement if statement.Effect == "Deny" && statement.Sid != "DenyUnencryptedTransport"
    ]) == 4
    error_message = "The journal has four non-transport denies — deletion and lock weakening, writes, object reads, listing — and each of them has to be exempted by name."
  }

  # The rehearsal names the same role twice, as its administrator and as the
  # principal that may see the bucket, and one role belongs in a condition once
  # (G37). A second `ArnNotEquals` key would have dropped one of the two.
  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      statement.Condition.ArnNotEquals["aws:PrincipalArn"] == ["arn:aws:iam::326255650484:role/fss-rh-deploy"]
      if statement.Sid == "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"
    ])
    error_message = "The listing deny exempts this run's deployment role, once."
  }

  # The deny that must never be exempted. Plain HTTP is refused to everybody,
  # including the deployment role: a teardown talks to S3 over TLS like
  # everything else.
  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      !can(statement.Condition.ArnNotEquals)
      if statement.Sid == "DenyUnencryptedTransport"
    ])
    error_message = "The transport deny applies to every principal. Exempting the deployer from it would let a teardown reach the journal over plain HTTP."
  }

  # The bypass is what makes a same-day destroy possible at all: the run's own
  # objects are locked in GOVERNANCE mode for a day, and `terraform destroy`
  # cannot remove a bucket that still holds them.
  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      contains(statement.Action, "s3:BypassGovernanceRetention")
      if statement.Sid == "DenyAnyDeletionOrLockWeakening"
    ])
    error_message = "The deny still covers governance bypass; the exemption is what lets the deployer through it, not the removal of the action."
  }

  # And `force_destroy`, without which Terraform refuses to delete a bucket
  # that holds objects however the policy reads.
  assert {
    condition     = module.stack.destroyable
    error_message = "A rehearsal journal is force-destroyable; the policy exemption alone would not empty it."
  }
}
