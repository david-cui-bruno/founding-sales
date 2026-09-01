# ---------------------------------------------------------------------------
# mail-parse Lambda (placeholder).
#
# The real parser will come later. For now this packages the minimal stub in
# cloud/lambdas/mail-parse/dist/. Build the bundle BEFORE terraform plan/apply:
#
#   cd cloud/lambdas/mail-parse
#   PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm install
#   PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run build
#
# The archive provider zips dist/ at plan time, so the bundle must exist.
# ---------------------------------------------------------------------------

data "archive_file" "mail_parse" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/mail-parse/dist"
  output_path = "${path.module}/.build/mail-parse.zip"
}

resource "aws_lambda_function" "mail_parse" {
  function_name = "${var.name_prefix}-mail-parse"
  role          = aws_iam_role.lambda_mail_parse.arn

  filename         = data.archive_file.mail_parse.output_path
  source_code_hash = data.archive_file.mail_parse.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  architectures = ["arm64"]

  memory_size = 256
  timeout     = 30

  environment {
    variables = {
      RAW_MAIL_BUCKET   = aws_s3_bucket.raw_mail.bucket
      INBOX_BUCKET      = aws_s3_bucket.inbox.bucket
      IDEMPOTENCY_TABLE = aws_dynamodb_table.idempotency.name
      # Hot-lead push topic. Long random value provisioned in SSM
      # (/callie-sourcing/ntfy-topic); injected from tfvars to avoid a
      # data-source read of a SecureString into state on every plan.
      NTFY_TOPIC = var.ntfy_topic
    }
  }
}

# Keep log retention bounded in the shared account.
resource "aws_cloudwatch_log_group" "mail_parse" {
  name              = "/aws/lambda/${aws_lambda_function.mail_parse.function_name}"
  retention_in_days = 30
}
