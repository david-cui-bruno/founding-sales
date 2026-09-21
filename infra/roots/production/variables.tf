variable "name_prefix" {
  description = <<-EOT
    The production namespace. It is fixed. The validation below is half of the
    structural isolation between the two roots: production is exactly
    "fss-prod" and rehearsal is "fss-rh-<run>", so the two name spaces are
    disjoint and no rehearsal apply can address a production resource.
  EOT
  type        = string
  default     = "fss-prod"

  validation {
    condition     = var.name_prefix == "fss-prod"
    error_message = "The production root owns exactly the fss-prod namespace. Another prefix belongs in another root."
  }
}

variable "deployment_role_name" {
  description = "IAM role Terraform assumes for this root. Production and rehearsal never share one."
  type        = string
  default     = "fss-prod-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-prod-") && !startswith(var.deployment_role_name, "fss-rh-")
    error_message = "The production deployment role must live in the fss-prod- namespace."
  }
}

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
    `docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  EOT
  type        = bool
  default     = true
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "AWS account id. The provider refuses to act against any other account."
  type        = string
  default     = "326255650484"
}

variable "availability_zones" {
  description = "Exactly two availability zones."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "certificate_arn" {
  description = "ACM certificate for the API hostname. Created and DNS-validated by hand before the first apply."
  type        = string
}

variable "api_hostname" {
  description = "Public API hostname."
  type        = string
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

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
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

variable "database_performance_insights_enabled" {
  description = "Performance Insights, billed beyond the free retention."
  type        = bool
  default     = false
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

variable "cpu_architecture" {
  description = <<-EOT
    X86_64 or ARM64, and the answer is ARM64 (David, 20 September 2026).

    This is a default rather than a tfvars entry on purpose: `infra/.gitignore`
    ignores `*.tfvars`, so an answer written there is an answer the repository
    never sees and CI can never check. `greenfield-images.yml` builds
    `--platform linux/arm64` and nothing else, so X86_64 here asks Fargate for
    a manifest that is not in the index: the task never starts, the circuit
    breaker rolls back, and the error arrives as a pull failure rather than as
    a plan somebody could have read. `infra/roots/*/tests/isolation.tftest.hcl`
    asserts the planned task definitions, not this value.
  EOT
  type        = string
  default     = "ARM64"

  # Repeated from the cluster module deliberately: a refusal should name the
  # variable the operator typed, not one three modules down.
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be exactly X86_64 or ARM64. ECS takes the uppercase enum, not Docker's linux/arm64 spelling."
  }
}

variable "dependencies_mode" {
  description = <<-EOT
    `FSS_DEPENDENCIES` on both task definitions. Production is `live`: every
    real adapter is built from the deployed configuration, and any missing part
    is a refusal to start rather than a queue that quietly never drains.

    `recorded` is accepted by the validation and refused at run time by both
    binaries when `FSS_ENVIRONMENT` is production (`PRODUCTION_REQUIRES_LIVE`),
    so the refusal is not duplicated here. `none` is refused outright: it is the
    laptop value, and a deployed process must never reach a no-op by omission.
  EOT
  type        = string
  default     = "live"

  validation {
    condition     = contains(["live", "recorded"], var.dependencies_mode)
    error_message = "dependencies_mode must be live or recorded. none is the laptop value and a deployed process never reaches its no-op dependencies."
  }
}

variable "research_providers" {
  description = "`FSS_RESEARCH_PROVIDERS` on the worker task definition. `none` says this build ships no live research adapter; it is a declaration, not an accident."
  type        = string
  default     = "none"
}

variable "sending_enabled" {
  description = <<-EOT
    `FSS_SENDING_ENABLED` on both task definitions: the deployment half of
    16.2's send gate. False until the rehearsal gate has passed on the deployed
    digests; `docs/greenfield/release.md` section 6 step 4 is where it becomes
    true, and step 5 is the admin attestation that is the other half. Neither
    alone sends anything.
  EOT
  type        = bool
  default     = false
}

variable "extra_environment" {
  description = "Any further non-secret environment variable both tasks need. Never a credential: secrets reach a container only as a Secrets Manager reference."
  type        = map(string)
  default     = {}
}

variable "container_insights" {
  description = "enabled, enhanced or disabled. Billed per metric."
  type        = string
  default     = "disabled"
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the load balancer."
  type        = bool
  default     = false
}

variable "elb_account_id" {
  description = "Region-specific Elastic Load Balancing account id, only needed in older regions."
  type        = string
  default     = ""
}

variable "alert_emails" {
  description = "Addresses that receive alerts. Each must confirm its subscription once by hand."
  type        = list(string)
  default     = []
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
    IAM role ARNs exempted from every `Deny` in the production suppression
    journal's bucket policy except the transport one. **Empty, and it stays
    empty until David says otherwise.**

    The rehearsal root passes its own deployment role, because a rehearsal
    environment has to be able to disappear. Production is the opposite case:
    decision 4 of 21 September 2026 is GOVERNANCE mode with a ten-year
    retention, and removing the journal is an act of the account root rather
    than something a release could do by mistake. The variable exists so that
    the opt-in is one `-var` and a line in a plan David reads, not a change to
    a module. `docs/decisions/g16-the-journal-deny-exempts-its-deployer.md`.

    The production deployment role is separately denied `s3:GetObject*` and
    `s3:BypassGovernanceRetention` by its own policy
    (`infra/policies/deployment-role-policy.json.tftpl`), so naming it here
    would not on its own let it empty the bucket either.
  EOT
  type        = list(string)
  default     = []
}

variable "business_time_zone" {
  description = "Workspace business zone for the Today snapshot date."
  type        = string
  default     = "America/New_York"
}

variable "google_hosted_domain" {
  description = <<-EOT
    The Callie Google Workspace domain. Both task definitions carry it: the API
    refuses an id token whose `hd` differs (5.1) and a mailbox outside it
    (12.1), and the worker reads the same value so the two cannot disagree.
    A public identifier, which is why it is here rather than in a secret.
  EOT
  type        = string
  default     = "usecallie.com"

  # Repeated from the stack module deliberately: this is the operator's input,
  # and a refusal should name the variable they typed rather than one three
  # modules down. An empty domain would admit every Google account there is.
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.google_hosted_domain))
    error_message = "google_hosted_domain must be a domain name and may not be empty."
  }
}

variable "enable_gmail_push" {
  description = <<-EOT
    Create the Gmail push topic and subscription in the production Google Cloud
    project. The default is true and a production deployment wants it: with push
    off, `FSS_GMAIL_PUSH_TOPIC` and `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` are empty,
    and both binaries read them with `required()`, so the API and the worker
    would refuse to start. Turning it off is for a plan you are reading, not for
    an environment you intend to run.

    It does not control whether the Google provider is configured. Terraform
    configures every provider this root requires before it evaluates anything,
    so a production plan needs application-default credentials either way;
    `docs/greenfield/infra-apply-runbook.md` 1.3a.
  EOT
  type        = bool
  default     = true
}

variable "gcp_project_id" {
  description = "Production Google Cloud project that owns the Gmail push topic."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_gmail_push || var.gcp_project_id != ""
    error_message = "Gmail push needs the production Google Cloud project id."
  }
}

variable "gcp_region" {
  description = "Google Cloud region for the provider."
  type        = string
  default     = "us-east1"
}

variable "gmail_push_path" {
  description = <<-EOT
    Path on the API that Pub/Sub pushes to. It is the same route in every
    environment, and this root builds both the push endpoint and the audience
    from it, so the subscription and the task definitions cannot disagree about
    what the webhook will accept.
  EOT
  type        = string
  default     = "/integrations/gmail/push"

  validation {
    condition     = startswith(var.gmail_push_path, "/")
    error_message = "The push path is a path on the API, beginning with a slash."
  }
}

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

    Passing `true` to an environment that is already running scales both
    services to zero. That is a real outage and never what an ordinary release
    wants; a schema release stops the services through
    `release-deploy.sh --schema-change`, which restores the declared counts at
    the end of the same run.
  EOT
  type        = bool
  default     = false
}
