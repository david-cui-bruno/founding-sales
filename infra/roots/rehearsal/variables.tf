variable "name_prefix" {
  description = <<-EOT
    The rehearsal namespace for one run. It must be fss-rh-<run>. The
    validation below is the other half of the structural isolation: it refuses
    the production namespace outright, so no rehearsal apply and no rehearsal
    teardown can address a production resource.
  EOT
  type        = string
  default     = "fss-rh-default"

  validation {
    condition     = can(regex("^fss-rh-[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$", var.name_prefix))
    error_message = "A rehearsal namespace must be fss-rh-<run>, 3 to 18 lowercase characters after the prefix, not ending in a hyphen."
  }

  validation {
    condition     = var.name_prefix != "fss-prod" && !startswith(var.name_prefix, "fss-prod")
    error_message = "fss-prod is the production namespace. A rehearsal root may never take it."
  }
}

variable "assume_deployment_role" {
  description = <<-EOT
    Whether the provider assumes `deployment_role_name` before it calls AWS, or
    uses the credentials the caller already holds.

    Every apply of this root is a workflow run, and that run's session already
    *is* `fss-rh-deploy`: `aws-actions/configure-aws-credentials` assumed it
    through GitHub OIDC before Terraform started. Assuming it a second time is
    role chaining onto the same role, which needs the role to trust itself.
    It does not, and it must not: its trust is the OIDC provider and the subject
    `repo:…:environment:rehearsal` alone (Appendix G 39). So
    `.github/workflows/greenfield-release.yml` and
    `infra/scripts/rehearsal.sh teardown` pass
    `-var="assume_deployment_role=false"`.

    The default is nevertheless **true**, like production's. A default of false
    would be a root that silently acts as whatever credential happens to be in
    the environment; with the default as it is, a caller who does not say
    otherwise is refused `sts:AssumeRole`, and that refusal is the boundary
    working rather than a fault. The workflows that pass false prove what the
    session is first, with `infra/scripts/rehearsal.sh identity`, which
    refuses any identity that is not an assumed-role session of
    `fss-rh-deploy`.
    `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  EOT
  type        = bool
  default     = true
}

variable "certificate_arn" {
  description = "ACM certificate for the rehearsal API hostname."
  type        = string
}

variable "api_hostname" {
  description = "Rehearsal API hostname. Never the production hostname."
  type        = string
}

variable "api_image" {
  description = <<-EOT
    The exact immutable API digest proposed for production, pulled from the
    stable rehearsal repository `fss-rh-api` that
    `infra/roots/rehearsal-registry` owns. The digest is production's; the
    repository is not, because `fss-rh-deploy` may read nothing outside
    `fss-rh-*`.
  EOT
  type        = string

  validation {
    condition     = can(regex("/fss-rh-api@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be <registry>/fss-rh-api@sha256:<64 hex>. A rehearsal run pulls from the rehearsal repositories; the rehearsal role cannot read a production one."
  }
}

variable "worker_image" {
  description = "The exact immutable worker digest proposed for production, pulled from the stable `fss-rh-worker` repository."
  type        = string

  validation {
    condition     = can(regex("/fss-rh-worker@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be <registry>/fss-rh-worker@sha256:<64 hex>."
  }
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

# ---------------------------------------------------------------------------
# Gmail push, without a Google Cloud project.
#
# `enable_gmail_push`, `gcp_project_id` and `gcp_region` are gone. A rehearsal
# never creates a Pub/Sub topic: it has no project, it must never publish into
# production's, and the provider it required was refused
# application-default credentials in CI before the plan reached AWS.
#
# What remains is what the two task definitions carry. Both binaries read all
# three names with `required()` at start-up (`apps/api/src/bootstrap/deployment.ts`,
# `apps/worker/src/bootstrap/deployment.ts`), so an empty value is a task that
# refuses to start; these are the values that let a rehearsal environment boot.
# `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
# ---------------------------------------------------------------------------

variable "bootstrap" {
  description = <<-EOT
    True for a rehearsal run, always, because every rehearsal environment is a
    fresh one: the apply creates it, and its database has no schema until the
    migration task has run. The release workflow passes `true` and then scales
    through `infra/scripts/deploy.sh release`.

    It is a variable rather than a literal so that the rehearsal and production
    roots take the same input and the shared deploy script has one code path.
  EOT
  type        = bool
  default     = true
}
