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
  description = "AWS region. The default is the region this tree started in; a dedicated account states its own."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = <<-EOT
    The AWS account this root deploys into. The provider refuses to act against
    any other account.

    The default is the shared account the tree started in, which is why nothing
    changes today. The dedicated production account states its own with
    `TF_VAR_aws_account_id`, `-var` or a tfvars file, and edits no Terraform;
    `docs/greenfield/accounts.md` is the checklist. Production applies stay local
    and the provider does the assuming, so this is also the account the
    `fss-prod-deploy` ARN is built from.
  EOT
  type        = string
  default     = "326255650484"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits and nothing else."
  }
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

variable "expected_system_generation" {
  description = <<-EOT
    Appendix E step 1: the generation the API and worker services expect the
    database to report, as FSS_EXPECTED_SYSTEM_GENERATION. Null: unpinned,
    and the worker makes no generation check.
    Production is unpinned in code. `docs/greenfield/release.md` ("The
    expected system generation") says how to read the database's generation
    with an operations task, how to pin it, and what to set after a restore:
    the restored copy's generation plus one, never after step 9.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.expected_system_generation == null ? true : (var.expected_system_generation >= 1 && floor(var.expected_system_generation) == var.expected_system_generation)
    error_message = "expected_system_generation is a positive whole number, or null for unpinned. The bootstraps refuse anything else at startup."
  }
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
# (`docs/decisions/g12c-the-topology-answers-are-root-defaults.md`). Passing
# `-var="gcp_project_id=…"` to this root is now an "undeclared variable" error.
# `docs/decisions/g85-the-google-provider-has-its-own-root.md`.
# ---------------------------------------------------------------------------

variable "gmail_push_path" {
  description = <<-EOT
    Path on the API that Pub/Sub pushes to. It is the same route in every
    environment. This root builds the audience the webhook requires from it,
    and `infra/roots/production-google` builds the subscription's push endpoint
    and token audience from the same default with the same expression, so the
    subscription and the task definitions cannot disagree about what the webhook
    will accept.
  EOT
  type        = string
  default     = "/integrations/gmail/push"

  validation {
    condition     = startswith(var.gmail_push_path, "/")
    error_message = "The push path is a path on the API, beginning with a slash."
  }
}

variable "gmail_push_topic" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_TOPIC` on both task definitions: the fully qualified topic
    id `users.watch` registers against. The worker renews the watch on it and
    the API reports it.

    A public identifier of an object this root does not manage. It is
    `infra/roots/production-google`'s `gmail_push_topic_id` output, and the
    default is that value, the topic created on 23 September 2026. It changes
    only when the Google root's topic does, in the same pull request, and
    `test/release/googleRoot.check.ts` fails when the two disagree. The
    validation refuses the rehearsal's no-push placeholder and anything that
    is not the production topic's name in some project.
  EOT
  type        = string
  default     = "projects/callie-fss/topics/fss-prod-gmail-push"

  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]{5,29}/topics/fss-prod-gmail-push$", var.gmail_push_topic))
    error_message = "gmail_push_topic is the production topic id, projects/<project>/topics/fss-prod-gmail-push: infra/roots/production-google's gmail_push_topic_id output."
  }
}

variable "gmail_push_service_account" {
  description = <<-EOT
    `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` on both task definitions: the one address
    whose push token the webhook accepts, compared exactly.

    A public identifier of an object this root does not manage. It is
    `infra/roots/production-google`'s `gmail_push_service_account` output, and
    the default is that value. A service account's email is fixed by its id and
    its project, so it changes only with them, in the same pull request. The
    validation refuses the rehearsal's `.invalid` placeholder, a blank, and any
    identity that is not the production push service account.
  EOT
  type        = string
  default     = "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"

  validation {
    condition     = can(regex("^fss-prod-gmail-push@[a-z][a-z0-9-]{5,29}\\.iam\\.gserviceaccount\\.com$", var.gmail_push_service_account))
    error_message = "gmail_push_service_account is the production push identity, fss-prod-gmail-push@<project>.iam.gserviceaccount.com: infra/roots/production-google's gmail_push_service_account output."
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
