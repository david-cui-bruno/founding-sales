variable "founder_browser" {
  description = "Optional reviewed founder browser configuration. Null keeps production unchanged. Existing references only, never key material."
  type = object({
    origin             = optional(string, "https://sales.usecallie.com")
    clientVersion      = string
    founderWorkspaceId = string
    founderUserId      = string
    cookieKeySecretArn = string
    certificateArn     = optional(string)
  })
  default = null
}

output "founder_browser" {
  description = "Configured browser origin/callback only, not evidence of target readiness."
  value       = module.stack.founder_browser
}
