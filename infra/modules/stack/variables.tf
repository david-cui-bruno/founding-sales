# ---------------------------------------------------------------------------
# Identity of the environment. These four decide every name and every
# destructive posture in the stack, and the guard in main.tf ties them
# together so a production root cannot be made destroyable and a rehearsal
# root cannot take a production name.
# ---------------------------------------------------------------------------

variable "environment" {
  description = "production or rehearsal. Each root hard-codes its own; it is not a deployment-time choice."
  type        = string

  validation {
    condition     = contains(["production", "rehearsal"], var.environment)
    error_message = "environment must be production or rehearsal."
  }
}

variable "name_prefix" {
  description = "Namespace for every resource. production is exactly fss-prod; rehearsal is fss-rh-<run>."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix)) && !endswith(var.name_prefix, "-")
    error_message = "name_prefix must be 3-25 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen."
  }
}

variable "destroyable" {
  description = "Turn off deletion protection and allow teardown. production hard-codes false."
  type        = bool
}

variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC."
  type        = string
  default     = "10.60.0.0/16"
}

variable "availability_zones" {
  description = "Exactly two availability zones."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "Two CIDR blocks for the public task subnets."
  type        = list(string)
  default     = ["10.60.0.0/20", "10.60.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Two CIDR blocks for the private database subnets."
  type        = list(string)
  default     = ["10.60.128.0/20", "10.60.144.0/20"]
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8080
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "database_multi_az" {
  description = "Multi-AZ standby. production hard-codes true."
  type        = bool
  default     = true
}

variable "database_allocated_storage" {
  description = "Provisioned gp3 storage in GiB."
  type        = number
  default     = 50
}

variable "database_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 200
}

variable "database_backup_retention_days" {
  description = "Automated backup retention, which is also the point-in-time recovery window."
  type        = number
  default     = 35
}

variable "database_performance_insights_enabled" {
  description = "Performance Insights, billed beyond the free retention."
  type        = bool
  default     = false
}

variable "database_log_min_duration_statement" {
  description = "Milliseconds above which a statement is logged."
  type        = number
  default     = 1000
}

variable "database_apply_immediately" {
  description = "Apply modifications outside the maintenance window."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

variable "api_image" {
  description = "Immutable API image digest."
  type        = string
}

variable "worker_image" {
  description = "Immutable worker image digest."
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

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
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
  description = "X86_64 or ARM64."
  type        = string
  default     = "X86_64"
}

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Number of worker tasks."
  type        = number
  default     = 1
}

variable "bootstrap" {
  description = <<-EOT
    True on the first apply of a fresh environment: both services are created
    at desired count zero and `infra/scripts/release-deploy.sh` scales them
    after the migration task and `fss verify` succeed, worker before API.

    A fresh environment cannot start its services before the schema exists.
    Both binaries refuse to start unless the applied schema version is exactly
    the range they declare, so an apply that created them running would create
    two services crash-looping on an empty database while the migration task
    that would fix it had not been launched yet.
  EOT
  type        = bool
  default     = false
}

variable "container_insights" {
  description = "enabled, enhanced or disabled."
  type        = string
  default     = "disabled"
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into a running task."
  type        = bool
  default     = false
}

variable "create_registry" {
  description = <<-EOT
    Whether this stack creates its own ECR repositories.

    True for production, which owns `fss-prod-api` and `fss-prod-worker` for as
    long as it exists. False for a rehearsal *run*: its repositories have to
    exist before the run does, so they belong to `infra/roots/rehearsal-registry`
    and are applied once. A per-run registry would also be deleted with the run,
    taking the images the next run's digests refer to.
  EOT
  type        = bool
  default     = true
}

variable "dependencies_mode" {
  description = <<-EOT
    `FSS_DEPENDENCIES` on both task definitions: `live` builds every real
    adapter from the deployed configuration, `recorded` selects the rehearsal
    fakes **by name**. `none` is a laptop value and is not offered here: a
    deployed process reaching a no-op by omission is the failure
    `apps/*/src/bootstrap/deployment.ts` exists to prevent, and both binaries
    refuse `none` when `FSS_ENVIRONMENT` is production anyway.
  EOT
  type        = string
  default     = "live"

  validation {
    condition     = contains(["live", "recorded"], var.dependencies_mode)
    error_message = "dependencies_mode must be live or recorded. A deployed process never reaches its no-op dependencies by omission."
  }
}

variable "research_providers" {
  description = <<-EOT
    `FSS_RESEARCH_PROVIDERS` on the **worker** task definition only; the API
    has no research adapter. `none` is a declaration that this build ships no
    live provider, not an accident.
  EOT
  type        = string
  default     = "none"

  validation {
    condition     = length(trimspace(var.research_providers)) > 0
    error_message = "research_providers may not be empty. Say none."
  }
}

variable "sending_enabled" {
  description = <<-EOT
    `FSS_SENDING_ENABLED` on both task definitions. One of the two switches
    `packages/domain/outbound/gate.ts` reads; the other is the admin
    attestation naming a release gate. False until 16.2 is satisfied, and
    false is also what an absent value means to the bootstraps.
  EOT
  type        = bool
  default     = false
}

variable "extra_environment" {
  description = <<-EOT
    Additional non-secret environment variables for both tasks. The three flags
    above used to have to travel through here, which is why neither root
    exposed any of them; it stays for whatever the next release needs before it
    earns a variable of its own. Never a credential: the root tests assert no
    environment name looks like one.
  EOT
  type        = map(string)
  default     = {}
}

variable "business_time_zone" {
  description = "Workspace business zone used for the Today snapshot date. Initialized to America/New_York."
  type        = string
  default     = "America/New_York"
}

variable "google_hosted_domain" {
  description = <<-EOT
    The Callie Google Workspace domain. Specification 5.1 refuses an id token
    whose `hd` differs, and 12.1 lets only a mailbox in this domain connect.
    A public identifier, so it travels in the task environment rather than
    inside an operator-written secret.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.google_hosted_domain))
    error_message = "google_hosted_domain must be a domain name, and it may not be empty: an empty one would admit every Google account."
  }
}

# ---------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------

variable "certificate_arn" {
  description = "ACM certificate ARN for the API hostname, created and DNS-validated by hand before the first apply."
  type        = string
}

variable "api_hostname" {
  description = "Public hostname the Electron client and Pub/Sub reach. Used to build the push endpoint and audience."
  type        = string
}

variable "elb_account_id" {
  description = "Region-specific Elastic Load Balancing account id, only needed in older regions."
  type        = string
  default     = ""
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the load balancer."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Secrets, journal, alerts, updates
# ---------------------------------------------------------------------------

variable "secret_names" {
  description = <<-EOT
    Logical names of the Secrets Manager entries, each created empty.

    The last two are the database identities (G12h). They are not optional:
    `infra/modules/secrets` refuses a list without them, because the cluster's
    execution-role boundary is drawn along them and a caller who dropped one
    would otherwise get an index error four modules away.
  EOT
  type        = list(string)
  default = [
    "google-oidc-client",
    "google-gmail-oauth-client",
    "session-signing-key",
    "device-credential-pepper",
    "llm-classifier-api-key",
    "research-provider-credentials",
    "migration-database",
    "app-runtime-database",
  ]
}

variable "journal_object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE for the suppression journal."
  type        = string
  default     = "GOVERNANCE"
}

variable "journal_object_lock_retention_days" {
  description = "Default object lock retention for journal objects."
  type        = number
  default     = 3650
}

variable "journal_administrative_principal_arns" {
  description = <<-EOT
    IAM role ARNs exempted from every `Deny` in the suppression journal's
    bucket policy except the transport one, so that the principal which created
    the bucket can remove it. Empty by default.

    The rehearsal root passes its own deployment role, because a rehearsal
    environment has to be able to disappear and on 21 September 2026 it could
    not: the policy denied `s3:DeleteBucketPolicy` and
    `s3:PutBucketObjectLockConfiguration` to `Principal *`, so the teardown of
    Actions run 35628963637 left the bucket, its policy, its object lock, its
    versioning and its public-access block behind. The production root passes
    nothing unless David sets it.
    `docs/decisions/g16-the-journal-deny-exempts-its-deployer.md`.
  EOT
  type        = list(string)
  default     = []
}

variable "journal_listing_principal_arns" {
  description = <<-EOT
    IAM role ARNs exempted from the suppression journal's *listing* deny alone,
    so that the principal which created the bucket can see that it exists.
    Both roots pass their own deployment role, production included.

    `HeadBucket` is authorised as `s3:ListBucket` and the AWS provider reads a
    403 there as "the bucket is gone". The first production apply, on 23
    September 2026, created the bucket as `fss-prod-deploy` and was refused its
    own head request; the next plan dropped it from state, proposed to create it
    again, and deleted the encryption configuration and the ownership controls
    before the policy and the object lock refused. Listing only: an exemption
    here reads no object and no version list.
    `docs/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`.
  EOT
  type        = list(string)
  default     = []
}

variable "alert_emails" {
  description = "Addresses that receive alerts, delivered by SNS independently of any Gmail grant."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Operational application log retention."
  type        = number
  default     = 90
}

variable "updates_price_class" {
  description = "CloudFront price class for the Electron package distribution."
  type        = string
  default     = "PriceClass_100"
}

# ---------------------------------------------------------------------------
# Gmail push
# ---------------------------------------------------------------------------

# This module creates nothing in Google Cloud and requires no Google provider.
# The topic and its push subscription belong to `infra/roots/production`, the
# one root with a project; each root passes the three identifiers its task
# definitions carry. Terraform configures every provider a module *requires*
# during a plan, even with no instances of it, which is why `module "pubsub"`
# with `count = 0` still asked CI for a Google credential.
# `docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
#
# Each of the three is validated for shape and not for presence. An empty value
# means "this environment was not told", which both bootstraps refuse at
# start-up by name; a wrong *shape* is something a plan can catch, and a value
# the same apply computes is unknown while planning, so the check is deferred
# to the apply rather than skipped.

variable "gmail_push_topic" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_TOPIC` on both task definitions: the fully qualified Pub/Sub
    topic id `users.watch` registers against, `projects/<project>/topics/<name>`.
    Production passes `module.pubsub[0].topic_id`, a value that apply computes.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.gmail_push_topic == "" || can(regex("^projects/[^/]+/topics/[^/]+$", var.gmail_push_topic))
    error_message = "A Pub/Sub topic id is projects/<project>/topics/<name>. A bare topic name is not what users.watch takes."
  }
}

variable "gmail_push_audience" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_AUDIENCE` on both task definitions: the exact audience the
    webhook requires in a push token. It is derived from the API hostname and
    the push path, so it needs no Google resource and every root can always
    supply it.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.gmail_push_audience == "" || startswith(var.gmail_push_audience, "https://")
    error_message = "The push audience is the HTTPS URL of the webhook. A notification carries a mailbox address and must never travel in the clear."
  }
}

variable "gmail_push_service_account" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` on both task definitions: the one service
    account whose OIDC token the webhook accepts. Production passes
    `module.pubsub[0].push_service_account_email`.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.gmail_push_service_account == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+$", var.gmail_push_service_account))
    error_message = "The push service account is an email address, and the webhook compares it exactly."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into every resource."
  type        = map(string)
  default     = {}
}
