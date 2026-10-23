variable "founder_browser" {
  description = "Optional synthetic founder browser configuration. Null keeps rehearsal unchanged. Use rehearsal-only existing secret/certificate references."
  type = object({
    origin             = optional(string, "https://app.usecallie.com")
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
