import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { offRead } from './release-safety.mjs';

const requireThat = (value, reason) => { if (!value) throw new Error(reason); };
// Only this audited source/attempt has the launch-custody semantics below. A new
// source needs an explicit review, not interpretation using today's status code.
const auditedCommit = 'bced9eebcc4c3fef4ee51d7eefd0f92e66f318c7';
const runId = 40522197864, jobId = 122252105573;
const repositoryName = 'david-cui-bruno/founding-sales';
const jobName = 'Opt-in protected application release (legacy remains default)';
const finalizerName = 'Actual application phase and recovery boundary';
const finalizerHeader = '##[group]Run if [ -f "$RUNNER_TEMP/application/status.json" ]; then';
const statusKeys = 'candidateDefinitions,currentTaskArn,currentTaskOwner,fromSchema,lastStoppedTaskArn,lastTaskExitCode,migrationStarted,observedSchema,outcome,phase,previousDefinitions,reason,recoveryPoint,rollback,targetSchema,temporaryReaderDefinition,writesStarted';

function validateRun(run) {
  requireThat(run?.id === runId && run.run_attempt === 1 && run.head_sha === auditedCommit && run.path?.split('@')[0] === '.github/workflows/greenfield-deploy.yml' && run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_repository?.full_name === repositoryName && run.status === 'completed' && run.conclusion === 'failure', 'reader_history_run_changed');
}
function validateJob(job) {
  requireThat(job?.id === jobId && job.run_id === runId && job.run_attempt === 1 && job.head_sha === auditedCommit && job.name === jobName && job.status === 'completed' && job.conclusion === 'failure' && Array.isArray(job.steps) && new Set(job.steps.map(s => s?.number)).size === job.steps.length, 'reader_history_job_changed');
  const execute = job.steps.filter(s => s?.number === 6 || s?.name === 'Execute only this approved application release');
  const finalizer = job.steps.filter(s => s?.number === 7 || s?.name === finalizerName);
  requireThat(execute.length === 1 && execute[0].number === 6 && execute[0].name === 'Execute only this approved application release' && execute[0].status === 'completed' && execute[0].conclusion === 'failure' && finalizer.length === 1 && finalizer[0].number === 7 && finalizer[0].name === finalizerName && finalizer[0].status === 'completed' && finalizer[0].conclusion === 'success', 'reader_history_steps_changed');
  const step = finalizer[0];
  requireThat(Number.isFinite(Date.parse(execute[0].started_at)) && Number.isFinite(Date.parse(execute[0].completed_at)) && Number.isFinite(Date.parse(step.started_at)) && Number.isFinite(Date.parse(step.completed_at)) && Date.parse(execute[0].started_at) <= Date.parse(execute[0].completed_at) && Date.parse(execute[0].completed_at) <= Date.parse(step.started_at) && Date.parse(step.started_at) <= Date.parse(step.completed_at), 'reader_history_step_times_unknown');
  return step;
}
function validateLog(log, step, custody) {
  requireThat(typeof log === 'string' && log.length > 0 && log.length <= 8000000 && log.endsWith('\n'), 'reader_history_log_incomplete');
  const lines = log.trimEnd().split(/\r?\n/u).map(line => {
    const match = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z) (.*)$/u.exec(line);
    requireThat(match && Number.isFinite(Date.parse(match[1])), 'reader_history_log_format');
    return { time: Date.parse(match[1]), message: match[2] };
  });
  requireThat(lines.at(-1)?.message === 'Cleaning up orphan processes', 'reader_history_log_incomplete');
  const starts = lines.flatMap((line, n) => line.message === finalizerHeader ? [n] : []);
  requireThat(starts.length === 1, 'reader_history_status_ambiguous');
  // The original candidate-download step also prints JSON. Only this audited
  // finalizer's output is custody evidence; duplicate later objects still refuse.
  const objects = lines.flatMap((line, n) => n > starts[0] && line.message === '{' ? [n] : []);
  requireThat(objects.length === 1, 'reader_history_status_ambiguous');
  const start = starts[0], object = objects[0];
  const groupEnd = lines.findIndex((line, n) => n > start && line.message === '##[endgroup]');
  const objectEnd = lines.findIndex((line, n) => n >= object && line.message === '}');
  requireThat(groupEnd > start && object === groupEnd + 1 && objectEnd > object && lines[objectEnd + 1]?.message === 'Post job cleanup.', 'reader_history_finalizer_changed');
  const header = lines.slice(start + 1, groupEnd).map(line => line.message);
  for (const [key, value] of Object.entries({ COMMIT: auditedCommit, RUN_ID: '40519161322', RUN_ATTEMPT: '1', GATE_RUN_ID: '40519161282' })) {
    requireThat(header.filter(line => line.startsWith(`  ${key}:`)).length === 1 && header.includes(`  ${key}: ${value}`), 'reader_history_bindings_changed');
  }
  requireThat(lines.slice(start, objectEnd + 1).every(line => line.time >= Date.parse(step.started_at) && line.time < Date.parse(step.completed_at) + 1000), 'reader_history_log_wrong_step');
  const text = lines.slice(object, objectEnd + 1).map(line => line.message).join('\n');
  let status;
  try { status = JSON.parse(text); } catch { throw new Error('reader_history_status_invalid'); }
  // jq's exact pretty output also rejects duplicate JSON keys, including nested
  // duplicates. No last-key-wins interpretation of conflicting custody is allowed.
  requireThat(JSON.stringify(status, null, 2) === text && Object.keys(status).sort().join(',') === statusKeys, 'reader_history_status_invalid');
  requireThat(status.phase === 'smoke' && status.outcome === 'repair-required' && status.reason === 'task_failed_or_foreign' && status.writesStarted === true && status.migrationStarted === false && status.fromSchema === 142 && status.targetSchema === 142 && status.observedSchema === 142 && status.rollback === null && status.currentTaskArn === custody.taskArn && status.currentTaskOwner === custody.startedBy && status.temporaryReaderDefinition === custody.readerDefinitionArn && status.candidateDefinitions?.operations === custody.sourceOperationsDefinitionArn && status.lastStoppedTaskArn === null, 'reader_history_status_conflict');
}

// Launch intent/custody only. The old combined identity/exit assertion failed:
// neither a matching terminal task nor no historical effects is established.
export async function proveReaderHistory({ custody, run, commit, repository, gh, ghText }) {
  requireThat(commit === auditedCommit && repository === repositoryName && custody.failedRunId === String(runId) && custody.evidenceBasis === 'historical-readonly-retirement', 'reader_history_source_unsupported');
  requireThat(createHash('sha256').update(offRead).digest('hex') === '8e58cba8a0044b376d6f756c3f3bff71a9b37f6f97ac91b0499ce7844d448e01', 'reader_history_readonly_source_changed');
  const prefix = 'arn:aws:ecs:us-east-1:326255650484:';
  requireThat(custody.taskArn === `${prefix}task/fss-prod-cluster/a91d7da900aa401789560498b29d7b12` && custody.startedBy === 'fss-app-40522197864-off-3' && custody.readerDefinitionArn === `${prefix}task-definition/fss-prod-operations:337` && custody.sourceOperationsDefinitionArn === `${prefix}task-definition/fss-prod-operations:335`, 'reader_history_custody_changed');
  validateRun(run);
  validateRun(await gh(`actions/runs/${runId}/attempts/1`));
  const listed = await gh(`actions/runs/${runId}/attempts/1/jobs?per_page=100`);
  requireThat(Array.isArray(listed?.jobs) && listed.jobs.length <= 100 && listed.total_count === listed.jobs.length && new Set(listed.jobs.map(j => j?.id)).size === listed.jobs.length, 'reader_history_jobs_incomplete');
  const matches = listed.jobs.filter(j => j?.name === jobName || j?.id === jobId);
  requireThat(matches.length === 1, 'reader_history_job_ambiguous');
  validateJob(matches[0]);
  const job = await gh(`actions/jobs/${jobId}`);
  const step = validateJob(job);
  requireThat(isDeepStrictEqual(job.steps, matches[0].steps), 'reader_history_job_conflict');
  validateLog(await ghText(`actions/jobs/${jobId}/logs`), step, custody);
  return { failedRunAttempt: 1, applicationJobId: jobId, auditedCommit, historicalExecution: 'UNKNOWN', historicalEffects: 'UNKNOWN' };
}
