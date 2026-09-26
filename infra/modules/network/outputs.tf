output "vpc_id" {
  description = "VPC identifier."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC IPv4 CIDR block."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "The two public subnets that carry the Fargate tasks and the load balancer."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "The two private subnets that carry RDS."
  value       = aws_subnet.private[*].id
}

output "security_group_ids" {
  description = "Security group identifiers keyed by role."
  value       = { for name, group in aws_security_group.this : name => group.id }
}

output "ingress_rules" {
  description = "The declared ingress inventory. Every ingress rule resource is generated from it."
  value       = local.ingress_rules
}

output "egress_rules" {
  description = "The declared egress inventory. Every egress rule resource is generated from it."
  value       = local.egress_rules
}
