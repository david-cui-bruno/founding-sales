# FSS greenfield container registry.
#
# Tags are immutable, so a digest that passed the rehearsal gate cannot later
# point at different bytes. Services are deployed by digest, not by tag; the
# tag exists only so a human can read the release history.
#
# A repository that still holds images refuses to be deleted, in both places this
# module is used: production's registry holds the images every release is
# identified by, and the durable fss-rh pair (infra/roots/rehearsal-registry) the
# images every past release was rehearsed on. A rehearsal run creates none.

locals {
  repositories = { for name in ["api", "worker"] : name => "${var.name_prefix}-${name}" }
}

resource "aws_ecr_repository" "this" {
  for_each = local.repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, { Name = each.value })
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged layers."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep enough earlier compatible binaries for a forward rollback."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}
