import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

const { proveReaderHistory } = await import(repositoryPath('infra/scripts/application-reader-history.mjs')) as {
  proveReaderHistory(options: { custody: Record<string, string>; run: Record<string, unknown>; commit: string; repository: string; gh(path: string): Promise<unknown>; ghText(path: string): Promise<string> }): Promise<unknown>;
};
const commit = 'bced9eebcc4c3fef4ee51d7eefd0f92e66f318c7';
const repository = 'david-cui-bruno/founding-sales';
const prefix = 'arn:aws:ecs:us-east-1:326255650484:';
const custody = { failedRunId: '40522197864', taskArn: `${prefix}task/fss-prod-cluster/a91d7da900aa401789560498b29d7b12`, startedBy: 'fss-app-40522197864-off-3', readerDefinitionArn: `${prefix}task-definition/fss-prod-operations:337`, sourceOperationsDefinitionArn: `${prefix}task-definition/fss-prod-operations:335`, evidenceBasis: 'historical-readonly-retirement' };
function fixture() {
  const run = { id: 40522197864, run_attempt: 1, head_sha: commit, path: '.github/workflows/greenfield-deploy.yml', event: 'workflow_dispatch', head_branch: 'main', head_repository: { full_name: repository }, status: 'completed', conclusion: 'failure' };
  const job = { id: 122252105573, run_id: run.id, run_attempt: 1, head_sha: commit, name: 'Opt-in protected application release (legacy remains default)', status: 'completed', conclusion: 'failure', steps: [
    { number: 6, name: 'Execute only this approved application release', status: 'completed', conclusion: 'failure', started_at: '2026-10-27T14:34:28Z', completed_at: '2026-10-27T14:51:22Z' },
    { number: 7, name: 'Actual application phase and recovery boundary', status: 'completed', conclusion: 'success', started_at: '2026-10-27T14:51:22Z', completed_at: '2026-10-27T14:51:22Z' },
  ] };
  // Sanitized original finalizer fields. The stale exit0 deliberately remains.
  const status = { phase: 'smoke', outcome: 'repair-required', writesStarted: true, migrationStarted: false, fromSchema: 142, targetSchema: 142, observedSchema: 142, recoveryPoint: null, reason: 'task_failed_or_foreign', rollback: null, currentTaskArn: custody.taskArn, currentTaskOwner: custody.startedBy, lastStoppedTaskArn: null, lastTaskExitCode: 0, temporaryReaderDefinition: custody.readerDefinitionArn, previousDefinitions: { operations: `${prefix}task-definition/fss-prod-operations:331` }, candidateDefinitions: { operations: custody.sourceOperationsDefinitionArn } };
  const messages = ['##[group]Run if [ -f "$RUNNER_TEMP/application/status.json" ]; then', 'shell: /usr/bin/bash --noprofile --norc -e -o pipefail {0}', `  COMMIT: ${commit}`, '  RUN_ID: 40519161322', '  RUN_ATTEMPT: 1', '  GATE_RUN_ID: 40519161282', '##[endgroup]', ...JSON.stringify(status, null, 2).split('\n'), 'Post job cleanup.', 'Cleaning up orphan processes'];
  const log = messages.map((line, n) => `2026-10-27T14:51:22.${String(n).padStart(7, '0')}Z ${line}`).join('\n') + '\n';
  const paths: string[] = [];
  const options = { custody, run, commit, repository, async gh(path: string) { paths.push(path); if (path.endsWith('/jobs?per_page=100')) return { total_count: 1, jobs: [job] }; if (path.startsWith('actions/jobs/')) return job; return run; }, async ghText(path: string) { paths.push(path); return log; } };
  return { run, job, status, log, options, paths, execute: () => proveReaderHistory(options) };
}

describe('audited original hosted launch custody, never terminal or effects proof', () => {
  it('binds original attempt/job/source and records UNKNOWN historical execution/effects', async () => {
    const h = fixture();
    await expect(h.execute()).resolves.toEqual({ failedRunAttempt: 1, applicationJobId: 122252105573, auditedCommit: commit, historicalExecution: 'UNKNOWN', historicalEffects: 'UNKNOWN' });
    expect(h.paths).toContain('actions/jobs/122252105573/logs');
    expect(h.paths).toContain('actions/runs/40522197864/attempts/1/jobs?per_page=100');
  });
  it('accepts the original earlier candidate JSON without interpreting it as finalizer custody', async () => {
    const h = fixture();
    // The retained original job prints downloaded image bindings in step4.
    h.options.ghText = async () => '2026-10-27T14:34:28.0000000Z {\n2026-10-27T14:34:28.0000001Z   "schema": "fss.image-digests.v1"\n2026-10-27T14:34:28.0000002Z }\n' + h.log;
    await expect(h.execute()).resolves.toMatchObject({ applicationJobId: 122252105573, historicalExecution: 'UNKNOWN' });
  });
  it.each(['commit', 'run-attempt', 'job-attempt', 'job-id', 'job-run', 'job-name', 'job-sha', 'step-name', 'step-conclusion', 'step-number', 'missing-step', 'duplicate-step'])('rejects changed %s provenance', async fault => {
    const h = fixture();
    if (fault === 'commit') h.options.commit = 'a'.repeat(40);
    if (fault === 'run-attempt') h.run.run_attempt = 2;
    if (fault === 'job-attempt') h.job.run_attempt = 2;
    if (fault === 'job-id') h.job.id++;
    if (fault === 'job-run') h.job.run_id++;
    if (fault === 'job-name') h.job.name = 'forged finalizer';
    if (fault === 'job-sha') h.job.head_sha = 'a'.repeat(40);
    if (fault === 'step-name') h.job.steps[1]!.name = 'forged finalizer';
    if (fault === 'step-conclusion') h.job.steps[1]!.conclusion = 'failure';
    if (fault === 'step-number') h.job.steps[1]!.number = 8;
    if (fault === 'missing-step') h.job.steps.pop();
    if (fault === 'duplicate-step') h.job.steps.push(h.job.steps[1]!);
    await expect(h.execute()).rejects.toThrow(/reader_history_/u);
  });
  it.each(['missing-job', 'duplicate-job', 'incomplete-jobs', 'detail-conflict', 'attempt-conflict'])('rejects %s discovery', async fault => {
    const h = fixture(), original = h.options.gh;
    h.options.gh = async path => {
      if (path.endsWith('/jobs?per_page=100') && ['missing-job', 'duplicate-job', 'incomplete-jobs'].includes(fault)) return { total_count: fault === 'missing-job' ? 0 : 2, jobs: fault === 'missing-job' ? [] : fault === 'incomplete-jobs' ? [h.job] : [h.job, h.job] };
      if (fault === 'detail-conflict' && path.startsWith('actions/jobs/')) return { ...h.job, run_attempt: 2 };
      if (fault === 'attempt-conflict' && path.endsWith('/attempts/1')) return { ...h.run, head_sha: 'a'.repeat(40) };
      return original(path);
    };
    await expect(h.execute()).rejects.toThrow(/reader_history_/u);
  });
  it.each(['truncated', 'duplicate-status', 'duplicate-key', 'foreign-task', 'foreign-owner', 'foreign-reader', 'foreign-source', 'forged-step', 'wrong-time', 'wrong-image-run', 'wrong-commit', 'missing-status', 'invalid-json'])('rejects %s log evidence', async fault => {
    const h = fixture(); let log = h.log;
    if (fault === 'truncated') log = log.slice(0, log.indexOf('Post job cleanup.'));
    if (fault === 'duplicate-status') log += h.log;
    if (fault === 'duplicate-key') log = log.replace('  "phase": "smoke",', '  "phase": "smoke",\n2026-10-27T14:51:22.0000001Z   "phase": "smoke",');
    if (fault === 'foreign-task') log = log.replace('a91d7da900aa401789560498b29d7b12', 'f'.repeat(32));
    if (fault === 'foreign-owner') log = log.replace('fss-app-40522197864-off-3', 'fss-app-40522197864-off-2');
    if (fault === 'foreign-reader') log = log.replace('operations:337', 'operations:336');
    if (fault === 'foreign-source') log = log.replace('operations:335', 'operations:334');
    if (fault === 'forged-step') log = log.replace('Run if [ -f', 'Run echo forged; if [ -f');
    if (fault === 'wrong-time') log = log.replaceAll('14:51:22.', '14:53:22.');
    if (fault === 'wrong-image-run') log = log.replace('RUN_ID: 40519161322', 'RUN_ID: 999');
    if (fault === 'wrong-commit') log = log.replace(commit, 'a'.repeat(40));
    if (fault === 'missing-status') log = log.replace('Z {\n', 'Z unavailable\n');
    if (fault === 'invalid-json') log = log.replace('"phase": "smoke"', '"phase": unknown');
    h.options.ghText = async () => log;
    await expect(h.execute()).rejects.toThrow(/reader_history_/u);
  });
});
