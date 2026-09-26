output "load_balancer_dns_name" {
  description = "Load balancer hostname. The API DNS record is an alias to this."
  value       = aws_lb.main.dns_name
}

output "load_balancer_zone_id" {
  description = "Hosted zone id for the alias record."
  value       = aws_lb.main.zone_id
}

output "target_group_arn" {
  description = "Target group the API service registers with."
  value       = aws_lb_target_group.api.arn
}

output "access_log_bucket" {
  description = "Bucket holding load-balancer access logs."
  value       = aws_s3_bucket.access_logs.bucket
}
