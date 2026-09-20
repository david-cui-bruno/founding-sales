output "instance_identifier" {
  description = "RDS instance identifier."
  value       = aws_db_instance.main.identifier
}

output "instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.main.arn
}

output "endpoint" {
  description = "Host and port for application connections."
  value       = aws_db_instance.main.endpoint
}

output "address" {
  description = "Instance hostname."
  value       = aws_db_instance.main.address
}

output "port" {
  description = "PostgreSQL port."
  value       = aws_db_instance.main.port
}

output "database_name" {
  description = "Initial database name."
  value       = aws_db_instance.main.db_name
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed master user secret. Terraform never reads or writes its value."
  value       = one(aws_db_instance.main.master_user_secret[*].secret_arn)
}

output "kms_key_arn" {
  description = "Customer key protecting storage, snapshots, exported logs and the master user secret."
  value       = aws_kms_key.database.arn
}

output "backup_retention_days" {
  description = "Automated backup retention, which is also the point-in-time recovery window."
  value       = aws_db_instance.main.backup_retention_period
}

output "subnet_group_name" {
  description = "Private subnet group name."
  value       = aws_db_subnet_group.main.name
}

output "parameter_group_name" {
  description = "Parameter group name."
  value       = aws_db_parameter_group.main.name
}
