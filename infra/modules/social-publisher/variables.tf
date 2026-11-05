variable "name_prefix" { type = string }
variable "aws_region" { type = string }
variable "aws_account_id" { type = string }
variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "alb_security_group_id" { type = string }
variable "listener_arn" { type = string }
variable "browser_hostname" { type = string }
variable "control_secret_arn" { type = string }
variable "secrets_kms_key_arn" { type = string }
variable "ami_id" {
  description = "Reviewed native ARM64 AL2023 image; changing it replaces only the isolated host."
  type        = string
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.ami_id))
    error_message = "A pinned AMI identifier is required."
  }
}
variable "image" {
  description = "The independently pinned accepted old API image for browser recovery custody, never the stripped candidate API application."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9][a-z0-9/_-]*@sha256:[0-9a-f]{64}$", var.image))
    error_message = "An immutable private ECR image digest is required."
  }
}
variable "tags" {
  type    = map(string)
  default = {}
}
