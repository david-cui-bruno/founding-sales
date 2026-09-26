# FSS greenfield edge: the only inbound path to the API tasks.
#
# There is no port 80 listener. The ALB security group admits 443 only, so a
# redirect listener would be unreachable anyway; leaving it out means there is
# no plaintext endpoint to misconfigure. Clients that try http:// get a
# connection refusal instead of a redirect, which is the fail-closed choice.
#
# Access logs go to their own bucket with their own lifecycle, retained
# independently of the application log groups.

locals {
  access_log_bucket = "${var.name_prefix}-alb-logs-${var.aws_account_id}"
  access_log_prefix = "alb"

  # The log delivery service principal covers regions enabled after August 2022
  # and, since the 2023 change, the older regions too. elb_account_id is kept
  # as an escape hatch for a region that still delivers as the ELB account.
  elb_account_arns = var.elb_account_id == "" ? [] : ["arn:aws:iam::${var.elb_account_id}:root"]

  log_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "AllowLogDeliveryServicePrincipal"
          Effect    = "Allow"
          Principal = { Service = ["logdelivery.elasticloadbalancing.amazonaws.com"] }
          Action    = ["s3:PutObject"]
          Resource  = ["arn:aws:s3:::${local.access_log_bucket}/${local.access_log_prefix}/AWSLogs/${var.aws_account_id}/*"]
          Condition = {
            StringEquals = { "s3:x-amz-acl" = ["bucket-owner-full-control"] }
          }
        },
        {
          Sid       = "DenyUnencryptedTransport"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:*"]
          Resource = [
            "arn:aws:s3:::${local.access_log_bucket}",
            "arn:aws:s3:::${local.access_log_bucket}/*",
          ]
          Condition = { Bool = { "aws:SecureTransport" = ["false"] } }
        },
      ],
      length(local.elb_account_arns) == 0 ? [] : [
        {
          Sid       = "AllowRegionalElbAccount"
          Effect    = "Allow"
          Principal = { AWS = local.elb_account_arns }
          Action    = ["s3:PutObject"]
          Resource  = ["arn:aws:s3:::${local.access_log_bucket}/${local.access_log_prefix}/AWSLogs/${var.aws_account_id}/*"]
        },
      ],
    )
  }
}

resource "aws_s3_bucket" "access_logs" {
  bucket        = local.access_log_bucket
  force_destroy = var.force_destroy_logs

  tags = merge(var.tags, { Name = local.access_log_bucket })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Access logs are delivered SSE-S3. Elastic Load Balancing cannot deliver
# access logs to a bucket whose default encryption is a customer KMS key.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.access_logs]
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = jsonencode(local.log_policy)

  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = var.security_group_ids

  idle_timeout                     = var.idle_timeout_seconds
  enable_deletion_protection       = var.enable_deletion_protection
  drop_invalid_header_fields       = true
  enable_cross_zone_load_balancing = true
  desync_mitigation_mode           = "strictest"
  xff_header_processing_mode       = "append"
  preserve_host_header             = true

  access_logs {
    bucket  = aws_s3_bucket.access_logs.id
    prefix  = local.access_log_prefix
    enabled = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb" })

  depends_on = [aws_s3_bucket_policy.access_logs]
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = 30

  # `/readyz` by default (lane g81): 200 only when this task can serve, 503 when it
  # is alive and must not. The matcher is 200 alone, so the 503 is unhealthy. Two
  # passes fifteen seconds apart put a new task in service in about thirty seconds,
  # inside the service's sixty-second grace; three failures take it out in
  # forty-five. docs/archive/decisions/g81-the-load-balancer-asks-readiness.md.
  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  stickiness {
    enabled = false
    type    = "lb_cookie"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-https" })
}

# ---------------------------------------------------------------------------
# Optional WAF, off by default.
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "main" {
  count = var.enable_waf ? 1 : 0

  name  = "${var.name_prefix}-api"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_five_minutes
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-api"
    sampled_requests_enabled   = false
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

resource "aws_wafv2_web_acl_association" "main" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}
