# The identity GitHub Actions plans and applies this root with (lane G-WIF).
#
# David, 27 September 2026: no human Google login again. Until now this root was planned
# and applied from a Mac holding application-default credentials for the account that
# administers `callie-fss`, which lapse about every 17 hours under the Workspace
# reauthentication policy, and an expired one has held work back before (audit O01).
# `.github/workflows/greenfield-google.yml` holds the identity instead, the way
# `.github/workflows/greenfield-deploy.yml` holds `fss-prod-ci-deploy` in AWS: GitHub's
# OIDC token is exchanged, through the workload identity pool below, for a short-lived
# token of a service account. There is no key file anywhere and there is no
# `google_service_account_key` resource in this repository: a downloaded key is a
# long-lived credential in a file no rotation reaches, and David's rule is that no key is
# pasted anywhere.
#
# ## The principle
#
# CI may plan the whole root and apply a Pub/Sub change. It may not change the identity
# plumbing — this pool, this provider, this service account — nor the push service
# account, nor its own grants: nothing below grants a create or a write on a service
# account, on a workload identity pool, on a role, or on the project's IAM policy. Each of
# those is refused to CI by construction and is a human bootstrap step, run once with
# application-default credentials (`docs/greenfield/infra-apply-runbook.md` 1.3a). The
# first CI plan after that bootstrap proves the read set.
#
# ## The scope that is wider than the four objects, stated rather than hidden
#
# `roles/pubsub.admin` covers every topic and subscription in the project, not only the
# four objects `infra/modules/pubsub` owns, and `roles/iam.securityReviewer` reads more
# IAM policy than the bindings here need. Both are read-mostly, this project holds one
# product's Gmail push and nothing else, and two custom roles with a lifecycle of their
# own are not worth it for a single-user project.

locals {
  # The project number of `callie-fss`, a public identifier. A pool's principal
  # identifiers are built from the number and never from the id.
  gcp_project_number = "405930057974"

  # The one subject this project trusts, the same literal
  # `infra/roots/production/ci_deploy.tf` pins as `local.ci_deploy_subject` for AWS: this
  # repository's immutable owner and repository ids and the `production-deploy`
  # environment, which admits main alone. A literal and not a variable, because a variable
  # would be a way to widen the trust with one `-var`. No wildcard and no
  # repository-wide condition: a pull-request job of this repository is a different
  # subject and is refused at the exchange.
  ci_subject = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy"

  ci_pool_id     = "github"
  ci_provider_id = "github"

  # What federation itself needs. On 27 September 2026 `pubsub`, `cloudresourcemanager`
  # and `serviceusage` were enabled in this project and these three were not.
  ci_identity_services = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  # What CI is granted at the project. Pub/Sub write, so it can apply a change to the four
  # objects; the rest are reads a refresh of this root's state needs.
  ci_project_roles = toset([
    "roles/pubsub.admin",
    "roles/iam.securityReviewer",
    "roles/iam.serviceAccountViewer",
    "roles/iam.workloadIdentityPoolViewer",
    "roles/serviceusage.serviceUsageViewer",
  ])
}

resource "google_project_service" "ci_identity" {
  for_each = local.ci_identity_services

  project = local.gcp_project_id
  service = each.value

  # Never turn one off from here. Disabling `iam` or `sts` would lock CI out of its own
  # root, and disabling a dependent service could reach Pub/Sub; there is no
  # `terraform destroy` of this root in any procedure.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Every identity resource below waits for all three services. Terraform would otherwise
# create them in parallel with the enablement, and a create against an API that is not
# enabled yet is a refusal in the middle of the bootstrap apply rather than a wait.

resource "google_iam_workload_identity_pool" "github" {
  project                   = local.gcp_project_id
  workload_identity_pool_id = local.ci_pool_id
  display_name              = "GitHub Actions"
  description               = "OIDC tokens from this repository's production-deploy environment, and nothing else."

  depends_on = [google_project_service.ci_identity]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = local.ci_provider_id
  display_name                       = "GitHub Actions OIDC"
  description                        = "GitHub's OIDC issuer, admitted for one subject."

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # The condition is an equality on the one subject, evaluated before any token is issued,
  # so a token from another repository, another environment or a pull-request job never
  # reaches the binding below. `assertion.repository` is mapped for the audit trail; it is
  # deliberately not what the condition tests, because every job of this repository shares
  # it.
  attribute_condition = "assertion.sub == \"${local.ci_subject}\""

  oidc {
    # No `allowed_audiences`: the default audience is this provider's own full resource
    # name, which is what `google-github-actions/auth` requests for it.
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  depends_on = [google_project_service.ci_identity]
}

resource "google_service_account" "ci" {
  project      = local.gcp_project_id
  account_id   = "fss-prod-google-ci"
  display_name = "fss-prod GitHub Actions"
  description  = "The identity .github/workflows/greenfield-google.yml plans and applies this root as. Federated from GitHub's OIDC token; it has no key."

  depends_on = [google_project_service.ci_identity]
}

resource "google_service_account_iam_member" "ci_from_github" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"

  # `principal://…/subject/<the one subject>` and never `principalSet://…`: a principalSet
  # is a set, and the set that matches this repository matches every job in it, a pull
  # request included. One principal, one subject, spelled out.
  member = "principal://iam.googleapis.com/projects/${local.gcp_project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/subject/${local.ci_subject}"

  depends_on = [google_project_service.ci_identity]
}

resource "google_project_iam_member" "ci" {
  for_each = local.ci_project_roles

  project = local.gcp_project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ci.email}"

  depends_on = [google_project_service.ci_identity]
}

resource "google_service_account_iam_member" "ci_acts_as_push" {
  # Resource-level, on the push service account `infra/modules/pubsub` owns: the
  # subscription mints its OIDC token as that account, so an apply that writes the
  # subscription needs actAs on it. The module is unchanged — this is a binding on its
  # service account, read from the output it already publishes, not an argument of it.
  service_account_id = "projects/${local.gcp_project_id}/serviceAccounts/${module.pubsub.push_service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci.email}"

  depends_on = [google_project_service.ci_identity]
}
