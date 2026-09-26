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

variable "deployment_role_name" {
  description = <<-EOT
    IAM role Terraform assumes for this run. Its policy is scoped to the
    fss-rh-* namespace, so even a mistaken destroy has no permission to touch
    a production resource. Production and rehearsal never share a role.
  EOT
  type        = string
  default     = "fss-rh-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-rh-") && !startswith(var.deployment_role_name, "fss-prod")
    error_message = "The rehearsal deployment role must live in the fss-rh- namespace."
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
    `infra/scripts/rehearsal-teardown.sh` pass
    `-var="assume_deployment_role=false"`.

    The default is nevertheless **true**, like production's. A default of false
    would be a root that silently acts as whatever credential happens to be in
    the environment; with the default as it is, a caller who does not say
    otherwise is refused `sts:AssumeRole`, and that refusal is the boundary
    working rather than a fault. The workflows that pass false prove what the
    session is first, with `infra/scripts/rehearsal-caller-identity.sh`, which
    refuses any identity that is not an assumed-role session of
    `fss-rh-deploy`.
    `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  EOT
  type        = bool
  default     = true
}

variable "availability_zones" {
  description = "Exactly two availability zones. Both subnets pairs are spread across them even when the database is single-AZ."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block. A rehearsal run may use a different range from production."
  type        = string
  default     = "10.70.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Two CIDR blocks for the public task subnets."
  type        = list(string)
  default     = ["10.70.0.0/20", "10.70.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Two CIDR blocks for the private database subnets."
  type        = list(string)
  default     = ["10.70.128.0/20", "10.70.144.0/20"]
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

variable "database_multi_az" {
  description = <<-EOT
    Multi-AZ, like production. G1 defaulted this to false on the reasoning that
    a rehearsal may be small; G12c changes the default because Appendix E step
    1 is a point-in-time restore of a *Multi-AZ* instance and that step is what
    the 180-minute workflow timeout is a guess about. A single-AZ rehearsal
    measures a restore production will never perform.

    The variable stays, and false is still accepted: a run investigating
    something unrelated to recovery can be cheaper by saying so.
  EOT
  type        = bool
  default     = true
}

variable "database_instance_class" {
  description = <<-EOT
    The same class as production, `db.t4g.small`. A rehearsal on `db.t4g.micro`
    would deploy production's digests onto a machine production never uses and
    report a recovery point objective nobody can act on.
  EOT
  type        = string
  default     = "db.t4g.small"
}

variable "database_allocated_storage" {
  description = "Provisioned gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "database_backup_retention_days" {
  description = <<-EOT
    Backup retention for the rehearsal database. One day is enough to exercise
    the restore drill; the drill restores to a point inside the run.
  EOT
  type        = number
  default     = 1
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task. Production's 0.5 vCPU, because the rehearsal runs the same image under the same limits."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task. Production's 1 GiB: a rehearsal that never reached the production memory limit could not observe an OOM production would."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task. Production's 0.5 vCPU."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task. Production's 1 GiB."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = <<-EOT
    X86_64 or ARM64, and the answer is ARM64, the same as production's: the
    rehearsal deploys the exact digests proposed for production and those are
    `linux/arm64` manifests. A rehearsal on the other architecture would not
    start at all, which is the cheapest possible failure and still the wrong
    one to discover from a stuck deployment rather than from a plan.
  EOT
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be exactly X86_64 or ARM64. ECS takes the uppercase enum, not Docker's linux/arm64 spelling."
  }
}

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Number of worker tasks."
  type        = number
  default     = 1
}

variable "dependencies_mode" {
  description = <<-EOT
    `FSS_DEPENDENCIES` on both task definitions, and the rehearsal default is
    `live`, the same as production's.

    That is deliberate and it is a change of mind worth stating: an earlier
    reading of this lane's brief had the rehearsal default to `recorded`. G12b
    made Google sign-in a start-up requirement, and the rehearsal signs in with
    the *real* OIDC client under its second registered redirect URI
    (`api.rehearsal.usecallie.com`), so a `recorded` deployment would not be
    rehearsing the path production runs. The one step that wants the recorded
    Gmail fake — the journal replay and Sent reconstruction, where no real
    rehearsal mailbox exists — sets `FSS_DEPENDENCIES: recorded` on its own
    workflow step, which is the fake being chosen by name.

    A run against a rehearsal-only Google project can still apply with
    `recorded`; it is one `-var` and the isolation test asserts it works.
  EOT
  type        = string
  default     = "live"

  validation {
    condition     = contains(["live", "recorded"], var.dependencies_mode)
    error_message = "dependencies_mode must be live or recorded. none is the laptop value and a deployed process never reaches its no-op dependencies."
  }
}

variable "sending_enabled" {
  description = <<-EOT
    `FSS_SENDING_ENABLED` on both rehearsal task definitions. Always false, and
    nothing in the release workflow passes it: a rehearsal that could send would
    send to whatever addresses the fixtures hold.
  EOT
  type        = bool
  default     = false
}

variable "expected_system_generation" {
  description = <<-EOT
    Appendix E step 1: the generation the API and worker services expect the
    database to report, as FSS_EXPECTED_SYSTEM_GENERATION. Null: unpinned,
    and the worker makes no generation check.
    Nothing in the release workflow sets it. The restore drill pins its own
    one-off task instead (`fss drill --expected-generation`), because the
    rehearsal's services run against the source database, not the restored
    copy.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.expected_system_generation == null ? true : (var.expected_system_generation >= 1 && floor(var.expected_system_generation) == var.expected_system_generation)
    error_message = "expected_system_generation is a positive whole number, or null for unpinned. The bootstraps refuse anything else at startup."
  }
}

variable "alert_emails" {
  description = "Addresses that receive rehearsal alerts."
  type        = list(string)
  default     = []
}

variable "journal_object_lock_retention_days" {
  description = <<-EOT
    Object lock retention for the rehearsal journal. One day, because an
    object-locked object refuses deletion until its retention expires and a
    rehearsal environment has to be able to disappear. Governance mode plus a
    one-day retention keeps the replay test honest without leaving a bucket
    that cannot be removed.
  EOT
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "Rehearsal log retention. Short, because the run is short."
  type        = number
  default     = 7
}

variable "business_time_zone" {
  description = "Workspace business zone for the Today snapshot date."
  type        = string
  default     = "America/New_York"
}

variable "google_hosted_domain" {
  description = <<-EOT
    The Callie Google Workspace domain, the same one production uses: the
    rehearsal signs in with the same OIDC client under its second registered
    redirect URI (api.rehearsal.usecallie.com). A public identifier.
  EOT
  type        = string
  default     = "usecallie.com"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.google_hosted_domain))
    error_message = "google_hosted_domain must be a domain name and may not be empty."
  }
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

variable "gmail_push_path" {
  description = "Path on the API that a push notification would be delivered to. The same route in every environment; the audience below is built from it."
  type        = string
  default     = "/integrations/gmail/push"

  validation {
    condition     = startswith(var.gmail_push_path, "/")
    error_message = "The push path is a path on the API, beginning with a slash."
  }
}

variable "gmail_push_topic" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_TOPIC` on both rehearsal task definitions.

    A public identifier naming a Google Cloud project that does not exist, and
    that is the point: a rehearsal registers no Gmail watch, so nothing ever
    names this topic to Google. It is well-formed
    (`projects/<project>/topics/<name>`, which is what `users.watch` takes) so
    that a rehearsal exercises the same parsing production will, and it is
    obviously not a real project so that nobody reads a rehearsal log as
    evidence that push works. Spec 16.2's Gmail path is proved in production,
    never here: `docs/archive/decisions/g12-what-the-rehearsal-cannot-prove.md`.
  EOT
  type        = string
  default     = "projects/fss-rehearsal-no-push/topics/fss-rehearsal-no-push"
}

variable "gmail_push_service_account" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` on both rehearsal task definitions: the one
    address whose push token the webhook would accept.

    The default is in the reserved `.invalid` domain rather than the
    `iam.gserviceaccount.com` one, because no such identity exists and Google
    cannot mint a token for it. A rehearsal that needed a real one would be a
    rehearsal with its own Google project, which is not a thing this design has.
  EOT
  type        = string
  default     = "gmail-push@fss-rehearsal-no-push.invalid"
}

variable "bootstrap" {
  description = <<-EOT
    True for a rehearsal run, always, because every rehearsal environment is a
    fresh one: the apply creates it, and its database has no schema until the
    migration task has run. The release workflow passes `true` and then scales
    through `infra/scripts/release-deploy.sh`.

    It is a variable rather than a literal so that the rehearsal and production
    roots take the same input and the shared deploy script has one code path.
  EOT
  type        = bool
  default     = true
}
