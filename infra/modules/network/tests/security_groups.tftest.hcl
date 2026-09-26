# Offline security-group contract for the FSS greenfield network module.
# Every run is a mocked plan. No backend, no credentials, no cloud call.
# Assertions read the declared rule inventory, which is the map the rule
# resources are generated from; infra/scripts/offline-gate.sh refuses any other
# security-group rule resource in the tree.

mock_provider "aws" {
  override_during = apply
}

variables {
  name_prefix          = "fss-test"
  availability_zones   = ["us-east-1a", "us-east-1b"]
  public_subnet_cidrs  = ["10.60.0.0/20", "10.60.16.0/20"]
  private_subnet_cidrs = ["10.60.128.0/20", "10.60.144.0/20"]
}

run "each_group_admits_only_what_the_topology_needs" {
  command = plan

  assert {
    condition = [for name, rule in output.ingress_rules : [rule.source_group, rule.cidr_ipv4, rule.cidr_ipv6, rule.prefix_list, rule.ip_protocol, rule.from_port, rule.to_port] if rule.group == "api_task"] == [
      ["alb", null, null, null, "tcp", var.api_container_port, var.api_container_port],
    ]
    error_message = "The API task group admits exactly one rule: the container port from the ALB group, no CIDR or prefix list."
  }

  assert {
    condition     = length([for name, rule in output.ingress_rules : name if rule.group == "worker_task"]) == 0
    error_message = "The worker task group must have no ingress rule at all."
  }

  assert {
    condition     = sort([for name, rule in output.ingress_rules : rule.source_group if rule.group == "database"]) == tolist(["api_task", "worker_task"])
    error_message = "RDS ingress must come from exactly the API task and worker task groups."
  }

  assert {
    condition = alltrue([
      for name, rule in output.ingress_rules :
      rule.cidr_ipv4 == null && rule.cidr_ipv6 == null && rule.prefix_list == null && rule.from_port == 5432 && rule.to_port == 5432
      if rule.group == "database"
    ])
    error_message = "RDS ingress must be the database port from referenced groups only."
  }

  assert {
    condition     = length([for name, rule in output.egress_rules : name if rule.group == "database"]) == 0
    error_message = "The database group must declare no egress rule."
  }

  assert {
    condition = sort([
      for name, rule in aws_vpc_security_group_ingress_rule.this :
      "${output.ingress_rules[name].group}:${rule.ip_protocol}:${rule.from_port}-${rule.to_port}"
      if rule.cidr_ipv4 == "0.0.0.0/0" || rule.cidr_ipv6 == "::/0"
    ]) == tolist(["alb:tcp:443-443", "alb:tcp:443-443"])
    error_message = "The only open-world ingress is ALB 443, once over IPv4 and once over IPv6."
  }

  assert {
    condition = [for name, rule in output.egress_rules : [rule.destination_group, rule.from_port, rule.to_port] if rule.group == "alb"] == [
      ["api_task", var.api_container_port, var.api_container_port],
    ]
    error_message = "The ALB may only egress to the API task container port."
  }

  assert {
    condition     = alltrue([for subnet in aws_subnet.private : subnet.map_public_ip_on_launch == false])
    error_message = "Database subnets must never assign public addresses."
  }
}
