variable "social_publisher_host" {
  description = "Retained recovery host, native ARM64 AMI and independently pinned accepted immutable API image. Null explicitly retires it."
  type        = object({ ami_id = string, image = string })
  default     = null
}
variable "social_publisher_runtime_ready" {
  description = "Buffer credential encryption key and canonical public media ingress are configured. Never owner publication consent."
  type        = bool
  default     = false
}
output "social_publisher_instance_id" {
  description = "Isolated managed browser host; null when not provisioned."
  value       = module.stack.social_publisher_instance_id
}
