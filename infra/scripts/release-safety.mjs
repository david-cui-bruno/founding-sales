// Shared native application/reviewed release guards. No setting writes or sending activation.
import { isDeepStrictEqual } from 'node:util';
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };

// Runs only in the existing operations image with its runtime identity. No business
// rows, identifiers or credential values leave this READ ONLY transaction.
export const offRead = `
import pg from 'pg';
import {readToolConfig} from './apps/worker/src/tools/fss/config.ts';
const c=new pg.Client({connectionString:readToolConfig(process.env).database.connectionString,connectionTimeoutMillis:10000,query_timeout:10000});
try {
 await c.connect(); await c.query('BEGIN READ ONLY');
 const schema=Number((await c.query('SELECT max(version)::int AS version FROM schema_versions')).rows[0].version);
 const rows=(await c.query("SELECT s.version,s.value,(SELECT count(*)::int FROM outbound_messages o WHERE o.workspace_id=w.id AND o.state='dispatching') AS finishing FROM workspaces w LEFT JOIN workspace_settings s ON s.workspace_id=w.id AND s.setting_key='sending_enabled' AND s.superseded_at IS NULL ORDER BY w.id LIMIT 101")).rows;
 const storedOff=rows.length>0&&rows.length<=100&&rows.every(r=>Number.isInteger(r.version)&&r.value?.enabled===false);
 const effectiveOff=storedOff||process.env.FSS_SENDING_ENABLED!=='true';
 const finishing=rows.reduce((n,r)=>n+r.finishing,0);
 await c.query('ROLLBACK');
 console.log(JSON.stringify({releaseOff:storedOff&&effectiveOff&&finishing===0,schema,storedOff,effectiveOff,finishing,versions:rows.slice(0,100).map(r=>r.version),observedAt:new Date().toISOString()}));
} catch { process.exitCode=1; } finally { await c.end(); }
`;

export function validateOff(read, expected, now, previous) {
  requireThat(read?.releaseOff === true && read.storedOff === true && read.effectiveOff === true && read.finishing === 0 && read.schema === expected && Array.isArray(read.versions) && read.versions.length > 0 && read.versions.length <= 100 && read.versions.every(Number.isInteger) && Number.isFinite(Date.parse(read.observedAt)) && Math.abs(now - Date.parse(read.observedAt)) <= 180000, 'sending_not_fresh_off');
  if (previous) requireThat(isDeepStrictEqual(read.versions, previous), 'owner_setting_changed');
  return read;
}

export function normalizeTaskDefinition(definition) {
  const copy = structuredClone(definition);
  for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt', 'tags']) delete copy[key];
  return copy;
}

export function readerTaskDocument(source) {
  const document = normalizeTaskDefinition(source.definition);
  document.tags = source.tags;
  const container = document.containerDefinitions[0];
  container.entryPoint = ['node', '--experimental-transform-types', '--input-type=module', '--eval', offRead];
  container.command = [];
  return document;
}

// Existing application's bounded native reader transport, shared rather than a new
// command runner. Unknown starts/exits retain task identity and never replay/cleanup.
export function createReleaseSafety({ aws, waitFor, now, state, save, cluster, network, owner }) {
  let sequence = 0;
  async function off(source, expected) {
    const document = readerTaskDocument(source);
    const c = document.containerDefinitions[0];
    const registered = await aws('ecs', 'register-task-definition', ['--cli-input-json', JSON.stringify(document)], true);
    const definition = registered.taskDefinition?.taskDefinitionArn;
    requireThat(typeof definition === 'string' && definition.startsWith(`${cluster.split(':cluster/')[0]}:task-definition/fss-prod-operations:`), 'registration_unknown');
    state.temporaryReaderDefinition = definition; save();
    const readback = await aws('ecs', 'describe-task-definition', ['--task-definition', definition, '--include', 'TAGS']);
    requireThat(isDeepStrictEqual(normalizeTaskDefinition(readback.taskDefinition), normalizeTaskDefinition(document)) && isDeepStrictEqual(readback.tags, document.tags), 'registered_definition_changed');
    state.currentTaskOwner = `${owner}-off-${++sequence}`; state.lastStoppedTaskArn = null; save();
    let read;
    try {
      const started = await aws('ecs', 'run-task', ['--cluster', cluster, '--started-by', state.currentTaskOwner, '--task-definition', definition, '--launch-type', 'FARGATE', '--count', '1', '--propagate-tags', 'TASK_DEFINITION', '--network-configuration', JSON.stringify({ awsvpcConfiguration: network }), '--overrides', JSON.stringify({ containerOverrides: [{ name: 'operations', command: [] }] })], true);
      requireThat(!started.failures?.length && started.tasks?.length === 1 && started.tasks[0].taskArn, 'task_start_unknown');
      const arn = started.tasks[0].taskArn;
      state.currentTaskArn = arn; save();
      let stopped;
      await waitFor(async () => {
        const result = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', arn]);
        requireThat(!result.failures?.length && result.tasks?.length === 1, 'task_outcome_unknown');
        stopped = result.tasks[0]; return stopped.lastStatus === 'STOPPED';
      }, 'task_outcome_unknown', 120);
      requireThat(stopped.taskArn === arn && stopped.clusterArn === cluster && stopped.startedBy === state.currentTaskOwner && stopped.taskDefinitionArn === definition && stopped.containers?.length === 1 && stopped.containers[0].name === 'operations' && Number.isInteger(stopped.containers[0].exitCode) && stopped.containers[0].imageDigest === c.image.split('@')[1], 'task_failed_or_foreign');
      state.currentTaskArn = null; state.lastStoppedTaskArn = arn; state.lastTaskExitCode = stopped.containers[0].exitCode; save();
      requireThat(stopped.containers[0].exitCode === 0, 'task_nonzero_exit');
      const options = c.logConfiguration?.options;
      const stream = `${options?.['awslogs-stream-prefix']}/operations/${arn.split('/').at(-1)}`;
      await waitFor(async () => {
        const result = await aws('logs', 'get-log-events', ['--log-group-name', options['awslogs-group'], '--log-stream-name', stream, '--start-from-head']);
        for (const event of result.events || []) {
          try { const value = JSON.parse(event.message); if (!value.event && !value.level) read = value; } catch { /* Never emit raw log lines. */ }
        }
        return read !== undefined;
      }, 'task_report_unavailable', 8);
    } finally {
      if (state.currentTaskArn === null && state.lastStoppedTaskArn) {
        await aws('ecs', 'deregister-task-definition', ['--task-definition', definition], true);
        state.temporaryReaderDefinition = null; save();
      }
    }
    validateOff(read, expected, now(), state.settingVersions);
    const { releaseOff, storedOff, effectiveOff, finishing, schema, versions, observedAt } = read;
    state.settingVersions = versions; state.observedSchema = schema;
    state.off = { releaseOff, storedOff, effectiveOff, finishing, schema, versions, observedAt }; save();
    return read;
  }
  async function quiescent() {
    // Re-observe the entire boundary on each attempt. The existing injectable
    // waiter bounds shutdown readiness to 12 observations (165s between polls).
    await waitFor(async () => {
      const services = await aws('ecs', 'describe-services', ['--cluster', cluster, '--services', 'fss-prod-api', 'fss-prod-worker']);
      requireThat(!services.failures?.length && services.services?.length === 2 && ['fss-prod-api', 'fss-prod-worker'].every(name => services.services.some(s => s.serviceName === name && s.status === 'ACTIVE' && s.desiredCount === 0 && s.runningCount === 0 && s.pendingCount === 0)), 'services_not_stopped');
      const running = await aws('ecs', 'list-tasks', ['--cluster', cluster, '--desired-status', 'RUNNING', '--max-results', '100', '--no-paginate']);
      requireThat(Array.isArray(running.taskArns) && running.taskArns.length === 0 && !running.nextToken, 'writers_still_running');
      // desired STOPPED includes containers still executing during shutdown. Only
      // actual terminal tasks are safe, and incomplete enumeration is not proof.
      const stopped = await aws('ecs', 'list-tasks', ['--cluster', cluster, '--desired-status', 'STOPPED', '--max-results', '100', '--no-paginate']);
      const arns = stopped.taskArns;
      requireThat(Array.isArray(arns) && arns.length <= 100 && arns.every(arn => typeof arn === 'string' && arn.length > 0) && new Set(arns).size === arns.length && !stopped.nextToken, 'writers_still_running');
      if (arns.length) {
        const result = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', ...arns]);
        requireThat(!result.failures?.length && Array.isArray(result.tasks) && result.tasks.length === arns.length && new Set(result.tasks.map(task => task.taskArn)).size === arns.length && result.tasks.every(task => arns.includes(task.taskArn) && task.clusterArn === cluster && ['RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED'].includes(task.lastStatus)), 'writers_still_running');
        return result.tasks.every(task => task.lastStatus === 'STOPPED');
      }
      return true;
    }, 'writers_still_running', 12);
  }
  async function pinRecovery(database, after) {
    requireThat(Number.isFinite(after) && after <= now(), 'quiescence_time_invalid');
    await waitFor(async () => {
      const result = await aws('rds', 'describe-db-instances', ['--db-instance-identifier', 'fss-prod-pg']);
      requireThat(result.DBInstances?.length === 1, 'database_unavailable');
      const db = result.DBInstances[0];
      requireThat(db.DBInstanceArn === database.DBInstanceArn && db.DbiResourceId === database.DbiResourceId && db.Endpoint?.Address === database.Endpoint.Address && db.DBInstanceStatus === 'available' && db.BackupRetentionPeriod === 35, 'backup_binding_changed');
      const resultBackup = await aws('rds', 'describe-db-instance-automated-backups', ['--dbi-resource-id', database.DbiResourceId]);
      requireThat(resultBackup.DBInstanceAutomatedBackups?.length === 1 && !resultBackup.Marker, 'backup_window_missing');
      const backup = resultBackup.DBInstanceAutomatedBackups[0];
      requireThat(backup.DBInstanceArn === database.DBInstanceArn && backup.DbiResourceId === database.DbiResourceId && backup.DBInstanceIdentifier === 'fss-prod-pg' && backup.Status === 'active', 'backup_window_binding_changed');
      const earliest = Date.parse(backup.RestoreWindow?.EarliestTime), latest = Date.parse(backup.RestoreWindow?.LatestTime);
      requireThat(Number.isFinite(earliest) && Number.isFinite(latest) && earliest <= latest, 'backup_window_missing');
      if (earliest > after || latest < after) return false;
      state.recoveryPoint = { databaseArn: db.DBInstanceArn, resourceId: db.DbiResourceId, timestamp: new Date(after).toISOString(), earliest: backup.RestoreWindow.EarliestTime, latest: backup.RestoreWindow.LatestTime, restoreTested: false }; save();
      return true;
    }, 'pitr_not_covering_quiescence', 100);
  }
  return { off, quiescent, pinRecovery };
}
