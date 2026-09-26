#!/usr/bin/env bash
# Prove the session about to run rehearsal Terraform is the rehearsal deployment role.
#
#   infra/scripts/rehearsal-caller-identity.sh [fss-rh-deploy]
#
# ## Why this exists
#
# All three roots used to assume `deployment_role_name` unconditionally. In CI that is
# a second assumption from a session that already *is* `fss-rh-deploy`, which needs the
# role to trust itself; it does not, and Appendix G 39 is the reason it must not. So
# `assume_deployment_role` exists and both rehearsal workflows pass
# `-var=assume_deployment_role=false`
# (`docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`).
#
# That flag moves the question "which principal is this apply?" out of the Terraform
# configuration and into the job's ambient credentials. Answering it is this script's
# whole job: it prints `aws sts get-caller-identity --query Arn` — an ARN is a public
# identifier — and refuses anything that is not
# `arn:aws:sts::<account>:assumed-role/fss-rh-deploy/<session>`. A user ARN, another
# role, a role whose name merely begins the same way, or no identity at all is a
# refusal, so the flag cannot become a way to run a rehearsal apply as somebody else.
#
# The role named must be in the `fss-rh-` namespace. The production applies are local
# commands where the provider does the assuming (`infra-apply-runbook.md` 3.2), so
# there is nothing here for production to use and this refuses to be pointed at it.
#
# Dry run: `FSS_REHEARSAL_DRY_RUN=1` prints the two lines it would run and needs no
# credential, which is how the release workflow's pull-request job reads it.
# Offline test: set `FSS_REHEARSAL_CALLER_IDENTITY` to the ARN to judge, and no AWS
# call is made at all.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

ROLE=${1:-fss-rh-deploy}
rehearsal_refuse_production_arguments "$ROLE"
rehearsal_require_deployment_session "$ROLE"

if ! rehearsal_dry_run || [ "${FSS_REHEARSAL_CALLER_IDENTITY+set}" = "set" ]; then
  rehearsal_write_report "caller-identity.txt" "role=$ROLE assumed_role_session=true"
fi
