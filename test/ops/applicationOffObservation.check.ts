import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { harness, arn, release, type Status } from './support/applicationReleaseHarness.ts';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

const { finalizeInterrupted } = await import(repositoryPath('infra/scripts/application-release.mjs')) as { finalizeInterrupted(state: Status): Status };
const { readerRecoveryCommandEnvironment } = await import(repositoryPath('infra/scripts/application-reader-recovery.mjs')) as { readerRecoveryCommandEnvironment(env: Record<string, string>, program: string, args: string[]): Record<string, string> };
function observation(fault?: string) {
  const h = harness({ recovery: true, historical: true, from: 142, to: 142, ...(fault ? { fault } : {}) });
  h.env['FSS_READER_OBSERVATION_ONLY'] = 'true';
  return h;
}

describe('protected OFF observation without reader retirement or release', () => {
  it('executes only fixed read, cleans its own reader, preserves historical custody and emits a distinct terminal result', async () => {
    const h = observation(), oldReader = structuredClone(h.definitions[arn('operations', 337)]);
    const result = await h.run();
    expect(result, result.reason).toMatchObject({ outcome: 'observation-completed', phase: 'off-observation-completed', migrationStarted: false, recoveryPoint: null, off: { storedOff: true }, offObservation: { outcome: 'completed', readerDefinitionArn: arn('operations', 338) }, readerRecovery: { outcome: 'observed', historicalExecution: 'UNKNOWN', historicalEffects: 'UNKNOWN' } });
    expect(finalizeInterrupted(result)).toEqual(result);
    const writes = h.calls.filter(c => c.program === 'aws' && ['register-task-definition', 'run-task', 'deregister-task-definition', 'update-service', 'stop-task'].includes(c.args[1]!));
    expect(writes.map(c => c.args[1])).toEqual(['register-task-definition', 'run-task', 'deregister-task-definition']);
    expect(writes[2]!.args).toContain(arn('operations', 338));
    expect(h.definitions[arn('operations', 337)]).toEqual(oldReader);
    expect(h.definitions[arn('operations', 338)]?.taskDefinition.status).toBe('INACTIVE');
    expect(h.definitions[arn('operations', 338)]?.taskDefinition.containerDefinitions[0]?.entryPoint).toEqual(['node', '--experimental-transform-types', '--input-type=module', '--eval', release.offRead]);
    expect(h.calls.some(c => c.program === 'docker' || c.phase === 'release-record' || c.phase === 'deploy')).toBe(false);
    expect(JSON.stringify(h.states)).not.toContain('secret-shaped-raw-line');
  });
  it.each(['false', 'yes', 'TRUE'])('refuses malformed mode %s before transport', async value => {
    const h = observation(); h.env['FSS_READER_OBSERVATION_ONLY'] = value;
    expect(await h.run()).toMatchObject({ outcome: 'refused', reason: 'reader_observation_input_invalid' });
    expect(h.calls).toHaveLength(0);
  });
  it.each([false, true])('refuses absent/historical=false custody (%s) before transport', async absent => {
    const h = harness({ recovery: !absent, from: 142, to: 142 }); h.env['FSS_READER_OBSERVATION_ONLY'] = 'true';
    expect(await h.run()).toMatchObject({ outcome: 'refused', reason: 'reader_observation_input_invalid' });
    expect(h.calls).toHaveLength(0);
  });
  it.each(['start-unknown', 'exit-unknown', 'foreign-owner'])('retains custody without retry/cleanup after %s', async fault => {
    const h = observation(fault), result = await h.run();
    expect(result).toMatchObject({ outcome: 'repair-required', temporaryReaderDefinition: arn('operations', 338), offObservation: { outcome: 'task-requested' } });
    expect(h.calls.filter(c => c.args[1] === 'run-task')).toHaveLength(1);
    expect(h.calls.some(c => ['deregister-task-definition', 'stop-task', 'update-service'].includes(c.args[1]!))).toBe(false);
  });
  it.each(['off', 'finishing', 'reader-nonzero'])('does not certify OFF on %s despite confirmed cleanup', async fault => {
    const h = observation(fault), result = await h.run();
    expect(result).toMatchObject({ outcome: 'repair-required', offObservation: { outcome: 'cleaned' } });
    expect(result.off).toBeUndefined();
    expect(h.definitions[arn('operations', 337)]?.taskDefinition.status).toBe('ACTIVE');
  });
  it.each(['lost-cleanup', 'still-active', 'family-drift'])('holds %s without replay or falling into release', async fault => {
    const h = observation(), run = h.io.run;
    h.io.run = async (program, args, input) => {
      const output = await run(program, args, input);
      if (program === 'aws' && args[1] === 'deregister-task-definition') {
        if (fault === 'lost-cleanup') throw new Error('command_aws_failed');
        if (fault === 'still-active') h.definitions[arn('operations', 338)]!.taskDefinition.status = 'ACTIVE';
        if (fault === 'family-drift') h.definitions[arn('operations', 337)]!.taskDefinition.status = 'INACTIVE';
      }
      return output;
    };
    expect(await h.run()).toMatchObject({ outcome: 'repair-required', temporaryReaderDefinition: arn('operations', 338), offObservation: { outcome: 'cleanup-requested' } });
    expect(h.calls.filter(c => c.args[1] === 'deregister-task-definition')).toHaveLength(1);
    expect(h.calls.some(c => c.phase === 'release-record')).toBe(false);
  });
  it('retains registration-requested when the registration response is lost', async () => {
    const h = observation(), run = h.io.run;
    h.io.run = async (program, args, input) => { const output = await run(program, args, input); if (args[1] === 'register-task-definition') throw new Error('command_aws_failed'); return output; };
    expect(await h.run()).toMatchObject({ outcome: 'repair-required', offObservation: { outcome: 'registration-requested', readerDefinitionArn: null } });
    expect(h.calls.filter(c => c.args[1] === 'register-task-definition')).toHaveLength(1);
    expect(h.calls.some(c => c.args[1] === 'run-task')).toBe(false);
  });
  it('disables native retries for every observation write while preserving read settings', () => {
    const env = { FSS_READER_OBSERVATION_ONLY: 'true', AWS_MAX_ATTEMPTS: '9' };
    for (const action of ['register-task-definition', 'run-task', 'deregister-task-definition']) expect(readerRecoveryCommandEnvironment(env, 'aws', ['ecs', action])["AWS_MAX_ATTEMPTS"]).toBe('1');
    expect(readerRecoveryCommandEnvironment(env, 'aws', ['ecs', 'describe-tasks'])).toBe(env);
    expect(env.AWS_MAX_ATTEMPTS).toBe('9');
  });
  it('uses the existing protected queue/job and validates mode before credentials', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
    const job = workflow.split('\n  application:\n')[1]!.split('\n  smoke:\n')[0]!;
    expect(workflow).toContain('group: fss-production-deploy\n  cancel-in-progress: false');
    expect(workflow).toContain('[ "$OBSERVE_READER_OFF" = true ]');
    expect(job).toContain('environment: production-release-review');
    expect(job.indexOf('readerObservationRequested')).toBeLessThan(job.indexOf('Assume narrow protected application identity'));
    expect(job).toContain('readerRecovery,offObservation,off}');
  });
  it.each(['success', 'failure', 'cancelled', 'skipped'])('reports observation %s without claiming replacement', result => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
    const block = workflow.split('\n  summary:\n')[1]!.split('        run: |\n')[1]!;
    const script = block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const output = execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env['PATH'], COMMIT: 'bced9eeb', RELEASE_MODE: 'application', OBSERVE_READER_OFF: 'true', APPLICATION_RESULT: result, GITHUB_STEP_SUMMARY: '/dev/null' } });
    expect(output).toContain(`Protected stored-OFF observation ${result}; no application replacement.`);
    expect(output).toContain('Original release remains incomplete');
    expect(output).toContain(result === 'success' ? '::notice::' : '::error::');
    expect(output).not.toContain('Protected application replacement');
  });
});
