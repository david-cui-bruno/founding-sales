# Moving the Gmail push objects into their own root

**Lane:** g85 · **Audit:** O01 · **Decision:** `docs/decisions/g85-the-google-provider-has-its-own-root.md`
**Who:** the operator, once, locally, with the AWS admin profile and Google application-default credentials.
**Release class:** state only. No Google object and no AWS resource is created, replaced or deleted, and nothing is deployed.

## What this does

Four Google Cloud objects move from `infra/roots/production`'s state to
`infra/roots/production-google`'s:

| Object | Old address (production state) | New address (Google state) |
|---|---|---|
| push service account `fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com` | `module.pubsub[0].google_service_account.push` | `module.pubsub.google_service_account.push` |
| topic `projects/callie-fss/topics/fss-prod-gmail-push` | `module.pubsub[0].google_pubsub_topic.gmail` | `module.pubsub.google_pubsub_topic.gmail` |
| Gmail's publisher grant on the topic | `module.pubsub[0].google_pubsub_topic_iam_member.gmail_publisher` | `module.pubsub.google_pubsub_topic_iam_member.gmail_publisher` |
| push subscription `fss-prod-gmail-push` | `module.pubsub[0].google_pubsub_subscription.gmail_push` | `module.pubsub.google_pubsub_subscription.gmail_push` |

The new state object is `fss/greenfield/production-google/terraform.tfstate`, in the same
bucket and lock table as production's. The production state object keeps its key; nothing
is renamed or deleted in the bucket.

The Gmail watch keeps delivering throughout. It needs the topic, Gmail's publisher grant
and the subscription to exist, and no step below writes to any of them. At most, step 2
re-sets the topic's and the subscription's labels to the values they already have.

## Why this method

`terraform state mv` works within one state. It cannot move an address from one backend
to another. Three ways were considered:

1. **`import` blocks in the new root, then `terraform state rm` in the old one.** Chosen.
   - The new root's first plan lists the four objects as "will be imported". It also
     shows every attribute where Google's live object differs from the configuration,
     before anything is written. The apply writes only state.
   - `terraform state rm` changes only the production state. It needs no Google
     credential and no production `-var` list. It runs under the state lock and is
     backed up first with `terraform state pull`.
   - The migration never runs a production apply, so it cannot mix with an image or
     infrastructure change that is waiting to be applied.
   - Every step can be run again: an imported address is not imported twice, and step 3
     is skipped when the addresses are already gone.
2. **Carry the state objects between local copies** (`state pull`, `state mv -state-out`,
   `state push`). This moves the exact objects, but it writes the new state before any
   plan can be read. Kept as **fallback B**, for one case only: step 2's plan shows a
   difference that comes from how the provider imports, rather than from real drift.
3. **A `removed` block applied in production.** The block is in the production root, but
   only as a safety net. Applying it would need Google credentials, because the state
   still names Google objects. It would also need a full production apply with the
   release's variables. `terraform state rm` does the same job with neither.

**The safety net.** `infra/roots/production/main.tf` contains
`removed { from = module.pubsub  lifecycle { destroy = false } }`. Suppose somebody plans
production at this commit before step 3. That plan still needs application-default
credentials, and it shows the four objects as **"will no longer be managed by
Terraform"**, not as four deletions. Once step 3 is done, the block matches nothing.

## Before you start

- A checkout at the `main` commit that contains lane g85, from a directory that
  survives a reboot (not `/tmp`).
- **Terraform 1.15.8.** On David's Mac, the `terraform` on `PATH` is Homebrew's 1.5.7,
  and it refuses these roots. The commands below use `$TF`.
- The AWS admin profile. Both states are read and written with it.
  `fss-prod-deploy` never touches state: its policy denies it `s3:GetObject*` on every
  object.
- Application-default credentials for `callie@usecallie.com`, renewed within the
  last few hours (`docs/greenfield/infra-apply-runbook.md` 1.3a). `gcloud` must also be
  signed in as the same account, for the read-backs.
- `jq`.
- No production apply or deploy in progress. The state lock would stop a clash anyway.
  A rehearsal run in progress does not matter: nothing here changes an AWS resource.

## Step 0: set up, and read the Google side as it is

```bash
cd <repository root>
export TF="${TF:-$HOME/.local/bin/terraform}"
"$TF" version | head -1                                   # Terraform v1.15.8
export AWS_PROFILE=<admin profile>
export STATE_KEY_ARN='<production state key arn>'         # the kms_key_id infra/roots/production is initialised with
export MIG="$HOME/conductor/scratch/fss-google-root-migration"
mkdir -p "$MIG" && chmod 700 "$MIG"

aws sts get-caller-identity --query Account --output text  # 326255650484
gcloud auth application-default print-access-token >/dev/null && echo "ADC token mints"
```

If an initialised production directory already exists, `STATE_KEY_ARN` can be read from
it without typing:
`jq -r '.backend.config.kms_key_id' <that directory>/.terraform/terraform.tfstate`.
It is a public identifier. Never print a token or open a credentials file.

Read the four objects back. Each command only reads:

```bash
[ -f "$MIG/subscription.before.json" ] || {
  gcloud pubsub topics describe fss-prod-gmail-push --project callie-fss --format=json > "$MIG/topic.before.json"
  gcloud pubsub subscriptions describe fss-prod-gmail-push --project callie-fss --format=json > "$MIG/subscription.before.json"
  gcloud pubsub topics get-iam-policy fss-prod-gmail-push --project callie-fss --format=json > "$MIG/topic-iam.before.json"
  gcloud iam service-accounts describe fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com \
    --project callie-fss --format=json > "$MIG/sa.before.json"
}
jq -r '.pushConfig.pushEndpoint, .pushConfig.oidcToken.audience, .pushConfig.oidcToken.serviceAccountEmail' \
  "$MIG/subscription.before.json"
```

Expected:

```
https://api.usecallie.com/integrations/gmail/push
https://api.usecallie.com/integrations/gmail/push
fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com
```

The `[ -f … ]` guard keeps a rerun from overwriting the first read-back.

## Step 1: production state, backed up and compared with the committed identifiers

```bash
cd infra/roots/production
"$TF" init -reconfigure -input=false \
  -backend-config=backend.hcl -backend-config="kms_key_id=$STATE_KEY_ARN"
```

Expected: `Terraform has been successfully initialized!`. While the state still names the
four objects, init also installs `hashicorp/google` for them. It does this even though
the configuration no longer requires that provider. This is only a download and needs no
credential.

Back up once, and never overwrite the backup on a rerun:

```bash
[ -f "$MIG/production.before.tfstate" ] || {
  "$TF" state pull > "$MIG/production.before.tfstate"
  chmod 600 "$MIG/production.before.tfstate"
  jq -r '.serial' "$MIG/production.before.tfstate" > "$MIG/production.before.serial"
}
"$TF" state list | grep '^module\.pubsub'
```

Expected on the first run: exactly four lines.

```
module.pubsub[0].google_pubsub_subscription.gmail_push
module.pubsub[0].google_pubsub_topic.gmail
module.pubsub[0].google_pubsub_topic_iam_member.gmail_publisher
module.pubsub[0].google_service_account.push
```

No lines means step 3 has already run. That also happens if somebody applied the
"no longer managed" plan the safety net produces. Either way, carry on: step 2 still
adopts the objects and step 3 is skipped.

Compare the identifiers production's state recorded at its last apply with the defaults
this commit gives the production root. `terraform output` reads state and calls no
provider.

```bash
"$TF" output -raw gmail_push_topic_id; echo
"$TF" output -raw gmail_push_service_account; echo
"$TF" output -raw gmail_push_audience; echo
grep -E '^  default     = "(projects/|fss-prod-gmail-push@)' variables.tf
```

Expected: the first two outputs are exactly the two defaults the `grep` prints.

```
projects/callie-fss/topics/fss-prod-gmail-push
fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com
https://api.usecallie.com/integrations/gmail/push
  default     = "projects/callie-fss/topics/fss-prod-gmail-push"
  default     = "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
```

**If either output differs from its default, stop.** The default is wrong. The next
production apply would change `FSS_GMAIL_PUSH_TOPIC` or `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` in
both task definitions, and the webhook or the watch would break. Fix the default in a
pull request first.

## Step 2: the Google root adopts the four objects

```bash
cd ../production-google
"$TF" init -reconfigure -input=false \
  -backend-config=backend.hcl -backend-config="kms_key_id=$STATE_KEY_ARN"
"$TF" state list
```

On the first run, `state list` answers `No state file was found!` and exits 1. That is
expected. On a rerun it lists the four `module.pubsub.*` addresses. In that case skip to
"After the apply" below.

```bash
"$TF" plan -input=false -out="$MIG/google.tfplan" -var="api_hostname=api.usecallie.com"
"$TF" show -no-color "$MIG/google.tfplan" > "$MIG/google.plan.txt"
grep -E '^Plan: ' "$MIG/google.plan.txt"
grep -nE 'must be replaced|forces replacement|will be destroyed|will be created' "$MIG/google.plan.txt" \
  || echo "no create, replace or destroy"
"$TF" show -json "$MIG/google.tfplan" \
  | jq -r '.resource_changes[] | "\(.address) \(.change.actions | join(",")) importing=\(.change.importing != null)"'
```

Expected:

```
Plan: 4 to import, 0 to add, 0 to change, 0 to destroy.
no create, replace or destroy
module.pubsub.google_pubsub_subscription.gmail_push no-op importing=true
module.pubsub.google_pubsub_topic.gmail no-op importing=true
module.pubsub.google_pubsub_topic_iam_member.gmail_publisher no-op importing=true
module.pubsub.google_service_account.push no-op importing=true
```

The plan also lists six outputs under "Changes to Outputs". They are the values step 1
printed, plus `gcp_project_id = "callie-fss"`, `gmail_push_topic_name` and
`gmail_push_subscription_name`, both `"fss-prod-gmail-push"`.

**One variant is acceptable.** Since Google provider 5.0, an import records `labels` and
`terraform_labels` as empty, so the topic and the subscription may plan as
`update importing=true`, and the summary reads
`Plan: 4 to import, 0 to add, 2 to change, 0 to destroy.` This is acceptable only if
every changed attribute is on the allow-list:

- `labels`, `terraform_labels` or `effective_labels`, being set to the
  `environment = "production"` and `managed_by = "terraform"` labels the objects already
  carry;
- `create_ignore_already_exists` on the service account, a Terraform-side argument that
  is never sent to Google.

List the changed attributes:

```bash
"$TF" show -json "$MIG/google.tfplan" | jq -r '
  .resource_changes[] | select(.change.actions != ["no-op"])
  | .address as $a | (.change.before // {}) as $b | (.change.after // {}) as $c
  | ([$b, $c] | map(keys) | add | unique)[] | select($b[.] != $c[.]) | "\($a) \(.)"'
```

Expected: nothing, or only lines ending in the allowed attributes.

**Do not apply, and change nothing, if any of these appear.** Nothing has been written
yet.

- a count other than 0 to add or 0 to destroy;
- `must be replaced`, `forces replacement`, `will be created` or `will be destroyed`;
- a change to `push_config`, `oidc_token`, `push_endpoint`, `audience`,
  `service_account_email`, `topic`, `name`, `account_id`, `display_name`, `description`,
  `ack_deadline_seconds`, `message_retention_duration`, `retry_policy`,
  `expiration_policy`, `role`, `member` or `project`;
- `Cannot import non-existent remote object`, which means the names do not point at the
  objects.

Delete `$MIG/google.tfplan`. If step 1's outputs matched and the only fault is how the
provider imported an object, use fallback B below. For anything else, report the whole
plan before doing more.

Apply the plan you read:

```bash
"$TF" apply -input=false "$MIG/google.tfplan"
```

Expected: `Apply complete! Resources: 4 imported, 0 added, 0 changed, 0 destroyed.` In the
label variant, `2 changed` instead of `0 changed`.

### After the apply

```bash
"$TF" plan -input=false -detailed-exitcode -var="api_hostname=api.usecallie.com"; echo "exit $?"
"$TF" state list
"$TF" output -raw gmail_push_topic_id; echo
"$TF" output -raw gmail_push_service_account; echo
"$TF" output -raw gmail_push_audience; echo
```

Expected:

- `No changes. Your infrastructure matches the configuration.` and `exit 0`;
- the four addresses, without the `[0]`:

  ```
  module.pubsub.google_pubsub_subscription.gmail_push
  module.pubsub.google_pubsub_topic.gmail
  module.pubsub.google_pubsub_topic_iam_member.gmail_publisher
  module.pubsub.google_service_account.push
  ```

- the same three identifiers step 1 printed.

Both states now name the four objects. That is harmless while it lasts: neither root
plans to create or destroy them. Go on to step 3 in the same session.

## Step 3: the production state forgets the four addresses

```bash
cd ../production
if "$TF" state list | grep -q '^module\.pubsub'; then
  "$TF" state rm -dry-run 'module.pubsub[0]'
  "$TF" state rm -lock-timeout=5m 'module.pubsub[0]'
else
  echo "module.pubsub is already absent from the production state"
fi
```

The dry run prints the same four lines with `Would remove`. The removal prints:

```
Removed module.pubsub[0].google_pubsub_subscription.gmail_push
Removed module.pubsub[0].google_pubsub_topic.gmail
Removed module.pubsub[0].google_pubsub_topic_iam_member.gmail_publisher
Removed module.pubsub[0].google_service_account.push
Successfully removed 4 resource instance(s).
```

This is `terraform state rm 'module.pubsub[0]'` and nothing else. It edits the state and
calls neither Google nor AWS.

## Step 4: proof that production needs no Google and plans no Google change

```bash
"$TF" state list | grep -c '^module\.pubsub'          # 0
"$TF" providers | grep -c 'hashicorp/google'           # 0
echo "serial $(cat "$MIG/production.before.serial") -> $("$TF" state pull | jq -r .serial)"
```

Expected: `0`, `0`, and a serial one higher than the backup's. The first two print `0`
and exit 1, which is how `grep -c` reports no match. `terraform providers` lists the
providers the configuration requires and the ones the state requires. After step 3,
neither list has Google.

Now plan production with no Google credential reachable at all. `CLOUDSDK_CONFIG`
pointing at an empty directory hides the application-default credentials file from the
Google libraries, and the three `-u` remove every environment path to one:

```bash
NO_GOOGLE="$(mktemp -d "$MIG/no-google.XXXXXX")"
env -u GOOGLE_APPLICATION_CREDENTIALS -u GOOGLE_CREDENTIALS -u GOOGLE_OAUTH_ACCESS_TOKEN \
  CLOUDSDK_CONFIG="$NO_GOOGLE" \
  "$TF" plan -input=false -detailed-exitcode -out="$MIG/production.after.tfplan" \
    -var="certificate_arn=<production certificate arn>" \
    -var="api_hostname=api.usecallie.com" \
    -var="api_image=<the api digest production runs>" \
    -var="worker_image=<the worker digest production runs>" \
    -var='api_schema_range={min=<N>,max=<N>}' \
    -var='worker_schema_range={min=<N>,max=<N>}' \
    -var='alert_emails=["callie@usecallie.com"]' \
    <any other -var your last production apply passed, except gcp_project_id>
echo "exit $?"
```

The values are those of the last production apply: the digests and ranges come from its
release manifest (`release-manifest.deployed.json`). **Do not pass `gcp_project_id`.** The
production root no longer declares it, and Terraform refuses it with
`Value for undeclared variable`.

Expected:

- the plan runs to the end. There is no `Attempted to load application default
  credentials`, and no line naming `provider["registry.terraform.io/hashicorp/google"]`.
  Before lane g85, this exact command stopped at provider configuration;
- `No changes. Your infrastructure matches the configuration.` and `exit 0`, if nothing
  else merged to `main` is waiting to be applied.

If other merged infrastructure is waiting (`exit 2`), the proof is these two commands:

```bash
"$TF" show -no-color "$MIG/production.after.tfplan" | grep -nE 'google_|module\.pubsub' \
  || echo "no Google resource in the plan"
"$TF" show -json "$MIG/production.after.tfplan" | jq -r '
  .resource_changes[] | select(.type == "aws_ecs_task_definition")
  | .change.after.container_definitions // empty | fromjson | .[].environment[]?
  | select(.name | startswith("FSS_GMAIL_PUSH")) | "\(.name)=\(.value)"' | sort -u
```

Expected:

```
no Google resource in the plan
FSS_GMAIL_PUSH_AUDIENCE=https://api.usecallie.com/integrations/gmail/push
FSS_GMAIL_PUSH_SERVICE_ACCOUNT=fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com
FSS_GMAIL_PUSH_TOPIC=projects/callie-fss/topics/fss-prod-gmail-push
```

**Do not apply this plan as part of the migration.** The migration is complete without a
production apply. The next ordinary release applies as usual, and it needs no Google
login.

## Step 5: the Google side, read again

```bash
gcloud pubsub topics describe fss-prod-gmail-push --project callie-fss --format=json > "$MIG/topic.after.json"
gcloud pubsub subscriptions describe fss-prod-gmail-push --project callie-fss --format=json > "$MIG/subscription.after.json"
gcloud pubsub topics get-iam-policy fss-prod-gmail-push --project callie-fss --format=json > "$MIG/topic-iam.after.json"
gcloud iam service-accounts describe fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com \
  --project callie-fss --format=json > "$MIG/sa.after.json"
for object in topic subscription topic-iam sa; do
  diff "$MIG/$object.before.json" "$MIG/$object.after.json" && echo "$object unchanged"
done
```

Expected: `topic unchanged`, `subscription unchanged`, `topic-iam unchanged`,
`sa unchanged`.

Then confirm that the webhook refused no push since you started:

```bash
API_LOG_GROUP="$("$TF" output -json log_group_names | jq -r '.api')"
aws logs filter-log-events --log-group-name "$API_LOG_GROUP" \
  --start-time "$(( ($(date +%s) - 7200) * 1000 ))" \
  --filter-pattern '{ $.event = "refusal" && $.path = "/integrations/gmail/push" }' \
  --query 'events[].message' --output text
```

Expected: empty output. A `gmail_push_audience_mismatch` or
`gmail_push_service_account_mismatch` here means the identifiers disagree. No step above
can cause that, but this is where it would show.

## Step 6: tidy up

Keep `$MIG/production.before.tfstate` until the next production release has applied
cleanly. It is the exact rollback for step 3. It holds identifiers and no secret value
(`infra/README.md`, "No secret value, ever"), but it is still a production state, so keep
it at mode 600 and delete it afterwards:
`rm -f "$MIG/production.before.tfstate" "$MIG"/*.tfplan`. Record the outcome in the
running log.

From now on:

- **Production plans need no Google login.** `docs/greenfield/infra-apply-runbook.md`
  1.3a, the `-var="gcp_project_id=…"` lines in its 3.0 and 3.2, and `release.md` 1.7 and
  the `gcp_project_id` row in section 4 describe the tree before lane g85
  (`release.md` 8.0ar).
- **`infra/roots/production-google` is planned only when a Gmail push object changes.**
  Renew application-default credentials first, init as in step 2, and plan with
  `-var="api_hostname=api.usecallie.com"`. A plan with no change reads `No changes.`
  Never run `terraform destroy` there.
- **Never plan production from a commit older than lane g85.** That root would try to
  create `module.pubsub[0]` again. Google would refuse the duplicate names, so nothing
  would be destroyed, but the apply would fail.

## Rollback

Which rollback you need depends on how far you got.

**Stopped in step 2 before the apply.** Nothing was written. Delete `$MIG/google.tfplan`.
The production root, at the old commit, still owns the objects.

**After step 2's apply, before step 3.** Only the Google root's state changed. To undo it:

```bash
cd infra/roots/production-google
"$TF" state rm 'module.pubsub'     # Successfully removed 4 resource instance(s).
```

Google is untouched and production still names the objects.

**After step 3.** Handing the objects back to the production root also means going back
to production code that manages them. The current root has no `module.pubsub` and has
the `removed` block. So:

1. Merge a revert of lane g85, which restores `provider "google"`, `module.pubsub` and the
   three variables. Check it out.
2. Restore the production state. If nothing has written it since step 3, the backup is
   exact, and the serial check proves nothing has:

   ```bash
   cd infra/roots/production
   test "$("$TF" state pull | jq -r .serial)" -eq "$(( $(cat "$MIG/production.before.serial") + 1 ))" \
     && "$TF" state push -force "$MIG/production.before.tfstate"
   ```

   `-force` is needed only because the backup's serial is lower than the current one.
   If the test fails, a production apply has happened since step 3, so do **not** push.
   Re-import instead, at the reverted commit, with application-default credentials and
   your production `-var` list plus `-var="gcp_project_id=callie-fss"`:

   ```bash
   "$TF" import <production -var list> 'module.pubsub[0].google_service_account.push' \
     'projects/callie-fss/serviceAccounts/fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com'
   "$TF" import <production -var list> 'module.pubsub[0].google_pubsub_topic.gmail' \
     'projects/callie-fss/topics/fss-prod-gmail-push'
   "$TF" import <production -var list> 'module.pubsub[0].google_pubsub_topic_iam_member.gmail_publisher' \
     'projects/callie-fss/topics/fss-prod-gmail-push roles/pubsub.publisher serviceAccount:gmail-api-push@system.gserviceaccount.com'
   "$TF" import <production -var list> 'module.pubsub[0].google_pubsub_subscription.gmail_push' \
     'projects/callie-fss/subscriptions/fss-prod-gmail-push'
   ```

3. `cd ../production-google && "$TF" state rm 'module.pubsub'`.
4. Plan production at the reverted commit, with application-default credentials. It must
   show no change to any `module.pubsub[0]` address.

Never use `terraform destroy` in either root to undo anything. Never leave the objects
removed from both states: they would still exist, but no root would manage them until
somebody imported them again.

## Fallback B: carry the state objects instead of importing them

Use this only when step 2's plan was refused for a difference outside the allow-list,
**and** step 1's outputs matched. That combination means the difference comes from how
the provider imports, not from the objects having drifted. The exact objects production
recorded plan with no change, because they were written by the same configuration.

```bash
cd infra/roots/production
test "$("$TF" state pull | jq -r .serial)" -eq "$(cat "$MIG/production.before.serial")"   # the backup is current

WORK="$MIG/carry"
mkdir -p "$WORK" && cd "$WORK"           # an empty directory: no configuration, local state only
cp "$MIG/production.before.tfstate" production.work.tfstate
"$TF" state mv -state=production.work.tfstate -state-out=google.new.tfstate 'module.pubsub[0]' 'module.pubsub'
```

Expected: `Move "module.pubsub[0]" to "module.pubsub"` and `Successfully moved 1 object(s).`

```bash
cd <repository root>/infra/roots/production-google
"$TF" state list                         # must still say: No state file was found!
"$TF" state push "$WORK/google.new.tfstate"
"$TF" plan -input=false -detailed-exitcode -var="api_hostname=api.usecallie.com"; echo "exit $?"
```

Push only onto an empty Google state. Expected result: no resource changes, only the six
outputs under "Changes to Outputs", and `exit 2`. Write the outputs, which touches no
object:

```bash
"$TF" apply -input=false -var="api_hostname=api.usecallie.com"   # Resources: 0 added, 0 changed, 0 destroyed.
"$TF" plan -input=false -detailed-exitcode -var="api_hostname=api.usecallie.com"; echo "exit $?"   # No changes. exit 0
```

Then run step 3 exactly as written. It removes the addresses from the **live** production
state with `terraform state rm`. Never push `production.work.tfstate`. Finish with steps 4
to 6 and `rm -rf "$WORK"`.
