variable "deployment_role_name" {
  description = <<-EOT
    IAM role Terraform assumes for this root: the same `fss-rh-deploy` a
    rehearsal run uses, whose policy is scoped to `fss-rh-*`. That scoping is
    what makes `fss-rh-api` and `fss-rh-worker` creatable here and makes a
    production repository unreachable from here, whatever this file says.
  EOT
  type        = string
  default     = "fss-rh-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-rh-") && !startswith(var.deployment_role_name, "fss-prod")
    error_message = "The rehearsal registry root assumes a role in the fss-rh- namespace."
  }
}

variable "assume_deployment_role" {
  description = <<-EOT
    Whether the provider assumes `deployment_role_name` before it calls AWS, or
    uses the credentials the caller already holds.

    This root's one apply is a workflow run
    (`.github/workflows/greenfield-rehearsal-registry.yml`,
    `docs/greenfield/infra-apply-runbook.md` 2.1) whose session already *is*
    `fss-rh-deploy`, so that workflow plans with
    `-var=assume_deployment_role=false`. Asking STS to assume the role the
    session already holds would need the role to trust itself, and its trust is
    the GitHub OIDC provider and the subject `repo:…:environment:rehearsal`
    alone (Appendix G 39).

    The default is true, as in the other two roots, so that acting without
    assuming anything is something a caller has to say rather than something
    that happens when a flag is forgotten. The workflow proves what its session
    is first, with `infra/scripts/rehearsal-caller-identity.sh`.
    `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  EOT
  type        = bool
  default     = true
}

