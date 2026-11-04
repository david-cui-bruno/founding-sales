variable "social_publisher_host" {
  description = "Approved isolated browser host and pinned native ARM64 AMI. Null keeps it unprovisioned."
  type        = object({ ami_id = string })
  default     = null
}
variable "social_publisher_runtime_ready" {
  description = "Both dedicated credentials and the isolated authenticated native runtime have passed acceptance. Never owner publication consent."
  type        = bool
  default     = false
}
output "social_publisher_instance_id" {
  description = "Isolated managed browser host; null when not provisioned."
  value       = module.stack.social_publisher_instance_id
}
