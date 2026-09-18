import { expect, it } from 'vitest';
import { DynamoStore } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import type { WorkerEvent } from '../../../../src/shared/contracts/delegationContract';
function fixture(publish?: (event: WorkerEvent) => Promise<void>) {
  return new DynamoStore({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional-table', workspaceId: 'fictional-workspace',
    clock: { now: () => '2026-09-08T12:00:00.000Z' }, publish });
}
const event: WorkerEvent = { id: 'event-one', workspaceId: 'fictional-workspace', accountId: 'fictional-account', authorityGeneration: 0,
  aggregateVersion: 1, kind: 'research.created', payload: { account: { id: 'fictional-account', name: 'Fictional PM', domain: null, version: 1 }, createdAt: '2026-09-08T12:00:00.000Z' } };
it('distinguishes an unpublished lower event from a completely caught-up empty stream', async () => {
  const store = fixture(async () => undefined);
  expect(await store.eventsAfter(null)).toMatchObject({ events: [], nextCursor: null, headCursor: null, complete: true });
  const pending = await store.eventItems(event); await store.transact(pending.items);
  const blocked = await store.eventsAfter(null);
  expect(blocked).toMatchObject({ events: [], nextCursor: null, complete: false });
  expect(blocked).toHaveProperty('headCursor', expect.stringMatching(/:1$/));
  await store.publish(pending.sequence);
  const complete = await store.eventsAfter(null);
  expect(complete).toMatchObject({ events: [event], complete: true });
  expect(complete).toHaveProperty('headCursor', complete.nextCursor);
  expect(await store.eventsAfter(complete.nextCursor)).toMatchObject({ events: [], nextCursor: complete.nextCursor, complete: true });
});
it('does not advance past a missing head event or a foreign workspace cursor', async () => {
  const store = fixture();
  await store.transact([store.put('EVENT_HEAD', { sequence: 1 }, null)]);
  expect(await store.eventsAfter(null)).toMatchObject({ nextCursor: null, complete: false });
  await expect(store.eventsAfter(`${'a'.repeat(64)}:1`)).rejects.toThrow('invalid_cursor');
});

import { GetItemCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { EVENT_PAGE_LIMIT, EVENT_PAGE_MAX_BYTES, fingerprint, type DynamoAdapter, type DynamoCommand, type DynamoResult } from '../src/dynamoStore';
const NOW = '2026-09-08T12:00:00.000Z';
/** Counts the real SDK commands the store emits. It never answers on its own. */
class CountingDynamo implements DynamoAdapter {
  gets = 0; queries = 0; lastQuery: QueryCommandInput | undefined;
  constructor(private readonly inner: DynamoAdapter) {}
  send(command: DynamoCommand): Promise<DynamoResult> {
    if (command instanceof GetItemCommand) this.gets++;
    if (command instanceof QueryCommand) { this.queries++; this.lastQuery = command.input; }
    return this.inner.send(command);
  }
}
/** The three kinds that make up David's real backlog (252 created, 330 evidence, 247 receipt at 18 Sep 2026). */
function backlogEvent(sequence: number): WorkerEvent {
  const accountId = `fictional-firm-${sequence}`;
  const base = { id: `event-${sequence}`, workspaceId: 'fictional-workspace', accountId, authorityGeneration: 0 } as const;
  if (sequence % 3 === 1) return { ...base, aggregateVersion: 1, kind: 'research.created',
    payload: { account: { id: accountId, name: `Fictional PM ${sequence}`, domain: null, version: 1 }, createdAt: NOW } };
  if (sequence % 3 === 2) return { ...base, aggregateVersion: 2, kind: 'research.evidence',
    payload: { admittedAt: NOW, batch: { commandId: randomUUID(), accountId, expectedVersion: 1,
      sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional residential operations', permitted: true }],
      claims: [{ key: 'residential_scope', kind: 'fact', value: 'Residential PM', evidenceIds: ['source'] }], routes: [] } } };
  return { ...base, aggregateVersion: 3, kind: 'research.receipt',
    payload: { jobId: `job-${sequence}`, receiptCommandId: null, status: 'completed', costMicros: null, observedAt: NOW } };
}
async function backlog(count: number, unpublished: ReadonlySet<number> = new Set()) {
  const harness = new ConditionalCommandHarness();
  const counting = new CountingDynamo(harness);
  const store = new DynamoStore({ dynamo: counting, tableName: 'fictional-table', workspaceId: 'fictional-workspace', clock: { now: () => NOW } });
  for (let sequence = 1; sequence <= count; sequence++) {
    await store.transact([store.put(store.eventKey(sequence), { sequence, event: backlogEvent(sequence), published: !unpublished.has(sequence) }, null)]);
  }
  await store.transact([store.put('EVENT_HEAD', { sequence: count }, null)]);
  counting.gets = 0; counting.queries = 0;
  return { store, counting };
}
it('reads 835 published events as bounded pages, one range query per page', async () => {
  const { store, counting } = await backlog(835);
  const first = await store.eventsAfter(null);
  expect(first.events).toHaveLength(EVENT_PAGE_LIMIT);
  expect(first.complete).toBe(false);
  expect(first.nextCursor).toMatch(new RegExp(`:${EVENT_PAGE_LIMIT}$`));
  expect(first.headCursor).toMatch(/:835$/);
  // One EVENT_HEAD read plus exactly one bounded range query. The old store issued 200 GetItems here.
  expect(counting.queries).toBe(1);
  expect(counting.gets).toBe(1);
  expect(counting.lastQuery?.Limit).toBe(EVENT_PAGE_LIMIT);
  expect(counting.lastQuery?.ConsistentRead).toBe(true);
  expect(counting.lastQuery?.ScanIndexForward).toBe(true);
  expect(counting.lastQuery?.KeyConditionExpression).toBe('#pk = :pk AND #sk BETWEEN :from AND :to');
  expect(counting.lastQuery?.ExpressionAttributeValues).toMatchObject({ ':from': { S: 'EVENT#0000000000000001' }, ':to': { S: 'EVENT#0000000000000835' } });
  expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThan(EVENT_PAGE_MAX_BYTES);
  let cursor = first.nextCursor; let total = first.events.length; let pages = 1; let page = first;
  while (!page.complete) {
    page = await store.eventsAfter(cursor);
    expect(page.events.length).toBeLessThanOrEqual(EVENT_PAGE_LIMIT);
    total += page.events.length; cursor = page.nextCursor; pages++;
    if (pages > 10) throw new Error('page budget exceeded');
  }
  expect(total).toBe(835);
  expect(pages).toBe(5);
  expect(page.nextCursor).toBe(page.headCursor);
  expect(counting.queries).toBe(5);
});
it('ends a page at the last published event when a lower sequence is still unpublished', async () => {
  const { store } = await backlog(835, new Set([300]));
  const first = await store.eventsAfter(null);
  expect(first.events).toHaveLength(EVENT_PAGE_LIMIT);
  const second = await store.eventsAfter(first.nextCursor);
  expect(second.events).toHaveLength(99);
  expect(second.nextCursor).toMatch(/:299$/);
  expect(second.complete).toBe(false);
  // The hole is never skipped: the same cursor stays stuck at 299 until sequence 300 publishes.
  const again = await store.eventsAfter(second.nextCursor);
  expect(again).toMatchObject({ events: [], nextCursor: second.nextCursor, complete: false });
  await expect(store.eventsAfter(`${'b'.repeat(64)}:1`)).rejects.toThrow('invalid_cursor');
  await expect(store.eventsAfter(`${fingerprint('fictional-workspace')}:836`)).rejects.toThrow('invalid_cursor');
});
