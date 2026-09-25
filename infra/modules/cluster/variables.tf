variable "name_prefix" {
  description = "Namespace applied to every resource name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_region" {
  description = "Region, used for the awslogs driver configuration."
  type        = string
}

variable "subnet_ids" {
  description = "Public subnets. Tasks take public addresses because there is no NAT gateway."
  type        = list(string)
}

variable "api_security_group_ids" {
  description = "Security groups for the API service."
  type        = list(string)
}

variable "worker_security_group_ids" {
  description = "Security groups for the worker service."
  type        = list(string)
}

variable "api_image" {
  description = "Immutable API image reference. A digest is required; a tag is refused."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "The API image must be pinned to an immutable digest, for example repo@sha256:<64 hex>. A tag is not a deployment artifact."
  }
}

variable "worker_image" {
  description = "Immutable worker image reference. A digest is required; a tag is refused."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "The worker image must be pinned to an immutable digest, for example repo@sha256:<64 hex>. A tag is not a deployment artifact."
  }
}

variable "api_schema_range" {
  description = "Inclusive schema versions the API binary accepts. Published to the task as FSS_SCHEMA_MIN and FSS_SCHEMA_MAX for the expand-migrate-contract gate."
  type = object({
    min = number
    max = number
  })

  validation {
    condition     = var.api_schema_range.min >= 1 && var.api_schema_range.max >= var.api_schema_range.min
    error_message = "A schema range must be a positive, non-inverted interval."
  }
}

variable "worker_schema_range" {
  description = "Inclusive schema versions the worker binary accepts."
  type = object({
    min = number
    max = number
  })

  validation {
    condition     = var.worker_schema_range.min >= 1 && var.worker_schema_range.max >= var.worker_schema_range.min
    error_message = "A schema range must be a positive, non-inverted interval."
  }
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8080
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task. 1024 is one vCPU."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. ARM64 Fargate is cheaper but the image must be built for it."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Number of worker tasks. The scheduler pass serializes on a transaction advisory lock, so more than one is safe."
  type        = number
  default     = 1
}

variable "target_group_arn" {
  description = "ALB target group the API service registers with."
  type        = string
}

variable "health_check_grace_period_seconds" {
  description = "Seconds the API service ignores load-balancer health checks after a task starts."
  type        = number
  default     = 60
}

variable "api_log_group_name" {
  description = "CloudWatch log group for API containers."
  type        = string
}

variable "worker_log_group_name" {
  description = "CloudWatch log group for worker containers."
  type        = string
}

variable "api_health_check_command" {
  description = "Container-level health check for the API task."
  type        = list(string)
  default     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
}

variable "worker_health_check_command" {
  description = "Container-level health check for the worker task."
  type        = list(string)
  default     = ["CMD-SHELL", "node -e \"require('node:fs').statSync('/tmp/fss-worker-heartbeat')\""]
}

variable "environment" {
  description = "Non-secret environment variables added to both tasks. Never put a credential here."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.environment), "FSS_EXPECTED_SYSTEM_GENERATION")
    error_message = "FSS_EXPECTED_SYSTEM_GENERATION is set by expected_system_generation and nowhere else, so there is one control and a plan that shows it."
  }
}

variable "api_environment" {
  description = "Non-secret environment variables for the API task only."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.api_environment), "FSS_EXPECTED_SYSTEM_GENERATION")
    error_message = "FSS_EXPECTED_SYSTEM_GENERATION is set by expected_system_generation and nowhere else, so there is one control and a plan that shows it."
  }
}

variable "worker_environment" {
  description = "Non-secret environment variables for the worker task only."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.worker_environment), "FSS_EXPECTED_SYSTEM_GENERATION")
    error_message = "FSS_EXPECTED_SYSTEM_GENERATION is set by expected_system_generation and nowhere else, so there is one control and a plan that shows it."
  }
}

variable "expected_system_generation" {
  description = <<-EOT
    Appendix E step 1's operator-controlled expected generation, as
    FSS_EXPECTED_SYSTEM_GENERATION on the API and worker service task
    definitions. Null leaves both unpinned and the check unmade.

    The worker compares it with the database's `system_generation` at startup
    and, when they differ, opens one restore hold per workspace and logs the
    event RestoreGenerationMismatches counts; the API reports it on /readyz and
    /diagnostics. A restored copy carries its source's generation, so after a
    restore this is set to the restored copy's generation plus one, in the
    same apply as (or one before) whatever points the services at it — which
    is also the generation step 9 then advances the database to. The one-off
    task definitions do not carry it: `fss admin restore-holds open` and
    `fss drill` take the generation as a flag.
    docs/decisions/g56-restore-holds-are-opened-by-the-generation-check.md.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.expected_system_generation == null ? true : (var.expected_system_generation >= 1 && floor(var.expected_system_generation) == var.expected_system_generation)
    error_message = "expected_system_generation is a positive whole number, or null for unpinned. The bootstraps refuse anything else at startup."
  }
}

variable "secret_arns" {
  description = "Environment variable name to Secrets Manager ARN. Values are resolved by the execution role at task start; Terraform never sees them."
  type        = map(string)
  default     = {}
}

variable "app_runtime_database_secret_arn" {
  description = <<-EOT
    ARN of the Secrets Manager entry holding the `app_runtime` login user's
    credentials. Injected into both services as DATABASE_SECRET_ARN.

    It is not the RDS-managed master secret, and that is the point (G12h,
    David's condition of 21 September): the master user may perform DDL, so a
    service that could resolve it would hold DDL whatever else this module
    says. Terraform creates the entry empty; `fss admin database-users ensure`,
    running on the migration task, creates or alters the login user it names.
  EOT
  type        = string
}

variable "migration_database_secret_arn" {
  description = <<-EOT
    ARN of the Secrets Manager entry holding the credentials `fss migrate`
    connects with. Readable by the migration execution role and by nothing
    else in this module; `tests/migration_identity.tftest.hcl` asserts it.
  EOT
  type        = string
}

variable "journal_bucket_arn" {
  description = "Suppression journal bucket ARN. The API task role gets PutObject; both task roles get read for restore replay."
  type        = string
}

variable "journal_kms_key_arn" {
  description = "Customer key protecting journal objects."
  type        = string
}

variable "envelope_kms_key_arn" {
  description = "Customer key used to envelope-encrypt per-mailbox refresh tokens."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "Customer key protecting the Secrets Manager entries."
  type        = string
}

variable "drill_unwraps_recorded_envelopes" {
  description = <<-EOT
    Whether the drill task role may decrypt with the envelope key, and then only an
    envelope bound to the recorded seam's encryption context (lane g59).

    `fss drill` has to read the refresh token the drill-evidence seed stored in
    another task. Both run with FSS_DEPENDENCIES=recorded and wrap through the
    environment's envelope key with the context
    `fss_envelope_seam = recorded` (packages/domain/mail/envelopeKms.ts), so this
    grant is conditioned on that context: the drill identity can unwrap what a
    recorded seed wrapped and never a real mailbox's token, which a live process
    wraps without it. The rehearsal sets it; production does not, so production's
    plan shows no change and its drill role has no envelope grant at all.
  EOT
  type        = bool
  default     = false
}

variable "metric_namespace" {
  description = "CloudWatch namespace the applications publish counters and heartbeats to, and the only one their task roles may publish into. FSS/<name_prefix>, derived once in infra/modules/stack. No default: the bare FSS namespace was shared by every environment in the account (g42)."
  type        = string

  validation {
    condition     = can(regex("^FSS/[a-z][a-z0-9-]{2,31}$", var.metric_namespace))
    error_message = "metric_namespace must be FSS/<name_prefix>, one namespace per environment. The bare FSS namespace is shared by every environment in the account, so a rehearsal publishing there feeds production's alarms."
  }
}

variable "container_insights" {
  description = "enabled, enhanced or disabled. Container Insights is billed per metric."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["enabled", "enhanced", "disabled"], var.container_insights)
    error_message = "container_insights must be enabled, enhanced or disabled."
  }
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into a running task. Off in production; a rehearsal root may turn it on."
  type        = bool
  default     = false
}

variable "bootstrap" {
  description = <<-EOT
    True on the first apply of a fresh environment. Both services are then
    created at desired count zero and `infra/scripts/release-deploy.sh` scales
    them after the migration task and `fss verify` have succeeded, worker
    before API.

    The declared counts are left alone: a bootstrap changes what the services
    *are* right now, not what they are for, and `output.deployment_plan`
    reports both so the script's scale-up target is the root's own number
    rather than a literal in a shell file. There is deliberately no
    `ignore_changes` on `desired_count` — that would make the count untracked
    for ever and take away Terraform's ability to scale to zero for the next
    schema release.
  EOT
  type        = bool
  default     = false
}

variable "migration_cpu" {
  description = "Fargate CPU units for the one-off migration and operations tasks."
  type        = number
  default     = 512
}

variable "migration_memory" {
  description = "Fargate memory in MiB for the one-off migration and operations tasks."
  type        = number
  default     = 1024
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
