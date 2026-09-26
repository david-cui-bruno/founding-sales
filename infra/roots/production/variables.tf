variable "assume_deployment_role" {
  description = <<-EOT
    Whether the provider assumes `deployment_role_name` before it calls AWS, or
    uses the credentials the caller already holds.

    True, and it stays true by default in all three roots. Section 3.2 of
    `docs/greenfield/infra-apply-runbook.md` is a local apply: David's user
    assumes `fss-prod-deploy`, and the provider is what does the assuming.
    Defaulting to false would mean that a caller who forgot the flag acted as
    whatever ambient credential the shell was holding, which is exactly the
    failure this flag exists to avoid making possible.

    False is for a session that *is already* the deployment role: a CI job that
    obtained it through GitHub OIDC with
    `aws-actions/configure-aws-credentials`. Assuming it again would be role
    chaining onto the same role, which needs the role to trust itself; the
    rehearsal role's trust is the GitHub OIDC provider and the subject
    `repo:…:environment:rehearsal` alone (Appendix G 39), so the second
    assumption is refused and must stay refused. Only the two rehearsal
    workflows pass false, and each proves what it is first with
    `infra/scripts/rehearsal-caller-identity.sh`.

    The flag chooses a credential path and never a plan:
    `infra/roots/*/tests/*.tftest.hcl` assert the same names and the same
    outputs with it on and off.
    `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  EOT
  type        = bool
  default     = true
}

variable "api_image" {
  description = "Immutable API image digest that passed the rehearsal gate."
  type        = string
}

variable "worker_image" {
  description = "Immutable worker image digest that passed the rehearsal gate."
  type        = string
}

variable "api_schema_range" {
  description = "Inclusive schema versions the API binary accepts."
  type = object({
    min = number
    max = number
  })
}

variable "worker_schema_range" {
  description = "Inclusive schema versions the worker binary accepts."
  type = object({
    min = number
    max = number
  })
}

variable "active_database_host" {
  description = <<-EOT
    FSS_DATABASE_HOST on the api, worker, migration and operations task
    definitions: the host the API, the worker and the fss tool connect to in
    place of the host inside their database secret. Null, the default and
    production's normal state, means the managed instance's address.

    Set only by the restore runbook (docs/greenfield/runbooks/restore.md), to
    the address of the point-in-time copy production runs on while the managed
    instance is being replaced, and returned to null when it has been. Setting
    it changes those four task definitions and nothing else.
  EOT
  type        = string
  default     = null
  nullable    = true

  # Repeated from the stack module deliberately: a refusal should name the
  # variable the operator typed, not one two modules down.
  validation {
    condition     = var.active_database_host == null ? true : can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.active_database_host))
    error_message = "active_database_host is null or a lower-case DNS hostname with at least one dot, such as a restored instance's endpoint address: no scheme, no port, no path."
  }
}

variable "journal_administrative_principal_arns" {
  description = <<-EOT
    IAM role ARNs exempted from every `Deny` in the production suppression
    journal's bucket policy except the transport one. **Empty, and it stays
    empty until David says otherwise.**

    The rehearsal root passes its own deployment role, because a rehearsal
    environment has to be able to disappear. Production is the opposite case:
    decision 4 of 21 September 2026 is GOVERNANCE mode with a ten-year
    retention, and removing the journal is an act of the account root rather
    than something a release could do by mistake. The variable exists so that
    the opt-in is one `-var` and a line in a plan David reads, not a change to
    a module. `docs/archive/decisions/g16-the-journal-deny-exempts-its-deployer.md`.

    The production deployment role is separately denied `s3:GetObject*` and
    `s3:BypassGovernanceRetention` by its own policy
    (`infra/policies/deployment-role-policy.json.tftpl`), so naming it here
    would not on its own let it empty the bucket either.
  EOT
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Gmail push, without a Google provider (lane g85, audit O01).
#
# `enable_gmail_push`, `gcp_project_id` and `gcp_region` are gone, with the
# provider they configured. `infra/roots/production-google` owns the topic, the
# subscription, the push service account and Gmail's publisher grant, and is
# planned only when one of them changes. What remains here is what the two task
# definitions carry: the audience, derived below from this root's own hostname,
# and two public identifiers, committed as defaults because `infra/.gitignore`
# keeps every tfvars file out of the repository
# (`docs/archive/decisions/g12c-the-topology-answers-are-root-defaults.md`). Passing
# `-var="gcp_project_id=…"` to this root is now an "undeclared variable" error.
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`.
# ---------------------------------------------------------------------------

variable "bootstrap" {
  description = <<-EOT
    True for the first apply of a brand-new production environment, and false
    for every apply afterwards (G12h; the decision record of 21 September).

    A fresh environment has an empty database, and both binaries refuse to
    start unless the applied schema version is exactly the range they declare.
    So the first apply creates both services at desired count zero and
    `infra/scripts/release-deploy.sh infra/roots/production fss-prod` scales
    them — worker, then API — after the migration task and `fss verify` have
    both succeeded.

    It decides the count the services are created at and nothing after that:
    both services ignore later changes to `desired_count` (lane g70), so
    passing `true` to a running environment no longer scales it, and it is
    still never what an ordinary release wants. A schema release stops the
    services with `infra/scripts/release-stop.sh ... --environment production`
    before the apply, and `release-deploy.sh --schema-change` restores the
    declared counts after the migration.
  EOT
  type        = bool
  default     = false
}

variable "desktop_upgrade_url" {
  description = <<-EOT
    `FSS_DESKTOP_UPGRADE_URL` on the API task definition alone: the `upgradeUrl`
    that `/auth/client-version` publishes to a Mac below the minimum client
    version (5.3). It is machine-facing — the signed update manifest on this
    stack's updates distribution, `releases/darwin-arm64/latest.json`, which
    the desktop reads and, since lane g83, installs from by itself. The
    desktop's upgrade screen shows a sentence and never this address.

    A default rather than a tfvars entry: `infra/.gitignore` ignores `*.tfvars`,
    so a value written there is one the repository never sees. The validation
    refuses a blank, anything but a plain https address,
    and the `callie.example` placeholder the API publishes outside production;
    the API refuses to start in production without a value, so both lines hold.
    `docs/archive/decisions/g86-the-upgrade-notice-names-the-update-channel.md`.
  EOT
  type        = string
  default     = "https://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json"
  nullable    = false

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$", var.desktop_upgrade_url)) && !strcontains(var.desktop_upgrade_url, "callie.example")
    error_message = "desktop_upgrade_url is a plain https address with no credentials, query or fragment, and never the callie.example placeholder: in production it is https://<updates distribution>/releases/darwin-arm64/latest.json."
  }
}
