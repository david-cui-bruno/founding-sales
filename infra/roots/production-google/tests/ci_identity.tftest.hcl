# The CI identity this root grants GitHub Actions (lane G-WIF).
#
# Offline only: a mocked Google provider, no backend and no credential. Every project,
# account and subject below is a public identifier.
#
# ## What is asserted, and the vacuous passes it closes
#
# **One subject, in both places.** The provider's `attribute_condition` and the
# `workloadIdentityUser` member are compared to the whole expected string, not searched
# for a fragment: a condition that also admitted `assertion.repository` would still
# contain the subject. No member anywhere is a `principalSet://`, which is the shape that
# would admit every job of this repository, pull requests included.
#
# **The role set, exactly.** The project-level roles are compared as a sorted list, so a
# sixth — a write on IAM, on a pool, or on a service account — is red here rather than in
# a review. A list comparison over no bindings would be a vacuous pass, so the count is
# asserted with it.
#
# **The push objects are this file's neighbours, not its subjects.** The only thing here
# that names the push service account is one `roles/iam.serviceAccountUser` binding *on*
# it; the four objects' identifiers still come out of `module.pubsub` unchanged, and the
# CI account is a second account with an id of its own.
#
# The service accounts' emails are computed, so the bindings that carry them are asserted
# in a mocked apply, which makes no Google call
# (`docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`).

mock_provider "google" {
  override_during = apply

  mock_resource "google_service_account" {
    defaults = {
      email = "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
      name  = "projects/callie-fss/serviceAccounts/fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_pubsub_topic" {
    defaults = {
      id = "projects/callie-fss/topics/fss-prod-gmail-push"
    }
  }

  override_resource {
    target = google_service_account.ci
    values = {
      email = "fss-prod-google-ci@callie-fss.iam.gserviceaccount.com"
      name  = "projects/callie-fss/serviceAccounts/fss-prod-google-ci@callie-fss.iam.gserviceaccount.com"
    }
  }
}

run "one_subject_admits_ci_and_no_principal_set_widens_it" {
  command = plan

  assert {
    condition = (
      google_iam_workload_identity_pool_provider.github.attribute_condition
      == "assertion.sub == \"repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy\""
      && google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
      && google_iam_workload_identity_pool_provider.github.attribute_mapping == tomap({
        "google.subject"       = "assertion.sub"
        "attribute.repository" = "assertion.repository"
      })
    )
    error_message = "The provider admits exactly this repository's production-deploy subject, compared whole: an equality on assertion.sub, GitHub's issuer, and the two mapped attributes. assertion.repository is mapped for the audit trail and is deliberately not what the condition tests, because every job of this repository shares it."
  }

  assert {
    condition = (
      google_service_account_iam_member.ci_from_github.role == "roles/iam.workloadIdentityUser"
      && google_service_account_iam_member.ci_from_github.member
      == "principal://iam.googleapis.com/projects/405930057974/locations/global/workloadIdentityPools/github/subject/repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy"
    )
    error_message = "The binding names one principal://…/subject/… — the same subject the condition admits and the same literal infra/roots/production/ci_deploy.tf trusts in AWS."
  }

  assert {
    condition = (
      google_iam_workload_identity_pool.github.workload_identity_pool_id == "github"
      && google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id == "github"
      && google_service_account.ci.account_id == "fss-prod-google-ci"
    )
    error_message = "The pool, the provider and the service account are the three names .github/workflows/greenfield-google.yml carries written out."
  }
}

run "ci_holds_exactly_five_project_roles_and_no_way_to_grant_itself_a_sixth" {
  command = plan

  assert {
    condition = (
      length(google_project_iam_member.ci) == 5
      && sort([for binding in google_project_iam_member.ci : binding.role]) == tolist([
        "roles/iam.securityReviewer",
        "roles/iam.serviceAccountViewer",
        "roles/iam.workloadIdentityPoolViewer",
        "roles/pubsub.admin",
        "roles/serviceusage.serviceUsageViewer",
      ])
    )
    error_message = "CI holds exactly one write role, Pub/Sub, and four reads a refresh of this root needs. Nothing here grants a create or a write on a service account, a workload identity pool, a role or the project's IAM policy, so CI cannot change its own identity or its own grants: that is a human bootstrap step. A sixth role is a change to this test first."
  }

  assert {
    condition = alltrue([
      for service in ["iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com"] :
      google_project_service.ci_identity[service].disable_on_destroy == false
      && google_project_service.ci_identity[service].disable_dependent_services == false
    ])
    error_message = "The three APIs federation needs are enabled and never disabled from here: disabling iam or sts would lock CI out of its own root, and a dependent disable could reach Pub/Sub."
  }
}

# Computed emails, so a mocked apply: the CI account is a second account, and the one
# thing this file does to the push account is a binding on it.
run "the_push_objects_are_untouched_and_ci_only_acts_as_the_push_account" {
  command = apply

  assert {
    condition = (
      google_service_account_iam_member.ci_acts_as_push.role == "roles/iam.serviceAccountUser"
      && google_service_account_iam_member.ci_acts_as_push.service_account_id
      == "projects/callie-fss/serviceAccounts/${output.gmail_push_service_account}"
      && google_service_account_iam_member.ci_acts_as_push.member == "serviceAccount:${output.ci_service_account_email}"
    )
    error_message = "The one relationship to the push identity is actAs on it, for the CI account, so an apply may rewrite the subscription that mints its token. Nothing here renames, recreates or re-scopes the push account itself."
  }

  assert {
    condition = (
      output.ci_service_account_email != output.gmail_push_service_account
      && output.gmail_push_service_account == "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
      && output.gmail_push_audience == "https://api.usecallie.com/integrations/gmail/push"
      && output.gcp_project_id == "callie-fss"
    )
    error_message = "Two service accounts, not one: the push identity keeps the address the webhook accepts and the audience it mints for, and CI is a second account beside it."
  }

  assert {
    condition = (
      output.workload_identity_provider == "projects/405930057974/locations/global/workloadIdentityPools/github/providers/github"
      && output.ci_service_account_email == "fss-prod-google-ci@callie-fss.iam.gserviceaccount.com"
      && alltrue([for binding in google_project_iam_member.ci : binding.member == "serviceAccount:${output.ci_service_account_email}"])
    )
    error_message = "The two outputs are exactly the two literals the workflow carries, and every project role is granted to the CI account and to no other member."
  }

  assert {
    condition = alltrue([
      for member in concat(
        [google_service_account_iam_member.ci_from_github.member, google_service_account_iam_member.ci_acts_as_push.member],
        [for binding in google_project_iam_member.ci : binding.member],
      ) : !strcontains(member, "principalSet") && !strcontains(member, "*")
    ])
    error_message = "No member here is a principalSet:// or carries a wildcard. A principalSet is a set, and the set that matches this repository matches every job in it."
  }
}
