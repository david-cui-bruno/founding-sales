# FSS greenfield network.
#
# Two public subnets carry the Fargate tasks, which reach ECR, Gmail, Google and
# the research providers through public addresses on the internet gateway. There
# is deliberately no NAT gateway and no VPC interface endpoint: tasks with public
# addresses pull from ECR directly, so endpoints would add cost without adding a
# path. Two private subnets, with no route off the VPC, carry RDS.
#
# Every security-group rule in this module is generated from local.ingress_rules
# and local.egress_rules. A rule that is not in those maps does not exist, and
# tests/security_groups.tftest.hcl asserts the resource counts match the maps.

locals {
  security_groups = {
    alb = {
      description = "Public application load balancer. The only internet-facing component."
    }
    api_task = {
      description = "API Fargate tasks. Reachable only from the load balancer."
    }
    worker_task = {
      description = "Worker Fargate tasks. Admits nothing inbound."
    }
    database = {
      description = "RDS PostgreSQL. Reachable only from the two task security groups."
    }
  }

  # group: the security group that owns the rule.
  # source_group: another group in local.security_groups, or null.
  # cidr_ipv4 / cidr_ipv6 / prefix_list: exactly one source overall must be set.
  ingress_rules = {
    alb_https_ipv4 = {
      group        = "alb"
      description  = "HTTPS from the internet. The only open-world ingress in the VPC."
      ip_protocol  = "tcp"
      from_port    = 443
      to_port      = 443
      cidr_ipv4    = "0.0.0.0/0"
      cidr_ipv6    = null
      prefix_list  = null
      source_group = null
    }
    alb_https_ipv6 = {
      group        = "alb"
      description  = "HTTPS from the internet over IPv6."
      ip_protocol  = "tcp"
      from_port    = 443
      to_port      = 443
      cidr_ipv4    = null
      cidr_ipv6    = "::/0"
      prefix_list  = null
      source_group = null
    }
    api_from_alb = {
      group        = "api_task"
      description  = "API container port from the load balancer only."
      ip_protocol  = "tcp"
      from_port    = var.api_container_port
      to_port      = var.api_container_port
      cidr_ipv4    = null
      cidr_ipv6    = null
      prefix_list  = null
      source_group = "alb"
    }
    database_from_api = {
      group        = "database"
      description  = "PostgreSQL from the API tasks."
      ip_protocol  = "tcp"
      from_port    = var.database_port
      to_port      = var.database_port
      cidr_ipv4    = null
      cidr_ipv6    = null
      prefix_list  = null
      source_group = "api_task"
    }
    database_from_worker = {
      group        = "database"
      description  = "PostgreSQL from the worker tasks."
      ip_protocol  = "tcp"
      from_port    = var.database_port
      to_port      = var.database_port
      cidr_ipv4    = null
      cidr_ipv6    = null
      prefix_list  = null
      source_group = "worker_task"
    }
  }

  egress_rules = {
    alb_to_api = {
      group             = "alb"
      description       = "Load balancer to the API container port only."
      ip_protocol       = "tcp"
      from_port         = var.api_container_port
      to_port           = var.api_container_port
      cidr_ipv4         = null
      cidr_ipv6         = null
      destination_group = "api_task"
    }
    api_egress_ipv4 = {
      group             = "api_task"
      description       = "API tasks reach ECR, Secrets Manager, S3, Google and RDS."
      ip_protocol       = "-1"
      from_port         = null
      to_port           = null
      cidr_ipv4         = "0.0.0.0/0"
      cidr_ipv6         = null
      destination_group = null
    }
    worker_egress_ipv4 = {
      group             = "worker_task"
      description       = "Worker tasks reach ECR, Secrets Manager, Gmail, research providers and RDS."
      ip_protocol       = "-1"
      from_port         = null
      to_port           = null
      cidr_ipv4         = "0.0.0.0/0"
      cidr_ipv6         = null
      destination_group = null
    }
  }

  # The private route table carries no route off the VPC. This list stays empty
  # by construction and the test asserts it; see the no-NAT note above.
  private_route_destinations = []
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpc" })
}

# Leave the default security group with no rules at all.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-default-unused" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = var.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${var.availability_zones[count.index]}"
    Tier = "task"
  })
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = var.private_subnet_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-private-${var.availability_zones[count.index]}"
    Tier = "database"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# No default route. RDS has no path off the VPC and needs none.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-private" })
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "this" {
  for_each = local.security_groups

  name        = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  description = each.value.description
  vpc_id      = aws_vpc.main.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-${replace(each.key, "_", "-")}" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  for_each = local.ingress_rules

  security_group_id = aws_security_group.this[each.value.group].id
  description       = each.value.description
  ip_protocol       = each.value.ip_protocol
  from_port         = each.value.from_port
  to_port           = each.value.to_port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6
  prefix_list_id    = each.value.prefix_list

  referenced_security_group_id = each.value.source_group == null ? null : aws_security_group.this[each.value.source_group].id

  tags = merge(var.tags, { Name = "${var.name_prefix}-${replace(each.key, "_", "-")}" })
}

resource "aws_vpc_security_group_egress_rule" "this" {
  for_each = local.egress_rules

  security_group_id = aws_security_group.this[each.value.group].id
  description       = each.value.description
  ip_protocol       = each.value.ip_protocol
  from_port         = each.value.from_port
  to_port           = each.value.to_port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6

  referenced_security_group_id = each.value.destination_group == null ? null : aws_security_group.this[each.value.destination_group].id

  tags = merge(var.tags, { Name = "${var.name_prefix}-${replace(each.key, "_", "-")}" })
}
