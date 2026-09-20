# The two stable rehearsal container repositories, applied once.
#
# A rehearsal *run* is ephemeral and its name carries the run
# (`fss-rh-<run>`). Its repositories cannot be: the images have to be in ECR
# before the run exists, because the run's own `terraform apply` deploys them
# by digest; the release workflow's `rehearsal` environment names
# `fss-rh-api` and `fss-rh-worker` in two secrets that do not change per run;
# and a repository created by a run is destroyed with it, taking every image
# the next run's rollback might have wanted.
#
# So they live here, in their own root with its own state, applied once by
# `fss-rh-deploy` and then left alone. `name_prefix` is a literal: there is no
# value a caller can pass that names a production repository, and
# `fss-rh-deploy` could not create one if there were.
#
# Everything else is the registry module's defaults, which are production's:
# immutable tags, scan on push, untagged layers expired after seven days and
# thirty tagged images retained. Rollback in rehearsal wants the same history
# production's does.

module "registry" {
  source = "../../modules/registry"

  name_prefix = local.name_prefix

  # False, deliberately, and the one place this root differs in spirit from a
  # rehearsal run. `force_delete` lets Terraform remove a repository that still
  # holds images; these repositories hold the images every past release was
  # rehearsed on. A `terraform destroy` here should fail on a repository that
  # is not empty, because that is the correct answer.
  force_delete = false

  tags = {
    Project     = "callie-fss"
    Environment = "rehearsal"
    NamePrefix  = local.name_prefix
    ManagedBy   = "terraform"
    Lifecycle   = "durable"
  }
}

locals {
  # A literal, not var.name_prefix. The release workflow's secrets name
  # `fss-rh-api` and `fss-rh-worker`; a root that could be applied under
  # another prefix would produce repositories nothing points at.
  name_prefix = "fss-rh"
}
