locals {
  name            = "${var.name_prefix}-social-publisher"
  repository_name = split("@", split(".amazonaws.com/", var.image)[1])[0]
  repository_arn  = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.repository_name}"
  log_group       = "/fss/${var.name_prefix}/social-publisher"
}

resource "aws_security_group" "browser" {
  name        = local.name
  description = "Browser control only from the existing TLS load balancer; no SSH or database ingress."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = local.name })
}
resource "aws_vpc_security_group_ingress_rule" "control" {
  security_group_id            = aws_security_group.browser.id
  referenced_security_group_id = var.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}
resource "aws_vpc_security_group_egress_rule" "alb_control" {
  security_group_id            = var.alb_security_group_id
  referenced_security_group_id = aws_security_group.browser.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.browser.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "dns" {
  for_each          = toset(["tcp", "udp"])
  security_group_id = aws_security_group.browser.id
  cidr_ipv4         = "169.254.169.253/32"
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
}

resource "aws_iam_role" "host" {
  name = local.name
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = merge(var.tags, { Name = local.name })
}
resource "aws_iam_role_policy_attachment" "management" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "runtime" {
  name = "browser-only-runtime"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = local.repository_arn },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.control_secret_arn },
      {
        Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.secrets_kms_key_arn,
        Condition = { StringEquals = {
          "kms:ViaService"                  = "secretsmanager.${var.aws_region}.amazonaws.com"
          "kms:EncryptionContext:SecretARN" = var.control_secret_arn
        } }
      },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.runtime.arn}:*" }
    ]
  })
}
resource "aws_iam_instance_profile" "host" {
  name = local.name
  role = aws_iam_role.host.name
  tags = merge(var.tags, { Name = local.name })
}
resource "aws_cloudwatch_log_group" "runtime" {
  name              = local.log_group
  retention_in_days = 14
  tags              = merge(var.tags, { Name = local.name })
}

resource "aws_instance" "browser" {
  ami                         = var.ami_id
  instance_type               = "t4g.small"
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.browser.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  user_data_replace_on_change = true
  volume_tags                 = merge(var.tags, { CalliePurpose = "social-publisher" })
  user_data_base64 = base64gzip(templatefile("${path.module}/bootstrap.sh.tftpl", {
    region             = var.aws_region
    image              = var.image
    registry           = split("/", var.image)[0]
    control_secret_arn = var.control_secret_arn
    log_group          = aws_cloudwatch_log_group.runtime.name
    seccomp_base64     = filebase64("${path.module}/seccomp.json")
  }))
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
  }
  credit_specification { cpu_credits = "standard" }
  lifecycle {
    precondition {
      condition     = startswith(var.image, "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/")
      error_message = "The browser image must belong to this environment's account and region."
    }
  }
  depends_on = [aws_iam_role_policy.runtime, aws_iam_role_policy_attachment.management]
  tags       = merge(var.tags, { Name = local.name, CalliePurpose = "social-publisher" })
}

resource "aws_lb_target_group" "browser" {
  name                 = "${var.name_prefix}-socpub"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = merge(var.tags, { Name = local.name })
}
resource "aws_lb_target_group_attachment" "browser" {
  target_group_arn = aws_lb_target_group.browser.arn
  target_id        = aws_instance.browser.id
  port             = 8080
}
resource "aws_lb_listener_rule" "browser" {
  listener_arn = var.listener_arn
  priority     = 40
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.browser.arn
  }
  condition {
    host_header { values = [var.browser_hostname] }
  }
  condition {
    path_pattern { values = ["/social/publisher-runtime/browser"] }
  }
  tags = merge(var.tags, { Name = local.name })
}

output "instance_id" { value = aws_instance.browser.id }
