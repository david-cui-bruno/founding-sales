import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { SYNC_BUDGET_MS, SYNC_REQUEST_TIMEOUT_MS, SqlDelegationTransport, synchronizeDelegation } from '../../src/main/delegation/delegationSync';
import type { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { eventPageSchema, type EventPage, type WorkerEvent } from '../../src/shared/contracts/delegationContract';

const workspaceId = 'fictional-paired-workspace';
const pairingId = '00000000-0000-4000-8000-000000000001';
const clock = { now: () => PM_NOW };
const cursorAt = (sequence: number) => sequence === 0 ? null : `${accountFingerprint(workspaceId)}:${sequence}`;
/** David's real backlog on 18 Sep 2026: 835 published events, 252 created, 330 evidence, 247 receipt. */
const BACKLOG = 835;
const WORKER_PAGE = 200;
function backlogEvent(sequence: number): WorkerEvent {
  const accountId = `fictional-firm-${sequence}`;
  const base = { id: `event-${sequence}`, workspaceId, accountId, authorityGeneration: 0 } as const;
  if (sequence % 3 === 1) return { ...base, aggregateVersion: 1, kind: 'research.created',
    payload: { account: { id: accountId, name: `Fictional PM ${sequence}`, domain: null, version: 1 }, createdAt: PM_NOW } };
  if (sequence % 3 === 2) return { ...base, aggregateVersion: 2, kind: 'research.evidence',
    payload: { admittedAt: PM_NOW, batch: { commandId: randomUUID(), accountId, expectedVersion: 1,
      sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional residential operations', permitted: true }],
      claims: [{ key: 'residential_scope', kind: 'fact', value: 'Residential PM', evidenceIds: ['source'] }], routes: [] } } };
  return { ...base, aggregateVersion: 3, kind: 'research.receipt',
    payload: { jobId: `job-${sequence}`, receiptCommandId: null, status: 'completed', costMicros: null, observedAt: PM_NOW } };
}
const backlog = Object.freeze(Array.from({ length: BACKLOG }, (_, index) => backlogEvent(index + 1)));

/** Serves the backlog exactly as the paged worker does, and can stall one page until the budget aborts it. */
function worker(options: { stallAtPage?: number; pageSize?: number } = {}) {
  const size = options.pageSize ?? WORKER_PAGE;
  const requests: (string | null)[] = [];
  let page = 0;
  const eventsAfter = async (cursor: string | null, signal: AbortSignal): Promise<EventPage> => {
    requests.push(cursor); page++;
    if (options.stallAtPage === page) {
      return new Promise<EventPage>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('fictional worker never answered')); return; }
        signal.addEventListener('abort', () => reject(new Error('fictional worker never answered')), { once: true });
      });
    }
    const after = cursor === null ? 0 : Number(cursor.split(':')[1]);
    const events = backlog.slice(after, after + size);
    const next = after + events.length;
    return eventPageSchema.parse({ events, nextCursor: cursorAt(next), headCursor: cursorAt(BACKLOG), complete: next === BACKLOG });
  };
  return { eventsAfter, requests, pages: () => page };
}
const applying = (outcome: (event: WorkerEvent, seen: number) => 'applied' | 'duplicate' | 'gap' = () => 'applied') => {
  let seen = 0;
  return { applyWorkerEvent: (event: WorkerEvent) => outcome(event, ++seen), pendingCommands: (): [] => [] } as unknown as DelegationRepository;
};

describe('synchronizeDelegation throughput', () => {
  it('applies the whole 835-event backlog inside the sync budget', async () => {
    const f = await createPmFixture();
    try {
      const transport = new SqlDelegationTransport({ database: f.db, workspaceId, pairingId, clock });
      const remote = worker();
      const started = performance.now();
      const report = await synchronizeDelegation({ repository: applying(), transport,
        flushPending: async () => undefined, eventsAfter: remote.eventsAfter }, AbortSignal.timeout(SYNC_BUDGET_MS));
      const elapsed = performance.now() - started;
      expect(report).toEqual({ applied: BACKLOG, gaps: 0, cursor: cursorAt(BACKLOG), ownerFresh: true, failure: null });
      expect(remote.pages()).toBe(5);
      // Measured at 22 ms locally on 18 Sep 2026. The bound is deliberately loose for a slow runner
      // and still an order of magnitude inside the budget the old flat 15 s could not reach.
      expect(elapsed).toBeLessThan(SYNC_BUDGET_MS / 10);
      expect(transport.current()).toMatchObject({ state: 'complete', cursor: cursorAt(BACKLOG) });
    } finally { f.close(); }
  });
  it('checkpoints the cursor after every complete page and resumes there after a stalled page', async () => {
    const f = await createPmFixture();
    try {
      const transport = new SqlDelegationTransport({ database: f.db, workspaceId, pairingId, clock });
      const stalled = worker({ stallAtPage: 3 });
      const first = await synchronizeDelegation({ repository: applying(), transport,
        flushPending: async () => undefined, eventsAfter: stalled.eventsAfter }, AbortSignal.timeout(250));
      expect(first).toEqual({ applied: WORKER_PAGE * 2, gaps: 0, cursor: cursorAt(WORKER_PAGE * 2), ownerFresh: false, failure: 'timeout' });
      // The record stays honest: a checkpointed but incomplete run is failed with the cursor advanced.
      expect(transport.current()).toMatchObject({ state: 'failed', completedAt: null, cursor: cursorAt(WORKER_PAGE * 2) });
      const resumed = worker();
      const second = await synchronizeDelegation({ repository: applying(), transport,
        flushPending: async () => undefined, eventsAfter: resumed.eventsAfter }, AbortSignal.timeout(SYNC_BUDGET_MS));
      expect(resumed.requests[0]).toBe(cursorAt(WORKER_PAGE * 2));
      expect(second).toEqual({ applied: BACKLOG - WORKER_PAGE * 2, gaps: 0, cursor: cursorAt(BACKLOG), ownerFresh: true, failure: null });
      expect(transport.current()).toMatchObject({ state: 'complete', cursor: cursorAt(BACKLOG) });
    } finally { f.close(); }
  });
  it('names the closed failure reason and never claims freshness for a short run', async () => {
    const f = await createPmFixture();
    try {
      const options = { database: f.db, workspaceId, pairingId, clock };
      const gapped = await synchronizeDelegation({ repository: applying((_event, seen) => seen === 5 ? 'gap' : 'applied'),
        transport: new SqlDelegationTransport(options), flushPending: async () => undefined, eventsAfter: worker().eventsAfter },
        AbortSignal.timeout(SYNC_BUDGET_MS));
      expect(gapped).toMatchObject({ applied: 4, gaps: 1, ownerFresh: false, failure: 'gap' });
      const invalid = await synchronizeDelegation({ repository: applying(), transport: new SqlDelegationTransport(options),
        flushPending: async () => undefined, eventsAfter: async () => ({ events: [{ id: 'not-an-event' }], nextCursor: null, headCursor: null, complete: true } as unknown as EventPage) },
        AbortSignal.timeout(SYNC_BUDGET_MS));
      expect(invalid).toMatchObject({ applied: 0, ownerFresh: false, failure: 'invalid_event' });
      const offline = await synchronizeDelegation({ repository: applying(), transport: new SqlDelegationTransport(options),
        flushPending: async () => undefined, eventsAfter: async () => { throw new Error('fictional offline'); } },
        AbortSignal.timeout(SYNC_BUDGET_MS));
      expect(offline).toMatchObject({ applied: 0, cursor: null, ownerFresh: false, failure: 'transport' });
    } finally { f.close(); }
  });
  it('keeps the per-request timeout well inside the per-sync budget', () => {
    expect(SYNC_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(SYNC_BUDGET_MS).toBe(120_000);
  });
});
