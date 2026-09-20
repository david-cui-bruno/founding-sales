mock_provider "aws" {
  override_during = plan

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
}

variables {
  name_prefix        = "fss-test"
  aws_account_id     = "123456789012"
  vpc_id             = "vpc-11111111111111111"
  subnet_ids         = ["subnet-1111111111111111a", "subnet-1111111111111111b"]
  security_group_ids = ["sg-1111111111111111a"]
  certificate_arn    = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
}

run "the_only_listener_is_tls" {
  command = plan

  assert {
    condition     = length(output.listener_ports) == 1 && contains(output.listener_ports, 443)
    error_message = "443 is the only listener. There is no plaintext endpoint to misconfigure."
  }

  assert {
    condition     = aws_lb_listener.https.protocol == "HTTPS" && aws_lb_listener.https.certificate_arn == var.certificate_arn
    error_message = "The listener terminates TLS with the supplied ACM certificate."
  }

  assert {
    condition     = startswith(aws_lb_listener.https.ssl_policy, "ELBSecurityPolicy-TLS13-1-2")
    error_message = "TLS 1.2 is the floor."
  }

  assert {
    condition     = aws_lb.main.internal == false && aws_lb.main.load_balancer_type == "application"
    error_message = "The edge is a public application load balancer."
  }

  assert {
    condition     = aws_lb.main.drop_invalid_header_fields && aws_lb.main.desync_mitigation_mode == "strictest"
    error_message = "Malformed and desynchronizing requests are rejected at the edge."
  }

  assert {
    condition     = aws_lb.main.enable_deletion_protection
    error_message = "Deletion protection is the default posture."
  }
}

run "access_logs_are_enabled_and_private" {
  command = plan

  assert {
    condition     = aws_lb.main.access_logs[0].enabled && aws_lb.main.access_logs[0].bucket == aws_s3_bucket.access_logs.id
    error_message = "Access logs must be delivered to the module's own bucket."
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
      for statement in jsondecode(output.access_log_policy_json).Statement :
      statement if statement.Sid == "DenyUnencryptedTransport"
    ]) == 1
    error_message = "Plain HTTP to the log bucket must be denied."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.access_log_policy_json).Statement :
      statement if statement.Sid == "AllowRegionalElbAccount"
    ]) == 0
    error_message = "The regional ELB account statement appears only when elb_account_id is set."
  }
}

run "the_health_check_is_unauthenticated_and_cheap" {
  command = plan

  assert {
    condition     = aws_lb_target_group.api.target_type == "ip" && aws_lb_target_group.api.port == var.container_port
    error_message = "Fargate awsvpc tasks register by address on the container port."
  }

  assert {
    condition     = aws_lb_target_group.api.health_check[0].path == "/healthz" && aws_lb_target_group.api.health_check[0].matcher == "200"
    error_message = "The load balancer polls an unauthenticated health path."
  }
}

run "waf_is_off_by_default_and_attachable" {
  command = plan

  assert {
    condition     = length(aws_wafv2_web_acl.main) == 0 && length(aws_wafv2_web_acl_association.main) == 0
    error_message = "WAF is optional and off."
  }
}

run "waf_attaches_when_enabled" {
  command = plan

  variables {
    enable_waf = true
  }

  assert {
    condition     = length(aws_wafv2_web_acl.main) == 1 && length(aws_wafv2_web_acl_association.main) == 1
    error_message = "Turning WAF on must create and attach exactly one web ACL."
  }
}

run "a_certificate_that_is_not_an_acm_arn_is_refused" {
  command = plan

  variables {
    certificate_arn = "self-signed"
  }

  expect_failures = [var.certificate_arn]
}
