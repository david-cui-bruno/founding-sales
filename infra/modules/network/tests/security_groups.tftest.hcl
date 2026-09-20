# Offline security-group contract for the FSS greenfield network module.
# Every run is a mocked plan. No backend, no credentials, no cloud call.
# Assertions read the declared rule inventory, which is the same map the
# rule resources are generated from, so a rule cannot exist outside it.

mock_provider "aws" {
  override_during = plan
}

variables {
  name_prefix          = "fss-test"
  availability_zones   = ["us-east-1a", "us-east-1b"]
  public_subnet_cidrs  = ["10.60.0.0/20", "10.60.16.0/20"]
  private_subnet_cidrs = ["10.60.128.0/20", "10.60.144.0/20"]
}

run "rules_are_generated_only_from_the_declared_inventory" {
  command = plan

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.this) == length(output.ingress_rules)
    error_message = "Every ingress rule resource must come from the declared inventory."
  }

  assert {
    condition     = length(aws_vpc_security_group_egress_rule.this) == length(output.egress_rules)
    error_message = "Every egress rule resource must come from the declared inventory."
  }

  assert {
    condition     = length(aws_security_group.this) == length(output.security_group_ids)
    error_message = "Every security group resource must come from the declared inventory."
  }
}

run "api_task_admits_only_the_load_balancer" {
  command = plan

  assert {
    condition     = length([for name, rule in output.ingress_rules : name if rule.group == "api_task"]) == 1
    error_message = "The API task security group must have exactly one ingress rule."
  }

  assert {
    condition = alltrue([
      for name, rule in output.ingress_rules :
      rule.source_group == "alb" && rule.cidr_ipv4 == null && rule.cidr_ipv6 == null && rule.prefix_list == null
      if rule.group == "api_task"
    ])
    error_message = "API task ingress must reference the ALB security group and no CIDR or prefix list."
  }

  assert {
    condition = alltrue([
      for name, rule in output.ingress_rules :
      rule.from_port == var.api_container_port && rule.to_port == var.api_container_port && rule.ip_protocol == "tcp"
      if rule.group == "api_task"
    ])
    error_message = "API task ingress must be the container port only."
  }
}

run "worker_task_admits_nothing" {
  command = plan

  assert {
    condition     = length([for name, rule in output.ingress_rules : name if rule.group == "worker_task"]) == 0
    error_message = "The worker task security group must have no ingress rule at all."
  }
}

run "database_admits_only_the_two_task_groups" {
  command = plan

  assert {
    condition     = sort([for name, rule in output.ingress_rules : rule.source_group if rule.group == "database"]) == tolist(["api_task", "worker_task"])
    error_message = "RDS ingress must come from exactly the API task and worker task security groups."
  }

  assert {
    condition = alltrue([
      for name, rule in output.ingress_rules :
      rule.cidr_ipv4 == null && rule.cidr_ipv6 == null && rule.prefix_list == null && rule.from_port == var.database_port && rule.to_port == var.database_port
      if rule.group == "database"
    ])
    error_message = "RDS ingress must be the database port from referenced security groups only."
  }

  assert {
    condition     = length([for name, rule in output.egress_rules : name if rule.group == "database"]) == 0
    error_message = "The database security group must declare no egress rule."
  }
}

run "the_only_internet_facing_ingress_is_alb_443" {
  command = plan

  assert {
    condition = alltrue([
      for name, rule in output.ingress_rules :
      rule.group == "alb" && rule.from_port == 443 && rule.to_port == 443 && rule.ip_protocol == "tcp"
      if rule.cidr_ipv4 == "0.0.0.0/0" || rule.cidr_ipv6 == "::/0"
    ])
    error_message = "No open-world ingress is permitted anywhere except ALB 443."
  }

  assert {
    condition     = length([for name, rule in output.ingress_rules : name if rule.cidr_ipv4 == "0.0.0.0/0" || rule.cidr_ipv6 == "::/0"]) == 2
    error_message = "Exactly the two ALB 443 rules (IPv4 and IPv6) may face the internet."
  }

  assert {
    condition = alltrue([
      for name, rule in output.egress_rules :
      rule.destination_group == "api_task" && rule.from_port == var.api_container_port
      if rule.group == "alb"
    ])
    error_message = "The ALB may only egress to the API task container port."
  }
}

run "subnets_are_two_public_and_two_private_without_nat" {
  command = plan

  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2
    error_message = "The network is two public task subnets and two private database subnets."
  }

  assert {
    condition     = alltrue([for subnet in aws_subnet.public : subnet.map_public_ip_on_launch])
    error_message = "Task subnets need public addressing because there is no NAT gateway."
  }

  assert {
    condition     = alltrue([for subnet in aws_subnet.private : subnet.map_public_ip_on_launch == false])
    error_message = "Database subnets must never assign public addresses."
  }

  assert {
    condition     = aws_route.public_default.destination_cidr_block == "0.0.0.0/0"
    error_message = "The public route table carries the only default route, to the internet gateway."
  }

  assert {
    condition     = length(output.private_route_destinations) == 0
    error_message = "The private route table must carry no route off the VPC: there is no NAT gateway."
  }
}
