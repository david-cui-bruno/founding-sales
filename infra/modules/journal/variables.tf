variable "name_prefix" {
  description = "Namespace applied to the bucket and key names in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the journal bucket. Used to build the writer and reader role ARNs."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "writer_role_names" {
  description = <<-EOT
    Names of the task roles permitted to put an object: the API, which records
    suppressions from its own routes, and the worker, which records prospect
    opt-outs during mail sync (10.2). Passed as names rather than ARNs so this
    module does not depend on the cluster module, which in turn depends on this
    bucket's ARN.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.writer_role_names) > 0
    error_message = "A journal with no named writer would deny every put; name the roles that append events."
  }
}

variable "reader_role_names" {
  description = "Roles permitted to read the journal. The worker reads it to replay suppression events after a restore."
  type        = list(string)
  default     = []
}

variable "administrative_principal_arns" {
  description = <<-EOT
    Principals exempted from every `Deny` in the bucket policy except the
    transport one. Empty by default, which is the posture production keeps.

    The denies are written against `Principal *` because an allow list alone
    would leave an administrator able to delete suppression history. On 21
    September 2026 that turned out to include the bucket's own deployer:
    David's fourth credentialed rehearsal (Actions run 35628963637) applied and
    then could not tear the run down —

        S3 DeleteBucketPolicy … 403 AccessDenied because of an explicit deny in
        the resource-based policy

    — and the same for `PutBucketObjectLockConfiguration`. With
    `s3:BypassGovernanceRetention` in the same deny, the teardown script's own
    `--bypass-governance-retention` emptying step could never have worked
    either, so no principal but the account root could ever remove the bucket.

    A rehearsal environment has to be able to disappear, so the rehearsal root
    passes its deployment role ARN here and the production root passes nothing
    unless David sets the variable (his decision 4 of 21 September: GOVERNANCE,
    ten years, and production teardown stays a root-user act unless he opts in).
    `docs/decisions/g16-the-journal-deny-exempts-its-deployer.md`.

    ARNs rather than names, and role ARNs rather than session ARNs:
    `aws:PrincipalArn` carries the *role* ARN for an assumed-role session, which
    is why the condition is `ArnNotEquals` on an exact ARN and not a pattern.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.administrative_principal_arns : can(regex("^arn:aws[a-z0-9-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_-]+$", arn))])
    error_message = "An administrative principal is an exact IAM role ARN. A wildcard or a bare role name here would exempt more than the deployer."
  }
}

variable "bucket_listing_principal_arns" {
  description = <<-EOT
    Principals exempted from the *listing* deny alone, so that the principal
    which created the bucket can see that it still exists. `HeadBucket` is
    authorised as `s3:ListBucket`, and the AWS provider reads a 403 there as
    "the bucket is gone": on 23 September 2026 the first production apply
    created this bucket as `fss-prod-deploy` and was then refused its own
    `HeadBucket`, so the next plan dropped `aws_s3_bucket.journal` from state,
    proposed to create it again, and in applying that plan deleted the
    server-side-encryption configuration and the ownership controls before the
    policy and the object lock refused to go. A deployer that cannot see its own
    bucket recreates it and strips whatever the deny does not cover.

    Listing, never content. This exemption is merged into
    `DenyListingFromAnyoneButTheTaskRolesAndTheDeployer` and into nothing else,
    so a principal named here may enumerate keys and still read no object, no
    object version and no version list. Both roots pass their own deployment
    role, production included: unlike `administrative_principal_arns` this is
    not an opt-in, because an environment whose deployer cannot see its bucket
    destroys it by accident.
    `docs/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`.

    ARNs rather than names, and role ARNs rather than session ARNs:
    `aws:PrincipalArn` carries the *role* ARN for an assumed-role session, which
    is why the condition is `ArnNotEquals` on an exact ARN and not a pattern.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.bucket_listing_principal_arns : can(regex("^arn:aws[a-z0-9-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_-]+$", arn))])
    error_message = "A listing principal is an exact IAM role ARN. A wildcard or a bare role name here would let more than the deployer enumerate suppression events."
  }
}

variable "object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE. COMPLIANCE cannot be shortened or removed by anyone, including the account root."
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.object_lock_mode)
    error_message = "Object lock mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "object_lock_retention_days" {
  description = "Default retention applied to every journal object. Suppression history is retained indefinitely, so production sets this long."
  type        = number
  default     = 3650

  validation {
    condition     = var.object_lock_retention_days >= 1
    error_message = "Object lock retention must be at least one day."
  }
}

variable "force_destroy" {
  description = "Allow Terraform to empty the bucket on destroy. Object-locked objects still refuse deletion until their retention expires."
  type        = bool
  default     = false
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the customer key is destroyed."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
