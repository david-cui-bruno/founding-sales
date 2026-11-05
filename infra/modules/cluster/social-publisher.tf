variable "social_publisher_runtime_ready" {
  description = "Buffer credential encryption key is populated and public media ingress is configured; inject into API/worker only, never publication consent."
  type        = bool
  default     = false
}
