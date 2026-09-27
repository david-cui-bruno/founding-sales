# The one Google provider in `infra/roots`.
#
# It authenticates with whatever application-default credential the process holds, and
# from lane G-WIF that is `.github/workflows/greenfield-google.yml`'s: GitHub's OIDC token,
# exchanged at the workload identity pool in `ci_identity.tf` for a short-lived token of
# `fss-prod-google-ci`, which `google-github-actions/auth` writes as a temporary
# external-account file. This root is planned and applied through that workflow and not
# from a Mac:
#
#   gh workflow run greenfield-google.yml --ref main -f stage=plan
#   gh workflow run greenfield-google.yml --ref main -f stage=apply -f plan_run_id=<that run>
#
# An application-default credential from a browser login is for **this one bootstrap** —
# the apply that first created the pool, the provider and the service account — and
# afterwards only for a human repair of that identity plumbing, which CI is refused by
# construction. It lapses about every 17 hours under the Workspace reauthentication
# policy, which is exactly why it is no longer what a plan of this root waits on (audit
# O01, `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`).
# `docs/greenfield/infra-apply-runbook.md` 1.3a is the page for it. Never a key file, in
# either path.
#
# There is no `credentials` and no `access_token` argument. An absent credential is
# therefore the loud "Attempted to load application default credentials" refusal
# at provider configuration, never a quiet apply as some other identity.
provider "google" {
  project = local.gcp_project_id
  region  = local.gcp_region
}
