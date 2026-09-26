variable "assume_deployment_role" {
  description = <<-EOT
    Whether the provider assumes `deployment_role_name` before it calls AWS, or
    uses the credentials the caller already holds.

    This root's one apply was a workflow run (its workflow was deleted on
    26 September 2026; `docs/greenfield/infra-apply-runbook.md` 2.1) whose
    session already *was* `fss-rh-deploy`, so it planned with
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
