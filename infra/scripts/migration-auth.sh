#!/usr/bin/env bash
# A fresh, bounded, read-only check on the existing migration identity, with this release's image.
# Called by stop.sh before production drain, and again after idle before the first stop.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ "$#" = 3 ] || [ "$#" = 4 ] || { echo 'usage: migration-auth.sh <root> <prefix> <release worker digest>' >&2; exit 1; }
ROOT=$1; NAME_PREFIX=$2; DIGEST=$3; MODE=${4:-check}
[ "$MODE" = check ] || [ "$MODE" = --verify-binding ] || { echo 'FAIL: unknown migration authentication mode' >&2; exit 1; }
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'FAIL: migration authentication requires the exact release worker digest' >&2; exit 1; }
release_read_root "$ROOT" "$NAME_PREFIX" production 'checks migration authentication before stopping production'
[ "$ENVIRONMENT" = production ] || { echo 'FAIL: this check is for the production schema stop' >&2; exit 1; }
if rehearsal_dry_run; then
  rehearsal_plan "fresh migration-auth-check on $MIGRATION_TASK_DEFINITION with image $DIGEST; READ ONLY; no runtime fallback; refuse before drain/stop on any failed or changed binding"
  exit 0
fi
SECRET="$(release_output "$ROOT_DIRECTORY" migration_database_secret_arn)" || exit 1
DATABASE="$(release_output "$ROOT_DIRECTORY" database_name)" || exit 1
release_require_arn 'the migration task definition' "$MIGRATION_TASK_DEFINITION" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
release_require_arn 'the migration secret' "$SECRET" secretsmanager "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
[ -n "$DATABASE" ] && [ -n "$DATABASE_HOST" ] || { echo 'FAIL: migration database binding unavailable' >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-migration-auth.XXXXXX")"
TEMPORARY=''
cleanup() {
 local status=$?
 if [ -n "$TEMPORARY" ]; then
  release_aws "$ENVIRONMENT" ecs deregister-task-definition --task-definition "$TEMPORARY" --output json >/dev/null || status=1
 fi
 rm -rf "$WORK"
 exit "$status"
}
trap cleanup EXIT
current_version() {
 local metadata
 metadata="$(release_aws "$ENVIRONMENT" secretsmanager describe-secret --secret-id "$SECRET" --output json)" || return 1
 FSS_METADATA="$metadata" python3 -c 'import json,os,sys; d=json.loads(os.environ["FSS_METADATA"]); v=[k for k,s in d.get("VersionIdsToStages",{}).items() if "AWSCURRENT" in s]; sys.exit("FAIL: migration credential version unavailable") if len(v)!=1 else print(v[0])'
}
VERSION="$(current_version)" || exit 1
release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$MIGRATION_TASK_DEFINITION" --include TAGS --output json > "$WORK/definition.json" || exit 1
REPORTS="$(rehearsal_report_dir)";mkdir -p "$REPORTS"
BASE_HASH="$(python3 - "$WORK/definition.json" <<'PY_HASH'
import json,hashlib,sys
d=json.load(open(sys.argv[1]))['taskDefinition']
# Only public binding metadata; never hash environment credential values.
b={k:d.get(k) for k in ['taskDefinitionArn','taskRoleArn','executionRoleArn','networkMode']}
b['containers']=[{'name':c.get('name'),'image':c.get('image'),'databaseHost':next((e.get('value') for e in c.get('environment',[]) if e.get('name')=='FSS_DATABASE_HOST'),None),'secretReferences':c.get('secrets',[])} for c in d.get('containerDefinitions',[])]
print(hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest())
PY_HASH
)" || exit 1
if [ "$MODE" = --verify-binding ]; then
 FSS_REPORT="$REPORTS/migration-authentication.json" FSS_VERSION="$VERSION" FSS_BASE_HASH="$BASE_HASH" FSS_DIGEST="$DIGEST" FSS_DATABASE="$DATABASE" python3 - <<'PY_BIND'
import json,os,sys,datetime
p=os.environ
try:d=json.load(open(p['FSS_REPORT']));age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(d['checkedAt'].replace('Z','+00:00'))).total_seconds()
except (OSError,ValueError,KeyError,TypeError):sys.exit('FAIL: fresh authentication receipt unavailable')
if d.get('ok') is not True or d.get('workerDigest')!=p['FSS_DIGEST'] or d.get('database')!=p['FSS_DATABASE'] or d.get('credentialVersion')!=p['FSS_VERSION'] or d.get('taskDefinitionBindingDigest')!=p['FSS_BASE_HASH'] or not 0<=age<=180:sys.exit('FAIL: migration authentication binding changed or expired; run a fresh check')
PY_BIND
 exit "$?"
fi
NEED="$(FSS_WORK="$WORK" FSS_DIGEST="$DIGEST" FSS_PREFIX="$PREFIX" FSS_ACCOUNT="$ACCOUNT" FSS_REGION="$REGION" FSS_HOST="$DATABASE_HOST" FSS_SECRET="$SECRET" python3 - <<'PY'
import json,os,re,sys
p=os.environ;doc=json.load(open(p['FSS_WORK']+'/definition.json'));d=doc['taskDefinition'];cs=d.get('containerDefinitions',[])
if len(cs)!=1 or cs[0].get('name')!='migration':sys.exit('FAIL: expected one migration container')
c=cs[0];env={e['name']:e['value'] for e in c.get('environment',[])};secrets={e['name']:e['valueFrom'] for e in c.get('secrets',[])}
if env.get('FSS_DATABASE_HOST')!=p['FSS_HOST'] or secrets.get('MIGRATION_DATABASE_SECRET')!=p['FSS_SECRET']:sys.exit('FAIL: migration endpoint or secret binding differs')
if any(k in env or k in secrets for k in ['DATABASE_URL','DATABASE_SECRET_ARN','FSS_MIGRATION_DATABASE_URL']):sys.exit('FAIL: migration definition has a credential fallback or literal')
repository=p['FSS_ACCOUNT']+'.dkr.ecr.'+p['FSS_REGION']+'.amazonaws.com/'+p['FSS_PREFIX']+'-worker'
if not re.fullmatch(re.escape(repository)+r'@sha256:[0-9a-f]{64}',c.get('image','')):sys.exit('FAIL: migration image is outside the release repository')
if c['image']==repository+'@'+p['FSS_DIGEST']:print('same');sys.exit(0)
tags=doc.get('tags',[])
if not any(t.get('key')=='NamePrefix' and t.get('value')==p['FSS_PREFIX'] for t in tags):sys.exit('FAIL: migration definition prefix tag missing')
for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt']:d.pop(k,None)
c['image']=repository+'@'+p['FSS_DIGEST'];d['tags']=tags
json.dump(d,open(p['FSS_WORK']+'/next.json','w'));print('register')
PY
)" || exit 1
LAUNCH=$MIGRATION_TASK_DEFINITION
if [ "$NEED" = register ]; then
 registered="$(release_aws "$ENVIRONMENT" ecs register-task-definition --cli-input-json "file://$WORK/next.json" --output json)" || exit 1
 TEMPORARY="$(release_json_path "$registered" taskDefinition.taskDefinitionArn)"
 [ -n "$TEMPORARY" ] || { echo 'FAIL: migration preflight task revision unavailable' >&2; exit 1; }
 LAUNCH=$TEMPORARY
fi
REPORTS="$(rehearsal_report_dir)";mkdir -p "$REPORTS"
rm -f "$REPORTS/migration-authentication.json"
release_run_task --step migration-authentication --environment "$ENVIRONMENT" --prefix "$PREFIX" --account "$ACCOUNT" --region "$REGION" \
 --cluster "$CLUSTER_ARN" --task-definition "$LAUNCH" --container migration --network-plan "$NETWORK_PLAN" --image-digest "$DIGEST" \
 --database-host "$DATABASE_HOST" --log-group "$LOG_GROUP" --log-stream-prefix migration --timeout-seconds 180 \
 --capture "$REPORTS/migration-authentication.log" -- migration-auth-check --expected-database "$DATABASE" --expected-user fss_admin --expected-host "$DATABASE_HOST" || exit 1
release_captured_report "$REPORTS/migration-authentication.log" "$REPORTS/migration-authentication.json" || exit 1
AFTER="$(current_version)" || exit 1
[ "$VERSION" = "$AFTER" ] || { echo 'FAIL: migration credential changed during authentication; run a fresh check' >&2; exit 1; }
# Reread the registered base binding, so a replacement cannot silently reuse the receipt.
release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$MIGRATION_TASK_DEFINITION" --include TAGS --output json > "$WORK/after.json" || exit 1
cmp -s "$WORK/definition.json" "$WORK/after.json" || { echo 'FAIL: migration task binding changed during authentication' >&2; exit 1; }
FSS_REPORT="$REPORTS/migration-authentication.json" FSS_DATABASE="$DATABASE" FSS_DIGEST="$DIGEST" FSS_SECRET="$SECRET" FSS_VERSION="$VERSION" FSS_TASK="$LAUNCH" FSS_BASE_HASH="$BASE_HASH" python3 - <<'PY'
import json,os,sys,datetime
p=os.environ;d=json.load(open(p['FSS_REPORT']))
if d.get('ok') is not True or d.get('database')!=p['FSS_DATABASE'] or d.get('identity')!='fss_admin' or d.get('readOnly') is not True or d.get('migrationMember') is not True or not isinstance(d.get('schemaVersion'),int):sys.exit('FAIL: migration authentication did not verify the expected identity and database')
try:age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(d['checkedAt'].replace('Z','+00:00'))).total_seconds()
except (KeyError,ValueError,TypeError):sys.exit('FAIL: authentication timestamp unavailable')
if not 0<=age<=180:sys.exit('FAIL: authentication report is stale')
d.update(workerDigest=p['FSS_DIGEST'],migrationSecretArn=p['FSS_SECRET'],credentialVersion=p['FSS_VERSION'],taskDefinition=p['FSS_TASK'],taskDefinitionBindingDigest=p['FSS_BASE_HASH'])
json.dump(d,open(p['FSS_REPORT'],'w'),indent=2)
PY
