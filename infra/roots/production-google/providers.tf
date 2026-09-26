# The one Google provider in `infra/roots`.
#
# It authenticates with the operator's application-default credentials for the
# account that administers `callie-fss` (callie@usecallie.com), which lapse about
# every 17 hours under the Workspace reauthentication policy. That is acceptable
# here and was not acceptable in `infra/roots/production`: this root is planned
# and applied only when a Gmail push object itself has to change, which is rarely,
# while the production root is planned for every image release, and an expired
# login once held a worker fix back for that reason alone (audit O01,
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`).
#
# Before any plan here, renew and check the credential exactly as
# `docs/greenfield/infra-apply-runbook.md` 1.3a says, and never with a key file:
#
#   gcloud auth application-default login
#   gcloud auth application-default print-access-token >/dev/null && echo "ADC token mints"
#
# There is no `credentials` and no `access_token` argument. An absent credential is
# therefore the loud "Attempted to load application default credentials" refusal
# at provider configuration, never a quiet apply as some other identity.
provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}
