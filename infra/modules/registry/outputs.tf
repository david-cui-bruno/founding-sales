output "repository_urls" {
  description = "Repository URLs keyed by short name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "repository_arns" {
  description = "Repository ARNs keyed by short name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.arn }
}

output "repository_settings" {
  description = <<-EOT
    What each repository is planned with, read back from the resources. The
    rehearsal-registry root asserts these match production's, because "the same
    settings" is the whole claim that root makes and a separate root is exactly
    the place settings drift.
  EOT
  value = {
    for name, repository in aws_ecr_repository.this : name => {
      image_tag_mutability = repository.image_tag_mutability
      scan_on_push         = repository.image_scanning_configuration[0].scan_on_push
      force_delete         = repository.force_delete
    }
  }
}

output "repository_names" {
  description = "Full repository names keyed by short name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.name }
}
