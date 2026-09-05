data "archive_file" "schedule_watchdog" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/schedule-watchdog/dist"
  output_path = "${path.module}/.build/schedule-watchdog.zip"
}

resource "aws_lambda_function" "schedule_watchdog" {
  function_name = "${var.name_prefix}-schedule-watchdog"
  role          = aws_iam_role.lambda_schedule_watchdog.arn

  filename         = data.archive_file.schedule_watchdog.output_path
  source_code_hash = data.archive_file.schedule_watchdog.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60
}

resource "aws_cloudwatch_log_group" "schedule_watchdog" {
  name              = "/aws/lambda/${aws_lambda_function.schedule_watchdog.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "schedule_watchdog" {
  name                = "${var.name_prefix}-schedule-watchdog-schedule"
  schedule_expression = "cron(0 18 * * ? *)"
  state               = var.schedules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "schedule_watchdog" {
  rule = aws_cloudwatch_event_rule.schedule_watchdog.name
  arn  = aws_lambda_function.schedule_watchdog.arn
}

resource "aws_lambda_permission" "schedule_watchdog_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule_watchdog.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule_watchdog.arn
}
