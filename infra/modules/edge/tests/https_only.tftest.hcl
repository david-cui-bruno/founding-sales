mock_provider "aws" {
  override_during = apply

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::fss-test-alb-logs-123456789012"
      id  = "fss-test-alb-logs-123456789012"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/fss-test-alb/1111111111111111"
      dns_name = "fss-test-alb-1111111111.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  # The listener validates that its default action names something ARN-shaped, so
  # a generated placeholder is refused: "default_action.0.target_group_arn
  # (s8v0vr7p) is an invalid ARN". Only the apply run at the end of this file
  # reaches that check, because only an apply resolves the attribute at all.
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fss-test-api/1111111111111111"
    }
  }
}

variables {
  name_prefix        = "fss-test"
  aws_account_id     = "123456789012"
  vpc_id             = "vpc-11111111111111111"
  subnet_ids         = ["subnet-1111111111111111a", "subnet-1111111111111111b"]
  security_group_ids = ["sg-1111111111111111a"]
  certificate_arn    = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
}

run "tls_only_private_logs_and_a_readiness_check" {
  command = plan

  assert {
    condition = (aws_lb_listener.https.port == 443
      && aws_lb_listener.https.protocol == "HTTPS"
      && aws_lb_listener.https.certificate_arn == var.certificate_arn
    && startswith(aws_lb_listener.https.ssl_policy, "ELBSecurityPolicy-TLS13-1-2"))
    error_message = "The one listener terminates TLS (1.2 at the least) on 443 with the supplied ACM certificate."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.access_logs.block_public_acls,
      aws_s3_bucket_public_access_block.access_logs.block_public_policy,
      aws_s3_bucket_public_access_block.access_logs.ignore_public_acls,
      aws_s3_bucket_public_access_block.access_logs.restrict_public_buckets,
    ])
    error_message = "The access-log bucket is never public."
  }

  assert {
    condition = length([
      for statement in jsondecode(aws_s3_bucket_policy.access_logs.policy).Statement :
      statement if statement.Sid == "DenyUnencryptedTransport" && statement.Effect == "Deny"
    ]) == 1
    error_message = "Plain HTTP to the log bucket must be denied."
  }

  # Readiness, not liveness (lane g81): a 503 from /readyz takes the task out.
  assert {
    condition     = aws_lb_target_group.api.health_check[0].path == "/readyz" && aws_lb_target_group.api.health_check[0].matcher == "200"
    error_message = "The load balancer polls the unauthenticated readiness path and treats anything but 200 as unhealthy."
  }
}

run "a_certificate_that_is_not_an_acm_arn_is_refused" {
  command = plan

  variables {
    certificate_arn = "self-signed"
  }

  expect_failures = [var.certificate_arn]
}

# Which bucket the access logs land in, asserted where the value exists.
#
# `aws_s3_bucket.access_logs.id` is computed, and the mock provider supplies
# mocked values during the apply phase, so this comparison cannot be made during
# a plan any more than a real one could. An apply run under a mocked provider
# reaches nothing and needs no credential.
# `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "the_access_log_bucket_is_the_module_s_own" {
  command = apply

  assert {
    condition     = aws_lb.main.access_logs[0].bucket == aws_s3_bucket.access_logs.id
    error_message = "Access logs must be delivered to the module's own bucket."
  }
}
