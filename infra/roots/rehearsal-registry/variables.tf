variable "deployment_role_name" {
  description = <<-EOT
    IAM role Terraform assumes for this root: the same `fss-rh-deploy` a
    rehearsal run uses, whose policy is scoped to `fss-rh-*`. That scoping is
    what makes `fss-rh-api` and `fss-rh-worker` creatable here and makes a
    production repository unreachable from here, whatever this file says.
  EOT
  type        = string
  default     = "fss-rh-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-rh-") && !startswith(var.deployment_role_name, "fss-prod")
    error_message = "The rehearsal registry root assumes a role in the fss-rh- namespace."
  }
}

variable "aws_region" {
  description = "AWS region. The same region the rehearsal runs in; ECR is regional."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "AWS account id. The provider refuses to act against any other account."
  type        = string
  default     = "326255650484"
}
