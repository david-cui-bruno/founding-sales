output "raw_mail_bucket" {
  description = "Bucket where SES stores raw inbound MIME messages."
  value       = aws_s3_bucket.raw_mail.bucket
}

output "inbox_bucket" {
  description = "SourceEvent inbox bucket the Mac app polls."
  value       = aws_s3_bucket.inbox.bucket
}

output "ses_receipt_rule_set" {
  description = "SES receipt rule set name. Must be activated manually (see README)."
  value       = aws_ses_receipt_rule_set.inbound.rule_set_name
}

output "ses_inbound_domain" {
  description = "SES inbound domain identity."
  value       = aws_ses_domain_identity.inbound.domain
}

output "mail_parse_lambda_name" {
  description = "Name of the mail-parse Lambda function."
  value       = aws_lambda_function.mail_parse.function_name
}

output "app_inbox_user_name" {
  description = "IAM user for the Mac app inbox poller. Access key is created manually, never in TF state."
  value       = aws_iam_user.app_inbox.name
}

output "dynamodb_table_names" {
  description = "All DynamoDB tables in the sourcing stack."
  value = {
    idempotency = aws_dynamodb_table.idempotency.name
    snapshots   = aws_dynamodb_table.snapshots.name
    entities    = aws_dynamodb_table.entities.name
    suppression = aws_dynamodb_table.suppression.name
    outcomes    = aws_dynamodb_table.outcomes.name
  }
}
