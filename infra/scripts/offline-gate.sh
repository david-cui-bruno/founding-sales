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

# An account id written into Terraform is an account this tree can only ever deploy
# into, and the owner is moving the rehearsal and production into dedicated accounts
# (`docs/greenfield/accounts.md`). Every root takes `aws_account_id` as a variable and
# builds every ARN from it, so the one place twelve digits may appear outside a test
# fixture is that variable's own `default` — which is what keeps today's behaviour for
# a caller who states no account.
#
# A comment is prose rather than a decision the file makes, and this scan is twelve
# digits anywhere on the line: `infra/roots/rehearsal/main.tf` names the bucket a real
# rehearsal run left behind (g37), and that name ends in the account it was left in.
# `test/release/accountAgnostic.check.ts` reads comments too, with a pattern that
# admits twelve digits only where they really are an account id, so an ARN written
# into a comment is still refused there.
account_literals=$(grep -rInE '[0-9]{12}' --include='*.tf' infra/modules infra/roots \
  | grep -v '/tests/' \
  | grep -vE ':[0-9]+: *#' \
  | grep -vE ':[0-9]+: *default +=' || true)
if [ -n "$account_literals" ]; then
  echo "FAIL: a Terraform file names an account id outside a variable default"
  echo "$account_literals"
  fail=1
fi

# And the backend files are the per-account files, so each one must name a bucket, a
# region and a lock table. A file that lost one would init against whatever backend
# the caller's own configuration or environment supplies, silently.
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
# pull request. `docs/decisions/g12j-the-alert-key-is-a-boolean-not-a-null-check.md`.
check "a count or for_each must not test for null a value another apply computes" \
  '^[^#]*(count|for_each) *=[^#]*(var|local|module|data)\.[A-Za-z0-9_.]+ *(==|!=) *null' infra

# Google Cloud belongs to one root and one module.
#
# A required provider is a *configured* provider: Terraform configures every
# provider a module declares before it evaluates anything, so `module "pubsub"`
# with `count = 0` in `infra/modules/stack` still made every rehearsal plan ask
# for Google application-default credentials, and CI has none (David's third
# credentialed rehearsal, 21 September 2026). `infra/roots/production` is the
# only root with a Google Cloud project; `infra/modules/pubsub` is the module it
# calls. Anywhere else, including a `mock_provider "google"` in a test file of
# another root, is the refusal coming back.
# `docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
google_files=$(grep -rIlE '^[^#]*(hashicorp/google|provider "google"|/pubsub")' \
  --include='*.tf' --include='*.tftest.hcl' infra \
  | grep -v '^infra/modules/pubsub/' \
  | grep -v '^infra/roots/production/' || true)
if [ -n "$google_files" ]; then
  echo "FAIL: only infra/roots/production and infra/modules/pubsub may name the Google provider or the pubsub module"
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
if [ "$production_key" = "$rehearsal_key" ]; then
  echo "FAIL: the two roots share a state key"
  fail=1
fi
if [ "$(printf '%s\n%s\n%s\n' "$production_key" "$rehearsal_key" "$rehearsal_registry_key" | sort -u | wc -l | tr -d ' ')" != "3" ]; then
  echo "FAIL: the three roots do not have three distinct state keys"
  fail=1
fi
case "$production_key" in fss/greenfield/production/*) ;; *) echo "FAIL: production state key is not under fss/greenfield/production/"; fail=1 ;; esac
case "$rehearsal_key" in fss/greenfield/rehearsal/*) ;; *) echo "FAIL: rehearsal state key is not under fss/greenfield/rehearsal/"; fail=1 ;; esac
case "$rehearsal_registry_key" in fss/greenfield/rehearsal-registry/*) ;; *) echo "FAIL: rehearsal registry state key is not under fss/greenfield/rehearsal-registry/"; fail=1 ;; esac
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
