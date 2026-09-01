# ---------------------------------------------------------------------------
# SES inbound receiving for in.usecallie.com.
#
# Notes:
# - Inbound receiving works while the account is in the SES sandbox.
#   Production access is only needed for OUTBOUND sending.
# - The receipt rule set is created here but SES only honours ONE active rule
#   set per account, and activating it is a mutation that can disrupt other
#   tenants of this shared account. There is an aws_ses_active_receipt_rule_set
#   resource, but we deliberately leave activation as a manual step:
#     aws ses set-active-receipt-rule-set --rule-set-name callie-sourcing-inbound
#   (Verify no other rule set is active first:
#     aws ses describe-active-receipt-rule-set)
# ---------------------------------------------------------------------------

# The usecallie.com hosted zone already exists in this account. Look it up,
# never create or manage it here.
data "aws_route53_zone" "root" {
  name         = var.root_domain
  private_zone = false
}

# Domain identity for the dedicated inbound subdomain.
resource "aws_ses_domain_identity" "inbound" {
  domain = var.inbound_mail_subdomain
}

# TXT record SES uses to verify domain ownership.
resource "aws_route53_record" "ses_verification" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = "_amazonses.${var.inbound_mail_subdomain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.inbound.verification_token]
}

resource "aws_ses_domain_identity_verification" "inbound" {
  domain     = aws_ses_domain_identity.inbound.domain
  depends_on = [aws_route53_record.ses_verification]
}

# MX record pointing the subdomain at the SES inbound SMTP endpoint.
resource "aws_route53_record" "inbound_mx" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.inbound_mail_subdomain
  type    = "MX"
  ttl     = 600
  records = ["10 inbound-smtp.${var.aws_region}.amazonaws.com"]
}

# ---------------------------------------------------------------------------
# Receipt rule set + rule for alerts@in.usecallie.com.
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = "${var.name_prefix}-inbound"
}

# MANUAL STEP after apply: this rule set must be made the account's active
# rule set before SES will evaluate it. Either uncomment the resource below
# (safe only if nothing else in this shared account uses SES receiving) or
# run the CLI command noted at the top of this file.
#
# resource "aws_ses_active_receipt_rule_set" "active" {
#   rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
# }

resource "aws_ses_receipt_rule" "alerts" {
  name          = "${var.name_prefix}-alerts"
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = [var.inbound_recipient]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  # Action 1: store the full MIME message in the raw-mail bucket.
  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.raw_mail.bucket
    object_key_prefix = "raw-mail/"
  }

  # Action 2: invoke the parse Lambda with the SES receipt event.
  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.mail_parse.arn
    invocation_type = "Event"
  }

  depends_on = [
    aws_s3_bucket_policy.raw_mail_allow_ses,
    aws_lambda_permission.allow_ses_invoke,
  ]
}

# ---------------------------------------------------------------------------
# Bucket policy allowing SES to put objects into the raw-mail bucket.
# SES sets aws:Referer to the receiving account id; scoping on it prevents
# other accounts' SES from writing here (legacy but documented SES pattern).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "raw_mail_allow_ses" {
  statement {
    sid    = "AllowSESPuts"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.raw_mail.arn}/raw-mail/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:Referer"
      values   = [var.aws_account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "raw_mail_allow_ses" {
  bucket = aws_s3_bucket.raw_mail.id
  policy = data.aws_iam_policy_document.raw_mail_allow_ses.json

  depends_on = [aws_s3_bucket_public_access_block.raw_mail]
}

# Allow SES to invoke the parse Lambda.
resource "aws_lambda_permission" "allow_ses_invoke" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.mail_parse.function_name
  principal      = "ses.amazonaws.com"
  source_account = var.aws_account_id
}
