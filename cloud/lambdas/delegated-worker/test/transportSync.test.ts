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
