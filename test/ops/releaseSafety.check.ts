import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
const safety = await import(repositoryPath('infra/scripts/release-safety.mjs')) as {
  validateOff(read: unknown, expected: number, now: number, previous?: number[]): unknown;
  createReleaseSafety(options: unknown): { quiescent(): Promise<void>; pinRecovery(database: unknown, after: number): Promise<void> };
};
const NOW = Date.parse('2026-10-21T09:30:00Z');
const off = () => ({ releaseOff: true, storedOff: true, effectiveOff: true, finishing: 0, schema: 124, versions: [4], observedAt: new Date(NOW).toISOString() });
const database = { DBInstanceArn: 'arn:aws:rds:us-east-1:326255650484:db:fss-prod-pg', DbiResourceId: 'db-test', Endpoint: { Address: 'private.invalid' }, DBInstanceStatus: 'available', BackupRetentionPeriod: 35 };
function harness(fault = '') {
  let clock = NOW, attempts = 0;
  const state: Record<string, unknown> = {};
  const calls: string[] = [];
  const guard = safety.createReleaseSafety({
    state, save() {}, now: () => clock, cluster: 'cluster', owner: 'owned', network: {},
    async waitFor(check: () => Promise<boolean>, reason: string, limit = 60) {
      for (let n = 0; n < limit; n++) { attempts++; if (await check()) return; clock += 15000; }
      throw new Error(reason);
    },
    async aws(service: string, action: string, args: string[] = []) {
      calls.push(`${service} ${action}`);
      if (action === 'describe-services') return { failures: fault === 'services-unreadable' ? [{}] : [], services: ['api', 'worker'].map(n => ({ serviceName: `fss-prod-${n}`, status: 'ACTIVE', desiredCount: fault === 'service-active' ? 1 : 0, runningCount: 0, pendingCount: fault === 'service-pending' ? 1 : 0 })) };
      if (action === 'list-tasks') {
        expect(args).toContain('--no-paginate');
        expect(args[args.indexOf('--max-results') + 1]).toBe('100');
        const stopped = args.includes('STOPPED');
        return { taskArns: fault === 'running-writer' || stopped && fault.startsWith('stopped-') ? ['writer'] : [], ...(fault === 'task-pagination' || stopped && fault === 'stopped-pagination' ? { nextToken: 'more' } : {}) };
      }
      if (action === 'describe-tasks') return { failures: fault === 'stopped-failure' ? [{}] : [], tasks: fault === 'stopped-missing' ? [] : [{ taskArn: fault === 'stopped-foreign' ? 'foreign' : 'writer', clusterArn: fault === 'stopped-cluster' ? 'foreign' : 'cluster', lastStatus: fault === 'stopped-running' ? 'RUNNING' : fault === 'stopped-stopping' ? 'STOPPING' : fault === 'stopped-unknown' ? undefined : 'STOPPED' }] };
      if (action === 'describe-db-instances') return { DBInstances: [{ ...database, ...(fault === 'database-drift' ? { Endpoint: { Address: 'foreign.invalid' } } : {}), ...(fault === 'retention' ? { BackupRetentionPeriod: 1 } : {}) }] };
      if (action === 'describe-db-instance-automated-backups') return {
        ...(fault === 'backup-pagination' ? { Marker: 'more' } : {}),
        DBInstanceAutomatedBackups: fault === 'missing-backup' ? [] : [{ ...database, DBInstanceIdentifier: 'fss-prod-pg', Status: fault === 'inactive' ? 'retained' : 'active', ...(fault === 'foreign-backup' ? { DbiResourceId: 'foreign' } : {}), RestoreWindow: {
          EarliestTime: fault === 'too-new' ? new Date(NOW + 1).toISOString() : new Date(NOW - 60000).toISOString(),
          LatestTime: fault === 'invalid' ? 'invalid' : new Date(fault === 'lagging' || fault === 'eventually-covered' && attempts < 3 ? NOW - 1 : clock + 60000).toISOString(),
        } }],
      };
      throw new Error('unexpected_cloud_call');
    },
  });
  return { guard, state, calls, attempts: () => attempts };
}

describe('shared release stored OFF validation', () => {
  it('accepts only fresh exact schema/settings with no dispatching messages', () => {
    expect(safety.validateOff(off(), 124, NOW, [4])).toEqual(off());
  });
  it.each([
    { storedOff: false }, { effectiveOff: false }, { releaseOff: false }, { finishing: 1 }, { finishing: -1 },
    { schema: 126 }, { versions: [] }, { versions: ['4'] }, { versions: Array.from({ length: 101 }, () => 4) },
    { observedAt: 'invalid' }, { observedAt: new Date(NOW - 180001).toISOString() }, { observedAt: new Date(NOW + 180001).toISOString() },
  ])('refuses unsafe or stale report %j', change => {
    expect(() => safety.validateOff({ ...off(), ...change }, 124, NOW)).toThrow('sending_not_fresh_off');
  });
  it('does not silently accept owner setting version change', () => {
    expect(() => safety.validateOff(off(), 124, NOW, [3])).toThrow('owner_setting_changed');
  });
});

describe('shared migration quiescence and exact pinned recovery', () => {
  it.each(['services-unreadable', 'service-active', 'service-pending', 'running-writer', 'task-pagination', 'stopped-pagination', 'stopped-running', 'stopped-stopping', 'stopped-unknown', 'stopped-failure', 'stopped-missing', 'stopped-foreign', 'stopped-cluster'])('refuses %s before pin or migration', async fault => {
    const h = harness(fault);
    await expect(h.guard.quiescent()).rejects.toThrow(/services_not_stopped|writers_still_running/u);
    expect(h.state['recoveryPoint']).toBeUndefined();
  });
  it('accepts enumerated desired STOPPED tasks only after exact actual terminal descriptions', async () => {
    const h = harness('stopped-terminal');
    await expect(h.guard.quiescent()).resolves.toBeUndefined();
    expect(h.calls).toContain('ecs describe-tasks');
  });
  it('pins exactly the post-quiescence instant after a bounded backup lag', async () => {
    const h = harness('eventually-covered');
    await h.guard.quiescent(); await h.guard.pinRecovery(database, NOW);
    expect(h.attempts()).toBe(3);
    expect(h.state['recoveryPoint']).toMatchObject({ timestamp: new Date(NOW).toISOString(), databaseArn: database.DBInstanceArn, resourceId: database.DbiResourceId, restoreTested: false });
  });
  it.each([
    ['database-drift', 'backup_binding_changed'], ['retention', 'backup_binding_changed'],
    ['missing-backup', 'backup_window_missing'], ['backup-pagination', 'backup_window_missing'],
    ['inactive', 'backup_window_binding_changed'], ['foreign-backup', 'backup_window_binding_changed'],
    ['invalid', 'backup_window_missing'], ['lagging', 'pitr_not_covering_quiescence'], ['too-new', 'pitr_not_covering_quiescence'],
  ])('refuses %s and never invents a restore point', async (fault, reason) => {
    const h = harness(fault);
    await expect(h.guard.pinRecovery(database, NOW)).rejects.toThrow(reason);
    expect(h.state['recoveryPoint']).toBeUndefined();
    expect(h.attempts()).toBe(reason === 'pitr_not_covering_quiescence' ? 100 : 1);
    expect(h.calls.every(call => call.startsWith('rds describe-'))).toBe(true);
  });
  it('rejects a fabricated future quiescence instant', async () => {
    const h = harness();
    await expect(h.guard.pinRecovery(database, NOW + 1)).rejects.toThrow('quiescence_time_invalid');
    expect(h.calls).toHaveLength(0);
  });
});
