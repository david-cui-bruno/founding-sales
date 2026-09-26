# Restore production to a point in time

When production's data is wrong and a copy from before the damage is better; not for an
instance failure, which Multi-AZ fails over. Replaces the nine-step protocol and the restore
drill (lane W3-S8). About an hour of outage, nothing sends meanwhile. Merge nothing to main
until (f): an app-only merge deploys itself and starts the services. One `bash` (lib.sh is
bash), a production checkout at main with the production root initialised as for a
release, the admin profile. Nothing starts the API or the worker before (f): no route is
reachable until the reconciliation has passed.

**How it stops.** Each step is one `&&` chain that begins `need <earlier steps>` and ends
`pass <step>`, which appends to the go/no-go ledger `$W/go`. A command that fails ends its
chain, so `pass` is not written and every later step answers `NO-GO`. Redo a step by running
it again; never write the ledger by hand. A new shell runs the setup again and continues. One
restore at a time: `$W` is its record; move it aside when the restore is retired.

```bash
export AWS_PROFILE=<admin profile> AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
source infra/scripts/lib.sh; set +e     # lib.sh sets -e; the ledger, not the shell, stops a step
R=infra/roots/production; W=$HOME/fss-restore; mkdir -p "$W" && chmod 700 "$W" && touch "$W/go"
[ -f "$W/restore.env" ] && source "$W/restore.env"
digests() { API=$(sed -n 's/^-var=api_image=.*@//p' "$W/vars") && WORKER=$(sed -n 's/^-var=worker_image=.*@//p' "$W/vars") && [ -n "$API" ] && [ -n "$WORKER" ]; }
pass() { echo "$1 $(date -u +%FT%TZ)" >> "$W/go" && echo "GO: $1"; }
need() { local s; for s in "$@"; do grep -q "^$s " "$W/go" || { echo "NO-GO: $s has not passed" >&2; return 1; }; done; }
keep() { echo "$1=$2" >> "$W/restore.env" && eval "$1=\$2"; }   # $(cat "$W/vars") below splits on purpose
report() { release_captured_report "$W/$1.log" "$W/$1.json"; }
fss_task() { # fss_task <step> <migration|operations> [--capture F] [--env NAME=VALUE] -- <fss words>...
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
fill_migration() { # fill_migration <instance> <host>: the migration entry gets its master credential; nothing echoed
  local arn; arn=$(aws rds describe-db-instances --db-instance-identifier "$1" \
    --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text) && [[ $arn == arn:aws:secretsmanager:* ]] \
  && aws secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text \
  | HOST=$2 DB=$(release_output $R database_name) python3 -c 'import json, os, sys; m = json.load(sys.stdin)
print(json.dumps({"username": m["username"], "password": m["password"], "host": os.environ["HOST"], "port": 5432, "dbname": os.environ["DB"]}))' \
  | aws secretsmanager put-secret-value --secret-id "$(release_output $R migration_database_secret_arn)" --secret-string file:///dev/stdin >/dev/null
}
```

**(a) Stop, and take the inventory from the instance being replaced.** It still knows every
mailbox connected up to now; the copy will not. Read `$W/mailboxes.json` and add to
`INVENTORY` any address FSS has sent from since `T` that it lacks. If `fss-prod-pg` is gone
or unreadable, replace the `fss_task inventory` link with `keep INVENTORY <addresses>`.

```bash
need && infra/scripts/deployed-digests.sh fss-prod --var-flags > "$W/vars" \
  && infra/scripts/release-stop.sh $R fss-prod --environment production \
  && fss_task inventory operations --capture "$W/mailboxes.log" -- admin mailbox list && report mailboxes \
  && keep INVENTORY "$(python3 -c 'import json, sys; print(",".join(sorted({m["address"] for m in json.load(open(sys.argv[1]))["mailboxes"]})))' "$W/mailboxes.json")" \
  && pass stopped
```

**(b) Restore to a new instance.** Set `T` first (`T=2026-09-26T11:50:00Z`: UTC, just before
the damage). It must lie in exactly one restorable window of `fss-prod-pg`'s automated
backups, which also covers a deleted source; the security group is found by name. A rerun
reuses `$NEW` and so refuses while that instance exists: delete it, or `unset NEW` for another.

```bash
need stopped && { [ -n "${T:-}" ] || { echo "NO-GO: set T" >&2; false; }; } && keep T "$T" && keep NEW "${NEW:-fss-prod-pg-r$(date -u +%m%d%H%M)}" \
  && keep SINCE "$(date -u -j -v-10M -f %Y-%m-%dT%H:%M:%SZ "$T" +%Y-%m-%dT%H:%M:%SZ)" \
  && aws rds describe-db-instance-automated-backups --db-instance-identifier fss-prod-pg --output json > "$W/backups.json" \
  && DBI=$(python3 -c 'import datetime as d, json, os, sys
p = lambda v: d.datetime.fromisoformat(v.replace("Z", "+00:00")); t = p(os.environ["T"]); now = d.datetime.now(d.timezone.utc)
w = [b for b in json.load(open(sys.argv[1]))["DBInstanceAutomatedBackups"] if "EarliestTime" in b.get("RestoreWindow", {})
     and p(b["RestoreWindow"]["EarliestTime"]) <= t <= min(now, p(b["RestoreWindow"].get("LatestTime", now.isoformat())))]
print(w[0]["DbiResourceId"]) if len(w) == 1 else sys.exit("NO-GO: T is in %d restorable windows, not one" % len(w))' "$W/backups.json") \
  && SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=fss-prod-database \
    --query 'SecurityGroups[0].GroupId' --output text) && [[ $SG == sg-* ]] \
  && aws rds restore-db-instance-to-point-in-time --source-dbi-resource-id "$DBI" --target-db-instance-identifier "$NEW" \
    --restore-time "$T" --db-subnet-group-name fss-prod-db --db-parameter-group-name fss-prod-pg16 --vpc-security-group-ids "$SG" \
    --multi-az --no-publicly-accessible --deletion-protection --copy-tags-to-snapshot \
    --enable-cloudwatch-logs-exports postgresql upgrade >/dev/null \
  && aws rds wait db-instance-available --db-instance-identifier "$NEW" \
  && aws rds modify-db-instance --db-instance-identifier "$NEW" --backup-retention-period 35 --manage-master-user-password \
    --master-user-secret-kms-key-id alias/fss-prod-database --apply-immediately >/dev/null \
  && sleep 60 && aws rds wait db-instance-available --db-instance-identifier "$NEW" \
  && keep NEW_HOST "$(aws rds describe-db-instances --db-instance-identifier "$NEW" --query 'DBInstances[0].Endpoint.Address' --output text)" \
  && pass restored
```

**(c) Point production at it**, then bring the copy forward. The plan must be exactly the four
task definitions `api`, `worker`, `migration`, `operations` replaced (read them: only
`FSS_DATABASE_HOST` differs) and the services `api`, `worker` updated; the check refuses
anything else. The services stay at zero (`ignore_changes = [desired_count]`).

```bash
need restored && terraform -chdir=$R plan -input=false -out="$W/point.tfplan" $(cat "$W/vars") -var="active_database_host=$NEW_HOST" \
  && terraform -chdir=$R show -json "$W/point.tfplan" | python3 -c 'import json, sys
c = [r for r in json.load(sys.stdin)["resource_changes"] if r["change"]["actions"] not in (["no-op"], ["read"])]
m = "module.stack.module.cluster."; want = {m + "aws_ecs_task_definition." + n: ["create", "delete"] for n in ("api", "worker", "migration", "operations")}
want.update({m + "aws_ecs_service." + n: ["update"] for n in ("api", "worker")})
got = {r["address"]: sorted(r["change"]["actions"]) for r in c}
sys.exit(0 if got == want else "NO-GO: the plan is %s" % got)' \
  && terraform -chdir=$R apply -input=false "$W/point.tfplan" && fill_migration "$NEW" "$NEW_HOST" \
  && fss_task migrate migration -- migrate && fss_task users migration -- admin database-users ensure \
  && fss_task schema operations --capture "$W/schema.log" -- schema-version && report schema \
  && python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); sys.exit(0 if r["apiAccepts"] and r["workerAccepts"] else "NO-GO: %s" % r)' "$W/schema.json" \
  && pass pointed
```

**(d) Put back what the copy lost,** still stopped (the task definitions now reach the copy).

```bash
need pointed && fss_task journal operations -- admin suppression-journal replay --from "$SINCE" \
  && fss_task sent operations --capture "$W/sent.log" -- admin mailbox reconcile-sent --since "$SINCE" --inventory "$INVENTORY" \
  && pass reconciled; report sent
```

The reconcile reads each inventory mailbox's Sent folder through a Gmail client that cannot
send, watch or read a body, and tombstones each FSS send the copy lost. Anything in
`unresolved` (`$W/sent.json`) is a no-go until a rerun passes:

- `mailbox_not_in_inventory`: add it to `INVENTORY` (`keep INVENTORY ...`) and rerun.
- `sent_folder_unscanned` `rate_limited` or `message_vanished`: rerun. `truncated`: stop and escalate.
- `sent_folder_unscanned` `grant_revoked`, or `mailbox_not_in_copy`: this copy cannot prove what
  that mailbox sent. Restore again to a later `T` at which the mailbox had the grant it has now
  (from (b), with the ledger's `restored` line removed and a new `NEW`), or abandon.
- `unattached_sent_message`: a send no single step can be named for. Rerun with
  `--hold-unattached` added: each firm it names (or the workspace, when none) gets a
  `restore_in_progress` hold, and after (f) an admin checks the Sent message at `sentAt`,
  ends the duplicate in the app, and releases the hold as below.

**(e) The release record.** The worker sends only while a stored record names its digest, and
the copy may predate the running release's. `images.sh pin <running commit> pin.json` names the
gate run; `created` or `existing` are both a pass.

```bash
need reconciled && digests \
  && infra/scripts/record.sh from-ci <gate run id> <running commit> "$API" "$WORKER" --out "$W/record.json" \
  && infra/scripts/record.sh put $R fss-prod --api-digest "$API" --worker-digest "$WORKER" --release-record "$W/record.json" \
  && fss_task holds operations --capture "$W/holds.log" -- admin holds list --reason restore_in_progress && report holds \
  && python3 -c 'import json, sys; o = [h["id"] for h in json.load(open(sys.argv[1]))["holds"] if h["sourceEventKind"] != "restore.unattached_send"]
sys.exit("NO-GO: restore holds from before the restore: %s" % o if o else 0)' "$W/holds.json" && pass recorded
```

Every open `restore_in_progress` hold must be one (d) opened for an unattached send; any
other is from before the restore and is a no-go: clear it as below, then rerun (e).

**(f) Start and smoke:** `need reconciled recorded && digests && infra/scripts/release-deploy.sh $R
fss-prod --api-digest "$API" --worker-digest "$WORKER" && pass started`, then release.md 6's smoke. Log
`T`, `$NEW`, the ledger and `$W/sent.json` in the running log.

**Clearing a restore hold** (audited; nothing else releases one since the generation check
went): read it with `fss_task holds operations -- admin holds list --reason restore_in_progress`,
then `fss_task clear operations -- admin holds release-restore --admin-user <admin-user-id> --note "<why>" --hold <id>`.
It refuses a user who is not an active admin of the hold's workspace, and writes an
`audit_events` row (`hold.restore_released`) with the note.

**(g) Later, on a quiet day, retire the old instance** (a short second outage):

```bash
need started && infra/scripts/deployed-digests.sh fss-prod --var-flags > "$W/vars" && digests \
  && infra/scripts/release-stop.sh $R fss-prod --environment production \
  && terraform -chdir=$R state pull > "$W/state-before-import.json" \
  && aws rds modify-db-instance --db-instance-identifier fss-prod-pg --no-deletion-protection --apply-immediately >/dev/null \
  && aws rds delete-db-instance --db-instance-identifier fss-prod-pg --final-db-snapshot-identifier "fss-prod-pg-pre-restore-$(date -u +%Y%m%d)" \
    --no-delete-automated-backups >/dev/null \
  && aws rds wait db-instance-deleted --db-instance-identifier fss-prod-pg \
  && aws rds modify-db-instance --db-instance-identifier "$NEW" --new-db-instance-identifier fss-prod-pg --apply-immediately >/dev/null \
  && until aws rds describe-db-instances --db-instance-identifier fss-prod-pg >/dev/null 2>&1; do sleep 30; done \
  && aws rds wait db-instance-available --db-instance-identifier fss-prod-pg \
  && terraform -chdir=$R state rm module.stack.module.database.aws_db_instance.main \
  && terraform -chdir=$R import -input=false $(cat "$W/vars") module.stack.module.database.aws_db_instance.main fss-prod-pg \
  && terraform -chdir=$R plan -input=false -out="$W/retire.tfplan" $(cat "$W/vars") \
  && terraform -chdir=$R show -json "$W/retire.tfplan" | python3 -c 'import json, sys
c = [r for r in json.load(sys.stdin)["resource_changes"] if "delete" in r["change"]["actions"]]
td = {"module.stack.module.cluster.aws_ecs_task_definition." + n for n in ("api", "worker", "migration", "operations")}
sys.exit(0 if {r["address"] for r in c} <= td else "NO-GO: the plan replaces %s" % [r["address"] for r in c])' \
  && terraform -chdir=$R apply -input=false "$W/retire.tfplan" && fill_migration fss-prod-pg "$(release_output $R database_endpoint | cut -d: -f1)" \
  && infra/scripts/release-deploy.sh $R fss-prod --api-digest "$API" --worker-digest "$WORKER" && pass retired
```

The plan without `active_database_host` changes the instance in place only (the check refuses
any replacement but the four task definitions, which return to the managed address). A failed
import is undone with `terraform -chdir=$R state push "$W/state-before-import.json"`.
**To abandon before (g):** drop `active_database_host` (plan and apply as (c) without it),
`fill_migration fss-prod-pg <its address>`, start as (f), then delete the copy.

## Quarterly hand smoke (after the setup; writes only to a scratch copy)

```bash
S=fss-prod-pg-smoke; SINCE=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ); SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=fss-prod-database --query 'SecurityGroups[0].GroupId' --output text)
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier fss-prod-pg --target-db-instance-identifier $S \
  --use-latest-restorable-time --db-subnet-group-name fss-prod-db --db-parameter-group-name fss-prod-pg16 \
  --vpc-security-group-ids "$SG" --no-multi-az --no-publicly-accessible >/dev/null && aws rds wait db-instance-available --db-instance-identifier $S
H=$(aws rds describe-db-instances --db-instance-identifier $S --query 'DBInstances[0].Endpoint.Address' --output text)
fss_task smoke-schema operations --env "FSS_DATABASE_HOST=$H" -- schema-version
fss_task smoke-sent operations --env "FSS_DATABASE_HOST=$H" -- admin mailbox reconcile-sent --since "$SINCE" --inventory "<addresses>"
aws rds delete-db-instance --db-instance-identifier $S --skip-final-snapshot --delete-automated-backups >/dev/null
```
