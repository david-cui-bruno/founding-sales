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

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 2
}

variable "target_group_arn" {
  description = "ALB target group the API service registers with."
  type        = string
}

variable "api_log_group_name" {
  description = "CloudWatch log group for API containers."
  type        = string
}

variable "worker_log_group_name" {
  description = "CloudWatch log group for worker containers."
  type        = string
}

variable "environment" {
  description = "Non-secret environment variables added to both tasks. Never put a credential here."
  type        = map(string)
  default     = {}
}

variable "api_environment" {
  description = "Non-secret environment variables for the API task only."
  type        = map(string)
  default     = {}
}

variable "worker_environment" {
  description = "Non-secret environment variables for the worker task only. The operations task shares the worker's environment, by construction, and ignores what it does not read."
  type        = map(string)
  default     = {}
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

variable "call_audio_bucket_arn" {
  description = "The call-audio bucket's ARN (infra/modules/recordings, slice C3a). The worker task role may put, get and delete objects under calls/ and nothing else in it."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.call_audio_bucket_arn))
    error_message = "call_audio_bucket_arn is an S3 bucket ARN."
  }
}

variable "aws_account_id" {
  description = "The account the Transcribe jobs run in: the worker task role's Get and Delete name them by ARN (slice C3a)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
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

variable "worker_reads_classifier_key" {
  description = <<-EOT
    Whether the worker task definition is handed the reply classifier's provider
    key, as FSS_LLM_CLASSIFIER_API_KEY (lane g81).

    The classifier has no recorded seam: a worker that holds a key calls the
    provider with it. A rehearsal fills the entry with a fixture, so a rehearsal
    worker handed it would send its fixture replies to the provider under a key
    that cannot work and fail every classify.reply. Production sets it; everywhere
    else classify.reply stays unclaimed, which is what a worker with no key does.
  EOT
  type        = bool
  default     = false
}

variable "worker_model_transport" {
  description = <<-EOT
    How the worker sends its Claude calls (slice BR1): "anthropic" (the direct API, with
    the classifier key) or "bedrock" (Amazon Bedrock, with the worker task role, paid from
    the account's credits). "bedrock" sets FSS_MODEL_TRANSPORT on the worker and grants
    its task role bedrock:InvokeModel on the US inference profiles the code maps
    (`packages/domain/classification/modelTransport.ts`), on the foundation models they
    route to only through those profiles, and bedrock:CountTokens on the counted model.
    "anthropic" grants nothing and sets nothing, so the worker keeps its old default.
  EOT
  type        = string
  default     = "anthropic"

  validation {
    condition     = contains(["anthropic", "bedrock"], var.worker_model_transport)
    error_message = "worker_model_transport is anthropic or bedrock."
  }
}

variable "metric_namespace" {
  description = "CloudWatch namespace the applications publish counters and heartbeats to, and the only one their task roles may publish into. FSS/<name_prefix>, derived once in infra/modules/stack. No default: the bare FSS namespace was shared by every environment in the account (g42)."
  type        = string

  validation {
    condition     = can(regex("^FSS/[a-z][a-z0-9-]{2,31}$", var.metric_namespace))
    error_message = "metric_namespace must be FSS/<name_prefix>, one namespace per environment. The bare FSS namespace is shared by every environment in the account, so a rehearsal publishing there feeds production's alarms."
  }
}

variable "bootstrap" {
  description = <<-EOT
    True on the first apply of a fresh environment. Both services are then
    created at desired count zero and `infra/scripts/deploy.sh release` scales
    them after the migration task and `fss verify` have succeeded, worker
    before API.

    The declared counts are left alone: a bootstrap changes what the services
    *are* right now, not what they are for, and `output.deployment_plan`
    reports both so the script's scale-up target is the root's own number
    rather than a literal in a shell file.

    It decides the count a service is *created* at and nothing after that.
    Both services carry `ignore_changes = [desired_count]` (lane g70), so a
    later apply, with this true or false, replaces task definitions and leaves
    the running count to `infra/scripts/stop.sh` and
    `infra/scripts/deploy.sh release`. Until 25 September there was no
    `ignore_changes`, so that Terraform could scale to zero for a schema
    release; in practice the apply repointed the running services at the new
    task definitions before anything stopped them, which is the defect the
    change closes (`docs/greenfield/release.md` 8.0af).
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}

variable "social_assets_bucket_arn" {
  description = "Private social originals and derivatives; separate from expiring recordings."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.social_assets_bucket_arn == null ? true : can(regex("^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.social_assets_bucket_arn))
    error_message = "Expected an S3 bucket ARN."
  }
}

variable "enable_social_assets" {
  type    = bool
  default = false
}
