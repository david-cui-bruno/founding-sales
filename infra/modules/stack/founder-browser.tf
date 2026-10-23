variable "founder_browser" {
  description = "Optional founder host on the existing API. Null disables it. Supply existing secret/certificate references only. The proposed default origin is not evidence of DNS/certificate availability."
  type = object({
    origin             = optional(string, "https://sales.usecallie.com")
    clientVersion      = string
    founderWorkspaceId = string
    founderUserId      = string
    cookieKeySecretArn = string
    certificateArn     = optional(string)
  })
  default = null

  validation {
    condition = var.founder_browser == null ? true : (
      can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$", var.founder_browser.origin)) &&
      can(regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", var.founder_browser.clientVersion)) &&
      alltrue([for id in [var.founder_browser.founderWorkspaceId, var.founder_browser.founderUserId] : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))]) &&
      can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.founder_browser.cookieKeySecretArn))
    )
    error_message = "Enabled founder_browser requires an exact HTTPS origin, numeric client version, canonical lowercase UUIDs and an existing whole-secret ARN."
  }
}

output "founder_browser" {
  description = "Non-secret browser routing metadata only. Null is disabled, not staged or activated."
  value = var.founder_browser == null ? null : {
    origin      = var.founder_browser.origin
    callbackUri = "${var.founder_browser.origin}/browser/callback"
  }
}
