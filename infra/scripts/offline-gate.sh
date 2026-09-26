#!/usr/bin/env bash
# The same offline gate the greenfield-infra workflow runs, so it can be run
# by hand from the repository root before pushing.
#
#   TERRAFORM=/path/to/terraform infra/scripts/offline-gate.sh
#
# Never configures a backend, never runs plan or apply against one, and never
# needs an AWS or Google credential.
set -euo pipefail

terraform_bin=${TERRAFORM:-terraform}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

echo "==> terraform fmt"
"$terraform_bin" fmt -check -recursive infra

echo "==> structural policy checks"
fail=0
check() {
  local description=$1 pattern=$2
  shift 2
  if grep -rInE "$pattern" "$@" >/dev/null 2>&1; then
    echo "FAIL: $description"
    grep -rInE "$pattern" "$@" || true
    fail=1
  fi
}

check "infra must declare no NAT gateway and no VPC endpoint" \
  'resource "aws_(nat_gateway|eip|vpc_endpoint[a-z_]*)"' infra

check "infra must never write a secret value or generate a password" \
  'resource "(aws_secretsmanager_secret_version|aws_ssm_parameter|random_password|random_string|random_id)"' infra

check "security-group rules must come from the network module inventory" \
  'resource "aws_(security_group_rule|vpc_security_group_(in|e)gress_rule)"' \
  infra/modules/cluster infra/modules/database infra/modules/edge infra/modules/stack infra/roots

check "a greenfield root must never point at a legacy state key" \
  '^[^#]*cloud/(terraform|delegated-worker)' infra/roots

# FSS runs in one AWS account. Its id, and the ARNs of the production values committed
# with it (the certificate), are literals in the roots, which are where an environment is
# decided. A module is handed its account by the root that calls it, so twelve digits in
# a module outside a comment, a variable default or a test fixture is an ARN that should
# have been built from `var.aws_account_id`.
account_literals=$(grep -rInE '[0-9]{12}' --include='*.tf' infra/modules \
  | grep -v '/tests/' \
  | grep -vE ':[0-9]+: *#' \
  | grep -vE ':[0-9]+: *default +=' || true)
if [ -n "$account_literals" ]; then
  echo "FAIL: a module names an account id instead of taking it from its root"
  echo "$account_literals"
  fail=1
fi

# Each backend file must name a bucket, a region, a lock table and a key. A file that
# lost one would init against whatever backend the caller's own configuration or
# environment supplies, silently.
for backend_file in infra/roots/*/backend.hcl; do
  for backend_setting in bucket region dynamodb_table key; do
    if ! grep -qE "^${backend_setting} +=" "$backend_file"; then
      echo "FAIL: $backend_file names no $backend_setting"
      fail=1
    fi
  done
done

# The class of error the third credentialed rehearsal stopped on (21 September
# 2026): `count = var.kms_key_arn == null ? 1 : 0`, where the ARN belongs to a
# key the same apply creates. Terraform refuses such a plan before it touches
# AWS, and no offline layer here could see it, because `validate` never
# evaluates a count and the module's own tests passed a literal. The fix is
# always an input the caller states; the grep is so the next one is caught in a
# pull request. `docs/archive/decisions/g12j-the-alert-key-is-a-boolean-not-a-null-check.md`.
check "a count or for_each must not test for null a value another apply computes" \
  '^[^#]*(count|for_each) *=[^#]*(var|local|module|data)\.[A-Za-z0-9_.]+ *(==|!=) *null' infra

# Google Cloud belongs to one root and one module.
#
# A required provider is a *configured* provider: Terraform configures every
# provider a module declares before it evaluates anything, so `module "pubsub"`
# with `count = 0` in `infra/modules/stack` still made every rehearsal plan ask
# for Google application-default credentials, and CI has none (David's third
# credentialed rehearsal, 21 September 2026). `infra/roots/production-google` is the
# only root with a Google provider (lane g85, audit O01); `infra/modules/pubsub` is the
# module it calls. The production root lost its Google provider in the same lane, so a
# production plan asks for no Google credential either. Anywhere else, including a `mock_provider "google"` in a test file of
# another root, is the refusal coming back.
# `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
google_files=$(grep -rIlE '^[^#]*(hashicorp/google|provider "google"|/pubsub")' \
  --include='*.tf' --include='*.tftest.hcl' infra \
  | grep -v '^infra/modules/pubsub/' \
  | grep -v '^infra/roots/production-google/' || true)
if [ -n "$google_files" ]; then
  echo "FAIL: only infra/roots/production-google and infra/modules/pubsub may name the Google provider or the pubsub module"
  echo "$google_files"
  fail=1
fi

if [ "$(grep -c 'resource "aws_vpc_security_group_ingress_rule"' infra/modules/network/main.tf)" != "1" ] \
   || [ "$(grep -c 'resource "aws_vpc_security_group_egress_rule"' infra/modules/network/main.tf)" != "1" ]; then
  echo "FAIL: the network module must generate its rules from exactly one for_each resource per direction"
  fail=1
fi

production_key=$(grep -E '^key ' infra/roots/production/backend.hcl | cut -d'"' -f2)
rehearsal_key=$(grep -E '^key ' infra/roots/rehearsal/backend.hcl | cut -d'"' -f2)
rehearsal_registry_key=$(grep -E '^key ' infra/roots/rehearsal-registry/backend.hcl | cut -d'"' -f2)
production_google_key=$(grep -E '^key ' infra/roots/production-google/backend.hcl | cut -d'"' -f2)
if [ "$production_key" = "$rehearsal_key" ]; then
  echo "FAIL: the two roots share a state key"
  fail=1
fi
if [ "$(printf '%s\n%s\n%s\n%s\n' "$production_key" "$rehearsal_key" "$rehearsal_registry_key" "$production_google_key" | sort -u | wc -l | tr -d ' ')" != "4" ]; then
  echo "FAIL: the four roots do not have four distinct state keys"
  fail=1
fi
case "$production_key" in fss/greenfield/production/*) ;; *) echo "FAIL: production state key is not under fss/greenfield/production/"; fail=1 ;; esac
case "$rehearsal_key" in fss/greenfield/rehearsal/*) ;; *) echo "FAIL: rehearsal state key is not under fss/greenfield/rehearsal/"; fail=1 ;; esac
case "$rehearsal_registry_key" in fss/greenfield/rehearsal-registry/*) ;; *) echo "FAIL: rehearsal registry state key is not under fss/greenfield/rehearsal-registry/"; fail=1 ;; esac
case "$production_google_key" in fss/greenfield/production-google/*) ;; *) echo "FAIL: production Google state key is not under fss/greenfield/production-google/"; fail=1 ;; esac
# The per-run key is fss/greenfield/rehearsal/<run>/terraform.tfstate and "registry"
# is a legal run suffix, so the durable repositories must not live inside that space:
# a run that collided with them would destroy them on teardown.
case "$rehearsal_registry_key" in
  fss/greenfield/rehearsal/*)
    echo "FAIL: the rehearsal registry state key is inside the per-run space and a run could collide with it"
    fail=1
    ;;
esac
# The per-run rehearsal root must not create repositories: they have to exist before
# the run does, and a run's teardown would take them away.
if ! grep -q 'create_registry = false' infra/roots/rehearsal/main.tf; then
  echo "FAIL: the per-run rehearsal root must pass create_registry = false"
  fail=1
fi
if grep -rInE '(access_key|secret_key|token|password)' infra/roots/*/backend.hcl >/dev/null 2>&1; then
  echo "FAIL: a backend file carries a credential-looking value"
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
echo "structural policy checks passed"

echo "==> validate and test every module and root"
status=0
while IFS= read -r directory; do
  echo "--- $directory"
  (
    cd "$directory"
    "$terraform_bin" init -backend=false -input=false -no-color >/dev/null
    "$terraform_bin" validate -no-color
    if compgen -G "tests/*.tftest.hcl" >/dev/null; then
      "$terraform_bin" test -no-color
    else
      echo "no test files in $directory"
    fi
  ) || status=1
done < <(find infra/modules infra/roots -mindepth 1 -maxdepth 1 -type d | sort)

exit "$status"
