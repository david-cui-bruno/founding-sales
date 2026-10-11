# Prospective routine maintenance authority (#580). Separate from the app-only role.
# Applying this definition and configuring the protected environment require the held
# one-time review. No Terraform state, IAM writes or secret plaintext access are granted.
locals {
  ci_maintenance_role_name = "${local.name_prefix}-ci-maintenance"
  ci_maintenance_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.ci_deploy_oidc_provider }
      Condition = { StringEquals = {
        "${local.ci_deploy_oidc_issuer}:aud" = "sts.amazonaws.com"
        "${local.ci_deploy_oidc_issuer}:sub" = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-maintenance"
      } }
    }]
  }
  ci_maintenance_policy = {
    Version = "2012-10-17"
    Statement = concat(local.ci_deploy_policy.Statement, [
      {
        Sid      = "ReadExistingMigrationCredentialMetadataOnly"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret"]
        Resource = ["arn:aws:secretsmanager:${local.aws_region}:${local.aws_account_id}:secret:${local.name_prefix}/migration-database-*"]
      },
      {
        Sid      = "ReadExistingBackupReadiness"
        Effect   = "Allow"
        Action   = ["rds:DescribeDBInstances"]
        Resource = ["arn:aws:rds:${local.aws_region}:${local.aws_account_id}:db:${local.name_prefix}-pg"]
      },
      {
        Sid      = "ReadOnlyTaskNetworkBindings"
        Effect   = "Allow"
        Action   = ["ec2:DescribeSecurityGroups", "ec2:DescribeSubnets"]
        Resource = ["*"]
      },
      {
        Sid       = "PassExistingMigrationIdentityOnlyToEcs"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [for name in ["migration-task", "migration-exec"] : "arn:aws:iam::${local.aws_account_id}:role/${local.name_prefix}-${name}"]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid       = "RunMigrationOnlyInProductionCluster"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["${local.ci_deploy_arn_ecs}:task-definition/${local.name_prefix}-migration:*"]
        Condition = { ArnEquals = { "ecs:cluster" = local.ci_deploy_cluster } }
      },
      {
        Sid       = "TagOnlyRegisteredOneOffRevisions"
        Effect    = "Allow"
        Action    = ["ecs:TagResource"]
        Resource  = [for name in ["migration", "operations"] : "${local.ci_deploy_arn_ecs}:task-definition/${local.name_prefix}-${name}:*"]
        Condition = { StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition" } }
      }
      ], [for service in local.ci_deploy_services : {
        Sid       = "MaintenanceCountAndRevision${title(service)}"
        Effect    = "Allow"
        Action    = ["ecs:UpdateService"]
        Resource  = ["${local.ci_deploy_arn_ecs}:service/${module.stack.cluster_name}/${local.ci_deploy_service[service]}"]
        Condition = { ArnLikeIfExists = { "ecs:task-definition" = local.ci_deploy_family_arn[service] } }
    }])
  }
}
resource "aws_iam_role" "ci_maintenance" {
  name                 = local.ci_maintenance_role_name
  description          = "Reviewed routine stop/migrate/start only; existing production resources, no state or IAM writes."
  assume_role_policy   = jsonencode(local.ci_maintenance_trust_policy)
  max_session_duration = 7200
  tags                 = { Name = local.ci_maintenance_role_name, NamePrefix = local.name_prefix }
}
resource "aws_iam_role_policy" "ci_maintenance" {
  name   = "${local.ci_maintenance_role_name}-scope"
  role   = aws_iam_role.ci_maintenance.id
  policy = jsonencode(local.ci_maintenance_policy)
}
output "ci_maintenance_role_arn" {
  description = "Separately reviewed production-maintenance environment identity; FSS_PRODUCTION_MAINTENANCE_ROLE_ARN."
  value       = aws_iam_role.ci_maintenance.arn
}
