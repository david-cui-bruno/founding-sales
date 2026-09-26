# Restore production to a point in time

When production's data is wrong and a copy from before the damage is better; not for an
instance failure, which Multi-AZ fails over. Replaces the nine-step protocol and the restore
drill (lane W3-S8, 26 September 2026). About an hour of outage, nothing sends meanwhile. Merge
nothing to main until (f): an app-only merge deploys itself and starts the services. One `bash`
(lib.sh is bash), a production checkout at main, the admin profile. `T` is the UTC instant just before the damage.

```bash
export AWS_PROFILE=<admin profile> AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
source infra/scripts/lib.sh; set +e    # lib.sh sets -e; a refusal must not close this shell
R=infra/roots/production; NEW=fss-prod-pg-r$(date -u +%m%d%H%M); T=2026-09-26T11:50:00Z
SINCE=$(date -u -j -v-10M -f %Y-%m-%dT%H:%M:%SZ "$T" +%Y-%m-%dT%H:%M:%SZ)
fss_task() { # fss_task <step> <migration|operations> [--env NAME=VALUE] -- <fss words>...
  local step=$1 kind=$2 td net img secret=''; shift 2
  td=$(release_output $R "${kind}_task_definition_arn"); net=$(release_output $R task_network_configuration json)
  img=$(aws ecs describe-task-definition --task-definition "$td" --output text \
    --query "taskDefinition.containerDefinitions[?name=='$kind'].image | [0]")
  [ "$kind" = operations ] && secret=$(release_output $R app_runtime_database_secret_arn)
  release_run_task --step "restore-$step" --environment production --prefix fss-prod \
    --account "$(release_caller_account)" --region us-east-1 --cluster "$(release_output $R cluster_arn)" \
    --task-definition "$td" --container "$kind" --network-plan "$net" --image-digest "${img#*@}" \
    --database-host "$(release_json_path "$net" database_host)" --secret-arn "$secret" \
    --log-group "$(release_output $R worker_log_group_name)" --log-stream-prefix "$kind" "$@"
}
```

**(a) Stop both services:** `infra/scripts/release-stop.sh $R fss-prod --environment production`
(it reads back zero desired, running and pending). The old instance stays as it is until (g).

**(b) Restore to a new instance** with production's subnets, security group, parameter group
and key. `T` must be before `LatestRestorableTime`. If `fss-prod-pg` itself is gone, restore
from `--source-dbi-resource-id` (`aws rds describe-db-instance-automated-backups`).

```bash
SG=$(aws rds describe-db-instances --db-instance-identifier fss-prod-pg --output text \
  --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId')
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier fss-prod-pg \
  --target-db-instance-identifier "$NEW" --restore-time "$T" --db-subnet-group-name fss-prod-db \
  --db-parameter-group-name fss-prod-pg16 --vpc-security-group-ids $SG --multi-az --no-publicly-accessible \
  --deletion-protection --copy-tags-to-snapshot --enable-cloudwatch-logs-exports postgresql upgrade >/dev/null
aws rds wait db-instance-available --db-instance-identifier "$NEW"   # a master secret of its own, as Terraform's:
aws rds modify-db-instance --db-instance-identifier "$NEW" --backup-retention-period 35 --manage-master-user-password \
  --master-user-secret-kms-key-id alias/fss-prod-database --apply-immediately >/dev/null
sleep 60; aws rds wait db-instance-available --db-instance-identifier "$NEW"
NEW_HOST=$(aws rds describe-db-instances --db-instance-identifier "$NEW" --query 'DBInstances[0].Endpoint.Address' --output text)
```

**(c) Point production at it.** Plan an infrastructure change as `docs/greenfield/release.md`
4.0 does (`deployed-digests.sh fss-prod --var-flags`) plus `-var active_database_host=$NEW_HOST`.
The plan must be exactly: `module.stack.module.cluster.aws_ecs_task_definition` `api`, `worker`,
`migration`, `operations` replaced, differing only in `FSS_DATABASE_HOST`; `aws_ecs_service`
`api`, `worker` updated in place; output `task_network_configuration`. Anything else: stop.
Apply (the services stay at zero: `ignore_changes = [desired_count]`). Give the migration entry
the new master credential (nothing echoed) and bring the copy forward; `schema-version` must
answer what the running images declare (19 today).

```bash
aws secretsmanager get-secret-value --query SecretString --output text --secret-id "$(aws rds describe-db-instances \
  --db-instance-identifier "$NEW" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)" \
| HOST=$NEW_HOST DB=$(release_output $R database_name) python3 -c 'import json, os, sys; m = json.load(sys.stdin)
print(json.dumps({"username": m["username"], "password": m["password"], "host": os.environ["HOST"], "port": 5432, "dbname": os.environ["DB"]}))' \
| aws secretsmanager put-secret-value --secret-id "$(release_output $R migration_database_secret_arn)" --secret-string file:///dev/stdin >/dev/null
fss_task migrate migration -- migrate && fss_task users migration -- admin database-users ensure \
  && fss_task schema operations -- schema-version
```

**(d) Put back what the copy lost,** still stopped (the task definitions now reach the copy):
`fss_task journal operations -- admin suppression-journal replay --from "$SINCE"`, then
`fss_task sent operations -- admin mailbox reconcile-sent --since "$SINCE" --all-mailboxes`.
The replay reapplies the opt-outs journalled since `SINCE`. The reconcile reads each Sent folder
through a Gmail client that cannot send, watch or read a body, and tombstones each FSS send the
copy lost so its step is not sent again. It must exit 0, or nothing starts until a rerun does:

- `sent_folder_unscanned` (`grant_revoked`, ...): start the API alone (`aws ecs update-service
  --cluster "$(release_output $R cluster_arn)" --service fss-prod-api --desired-count 1`),
  reconnect that mailbox in the Mac app, stop as (a), rerun.
- `unattached_sent_message`: no single step can be named. With the API alone up, end the
  sequence on each firm in `firmIds` (the Sent folder at `sentAt` shows the recipient), stop,
  rerun; it becomes `unmatched`, reported and left. Only `recipient_unreadable` survives that:
  end the recipient's sequence by hand, log the `message` hash in the running log, continue.

**(e) The release record.** The worker sends only while a stored record names its digest, and
the copy may predate the running release's. Rebuild and put it (`created` or `existing`; this
is what `release-deploy.sh --record-only` runs). The digests are `deployed-digests.sh fss-prod`'s;
`infra/scripts/images.sh pin <running commit> pin.json` names the gate run.

```bash
infra/scripts/record.sh from-ci <gate run id> <running commit> <api digest> <worker digest> --out record.json
infra/scripts/record.sh put $R fss-prod --api-digest <api digest> --worker-digest <worker digest> --release-record record.json
```

**(f) Start and smoke:** `infra/scripts/release-deploy.sh $R fss-prod --api-digest <api digest>
--worker-digest <worker digest>` (the rolling path), then release.md 6's smoke. Diagnostics shows
no restore generation, as expected. Log `T`, `$NEW` and the reconcile report.

**(g) Later, on a quiet day, retire the old instance** (a short second outage). Stop as (a);
`aws rds modify-db-instance --db-instance-identifier fss-prod-pg --no-deletion-protection --apply-immediately`;
`aws rds delete-db-instance --db-instance-identifier fss-prod-pg --final-db-snapshot-identifier fss-prod-pg-pre-restore`;
once it is gone, `aws rds modify-db-instance --db-instance-identifier "$NEW" --new-db-instance-identifier
fss-prod-pg --apply-immediately`; when available, `terraform -chdir=$R state rm module.stack.module.database.aws_db_instance.main`
and `terraform -chdir=$R import module.stack.module.database.aws_db_instance.main fss-prod-pg`. Plan without
`active_database_host`: the instance changes in place only (never replaced) and the four task
definitions return to the managed address. Apply, refill the migration entry from the managed
instance as a release does, start as (f). **To abandon before (g):** drop `active_database_host`,
apply, refill the migration entry the same way, start as (f), delete the copy.

## Quarterly hand smoke (after the setup and (b)'s `SG`; writes only to the scratch copy)

```bash
S=fss-prod-pg-smoke; SINCE=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier fss-prod-pg --target-db-instance-identifier $S \
  --use-latest-restorable-time --db-subnet-group-name fss-prod-db --db-parameter-group-name fss-prod-pg16 \
  --vpc-security-group-ids $SG --no-multi-az --no-publicly-accessible >/dev/null && aws rds wait db-instance-available --db-instance-identifier $S
H=$(aws rds describe-db-instances --db-instance-identifier $S --query 'DBInstances[0].Endpoint.Address' --output text)
fss_task smoke-schema operations --env FSS_DATABASE_HOST=$H -- schema-version
fss_task smoke-sent operations --env FSS_DATABASE_HOST=$H -- admin mailbox reconcile-sent --since "$SINCE" --all-mailboxes
aws rds delete-db-instance --db-instance-identifier $S --skip-final-snapshot --delete-automated-backups >/dev/null
```
