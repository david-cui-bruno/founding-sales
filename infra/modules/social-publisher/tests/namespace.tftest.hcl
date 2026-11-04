mock_provider "aws" {}

variables {
  name_prefix           = "fss-prod"
  aws_region            = "us-east-1"
  aws_account_id        = "123456789012"
  vpc_id                = "vpc-00000000000000001"
  subnet_id             = "subnet-00000000000000001"
  alb_security_group_id = "sg-00000000000000001"
  listener_arn          = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/example/0000000000000001/0000000000000001"
  browser_hostname      = "sales.example.invalid"
  control_secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-prod/social-publisher-control-token-example"
  secrets_kms_key_arn   = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000001"
  ami_id                = "ami-00000000000000001"
  image                 = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  tags                  = { Environment = "production", NamePrefix = "unrelated" }
}

run "rule_creation_carries_its_own_namespace_without_authorizing_foreign_groups" {
  command = plan

  assert {
    condition = alltrue([for rule in concat([
      aws_vpc_security_group_ingress_rule.control,
      aws_vpc_security_group_egress_rule.alb_control,
      aws_vpc_security_group_egress_rule.https
    ], values(aws_vpc_security_group_egress_rule.dns)) : try(rule.tags["NamePrefix"] == var.name_prefix, false)])
    error_message = "Every new publisher rule must carry the module namespace required by tag-on-create authorization, not merely inherit provider or caller labels."
  }

  assert {
    condition = length(setintersection(toset(one([
      for statement in jsondecode(templatefile("../../policies/deployment-role-policy.json.tftpl", {
        name_prefix         = var.name_prefix
        aws_account_id      = var.aws_account_id
        aws_region          = var.aws_region
        certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
        deployment_role_arn = "arn:aws:iam::123456789012:role/fss-prod-deploy"
        lock_table          = "example-lock"
        state_bucket        = "example-state"
        state_key_glob      = "production/terraform.tfstate"
        state_kms_key_arn   = var.secrets_kms_key_arn
      })).Statement : statement if statement.Sid == "CreateTaggedResourcesInThisNamespace"
    ]).Action), toset(["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress"]))) == 0
    error_message = "A namespace tag requested for a new rule must not grant authorization against an unrelated existing security group. Existing groups require their own namespace authority."
  }
}
