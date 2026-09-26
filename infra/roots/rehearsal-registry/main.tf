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
# Everything else is the registry module's, which is production's: immutable
# tags, scan on push, no force delete (a `terraform destroy` here fails on a
# repository that is not empty, which is the correct answer), untagged layers
# expired after seven days and thirty tagged images retained.

module "registry" {
  source = "../../modules/registry"

  name_prefix = local.name_prefix

  tags = {
    Project     = "callie-fss"
    Environment = "rehearsal"
    NamePrefix  = local.name_prefix
    ManagedBy   = "terraform"
    Lifecycle   = "durable"
  }
}

locals {
  # The one AWS account and region FSS runs in. Literals: nothing deploys this
  # root anywhere else, and the provider refuses a credential of any other account.
  aws_account_id = "326255650484"
  aws_region     = "us-east-1"

  # A literal, not var.name_prefix. The release workflow's secrets name
  # `fss-rh-api` and `fss-rh-worker`; a root that could be applied under
  # another prefix would produce repositories nothing points at.
  name_prefix = "fss-rh"

  # The role the provider assumes: `fss-rh-deploy`, whose policy is scoped to
  # `fss-rh-*`. That scoping is what makes `fss-rh-api` and `fss-rh-worker`
  # creatable here and a production repository unreachable from here.
  deployment_role_name = "fss-rh-deploy"
}
