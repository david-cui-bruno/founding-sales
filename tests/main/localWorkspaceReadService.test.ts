import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { LegacyWorkflowTransition } from '../../src/main/domain/workspace/legacyWorkflowTransition';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';

const at = '2026-09-09T12:00:00.000Z';
const command = { commandId: 'local-command', expectedMode: 'legacy' as const, manifestId: 'local-manifest' };
describe('local current database recovery', () => {
  it('reads without writes, projects committed runtime extras, replays and recovers after reopen', async () => {
    const temp = createTempDatabase(), key = createTestWorkspaceKey();
    let database = openDatabase({ path: temp.path, key });
    try {
      await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
      const api = createLocalWorkspaceProvider({
        withDatabase: async operation => operation(database),
        withDomain: async operation => operation({ transitionWorkflow: (input: typeof command) => new LegacyWorkflowTransition({ database, unitOfWork: new DomainUnitOfWork(database), clock: { now: () => at }, ids: { next: () => { throw new Error('No invented identity'); } } }).transitionWorkflow(input) } as never),
      });
      database.raw.exec('PRAGMA query_only=ON');
      const before = database.raw.prepare('SELECT total_changes() AS count').get();
      expect(await api.get()).toMatchObject({ scope: 'local_database', workflowMode: 'legacy', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } });
      expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(database.raw.prepare('SELECT * FROM workspace_workflow_state').all()).toEqual([]);
      database.raw.exec('PRAGMA query_only=OFF');
      const receipt = await api.transition(command);
      expect(Object.keys(receipt)).toHaveLength(13);
      expect(Object.hasOwn(receipt, 'expectedMode')).toBe(false);
      expect((await api.get()).transitionReceipt).toEqual(receipt);
      expect(await api.transition(command)).toEqual(receipt);
      closeDatabase(database); database = openDatabase({ path: temp.path, key });
      expect((await api.get()).transitionReceipt).toEqual(receipt);
    } finally { closeDatabase(database); temp.cleanup(); }
  });
});

// Corrupt records are inserted only into owned disposable databases, before immutable receipts exist.
import { createHash } from 'node:crypto';
import { readLocalWorkspace } from '../../src/main/domain/workspace/localWorkspaceReadService';
import { serializeCanonical } from '../../src/main/domain/lifecycle/lifecycleValidation';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { localWorkspaceSnapshotSchema } from '../../src/shared/contracts/localWorkspaceContract';
const emptyReceipt = { commandId: command.commandId, manifestId: command.manifestId, mode: 'meeting_first', revision: 1, occurredAt: at,
  cancelledActionIds: [] as string[], stoppedEnrollmentIds: [] as string[], preservedActionIds: [] as string[], parkedPersonIds: [] as string[], callbackEvidenceIds: [] as string[], unknownDraftIds: [] as string[], parkedReviewActions: [] as { id: string; cycleId: string; version: number }[], parkedActions: [] as { id: string; supersededActionId: string; cycleId: string }[] };
describe('canonical corruption separation', () => {
  it.each(['command', 'manifest', 'fingerprint', 'expectedMode', 'revision', 'stateTime', 'rowTime', 'invalidTime', 'json', 'multipleReceipt', 'multipleState', 'legacyWithReceipt', 'missingState', 'unnormalizedCommand'])(
    'rejects %s corruption instead of pretending legacy or returning unavailable accounts', async corruption => {
      const f = await createPmFixture();
      try {
        const raw: Record<string, unknown> = { ...emptyReceipt, expectedMode: 'legacy' };
        if (corruption === 'expectedMode') raw.expectedMode = 'meeting_first';
        if (corruption === 'invalidTime') raw.occurredAt = 'not-a-time';
        if (corruption === 'revision') raw.revision = 2;
        if (corruption === 'unnormalizedCommand') raw.commandId = ` ${command.commandId} `;
        if (corruption !== 'missingState') f.db.raw.prepare('INSERT INTO workspace_workflow_state VALUES(1,?,?,?)').run(corruption === 'legacyWithReceipt' ? 'legacy' : 'meeting_first', 1, corruption === 'stateTime' ? '2026-09-08T12:00:00.000Z' : at);
        const fingerprint = createHash('sha256').update(serializeCanonical(corruption === 'unnormalizedCommand' ? { ...command, commandId: raw.commandId } : command)).digest('hex');
        f.db.raw.prepare('INSERT INTO workflow_transition_receipts VALUES(?,?,?,?,?)').run(
          corruption === 'command' ? 'different' : String(raw.commandId), corruption === 'manifest' ? 'different' : command.manifestId,
          corruption === 'fingerprint' ? '0'.repeat(64) : fingerprint, corruption === 'json' ? '[]' : JSON.stringify(raw), corruption === 'rowTime' ? '2026-09-08T12:00:00.000Z' : at);
        if (corruption === 'multipleReceipt') f.db.raw.prepare('INSERT INTO workflow_transition_receipts VALUES(?,?,?,?,?)').run('second', 'second', fingerprint, JSON.stringify(raw), at);
        if (corruption === 'multipleState') { f.db.raw.exec('PRAGMA ignore_check_constraints=ON'); f.db.raw.prepare('INSERT INTO workspace_workflow_state VALUES(2,?,?,?)').run('meeting_first', 1, at); }
        f.db.raw.exec('PRAGMA query_only=ON');
        expect(() => readLocalWorkspace(f.db)).toThrow();
      } finally { f.close(); }
    });
  it('does not manufacture exact-command proof from meeting-first mode alone', async () => {
    const f = await createPmFixture();
    try {
      f.db.raw.prepare('INSERT INTO workspace_workflow_state VALUES(1,?,?,?)').run('meeting_first', 1, at);
      expect(readLocalWorkspace(f.db)).toMatchObject({ workflowMode: 'meeting_first', transitionReceipt: null });
    } finally { f.close(); }
  });
  it('returns all local account snapshots in stable order without writes or authority, and preserves receipt on account corruption', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'A Local PM', domain: null });
      const b = f.repo.create({ commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'B Local PM', domain: null });
      f.repo.admitEvidence({ commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', accountId: a.id, expectedVersion: 1,
        sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional managed portfolio evidence', permitted: true }],
        claims: [{ kind: 'fact', key: 'portfolio', value: { count: 100, measure: 'units', scope: 'managed' }, evidenceIds: ['source'] },
          { kind: 'fact', key: 'portfolio', value: { count: 200, measure: 'units', scope: 'managed' }, evidenceIds: ['source'] }],
        routes: [{ id: 'route', accountId: a.id, personId: null, channel: 'phone', value: '+12025550123', purpose: 'business', evidenceIds: ['source'], verification: 'published' }],
      });
      const receipt = new LegacyWorkflowTransition({ database: f.db, unitOfWork: new DomainUnitOfWork(f.db), clock: { now: () => at }, ids: { next: () => { throw new Error('No identity'); } } }).transitionWorkflow(command);
      f.db.raw.exec('PRAGMA query_only=ON');
      const before = f.db.raw.prepare('SELECT total_changes() AS count').get();
      const result = readLocalWorkspace(f.db);
      expect(result.accounts.state).toBe('available');
      if (result.accounts.state !== 'available') throw new Error('Expected complete account evidence');
      expect(result.accounts.snapshots.map(s => s.account.id)).toEqual([a.id, b.id].sort());
      expect(result.accounts.snapshots).toEqual([a.id, b.id].sort().map(id => f.repo.snapshot(id, result.generatedAt)));
      expect(f.db.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(result.transitionReceipt?.commandId).toBe(receipt.commandId);
      const evidence = result.accounts.snapshots.find(snapshot => snapshot.account.id === a.id)!;
      expect(evidence.portfolio.map(p => p.count)).toEqual([100, 200]);
      expect(evidence.conflicts).toContain('portfolio:managed:units');
      expect(evidence.unknowns.length).toBeGreaterThan(0);
      expect(localWorkspaceSnapshotSchema.safeParse({ ...result, accounts: { state: 'available', snapshots: [{ ...evidence, routes: evidence.routes.map(route => ({ ...route, accountId: b.id })) }] } }).success).toBe(false);

      expect(localWorkspaceSnapshotSchema.safeParse({ ...result, accounts: { state: 'available', snapshots: [result.accounts.snapshots[0], result.accounts.snapshots[0]] } }).success).toBe(false);
      f.db.raw.exec('PRAGMA query_only=OFF; PRAGMA ignore_check_constraints=ON');
      f.db.raw.prepare("UPDATE pm_accounts SET name='' WHERE id=?").run(a.id);
      const corrupted = readLocalWorkspace(f.db);
      expect(corrupted.accounts).toEqual({ state: 'unavailable', snapshots: [] });
      expect(corrupted.transitionReceipt).toEqual(result.transitionReceipt);
    } finally { f.close(); }
  });
});
