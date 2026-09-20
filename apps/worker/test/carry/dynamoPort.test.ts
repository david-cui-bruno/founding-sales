import { describe, expect, it } from 'vitest';
import {
  MAX_PAGES_PER_PREFIX,
  OldTableReadError,
  pagedOldTableReader,
  recordedFixtureReader,
  type DynamoQueryPage,
} from '../../tools/carry/dynamoPort.ts';
import { goodOldTable } from '../fixtures/carry/oldTable.ts';

/**
 * The old table's port (lane G11; Appendix G 20).
 *
 * Two things are proved here. The interface cannot write — which is the strongest
 * form of "the old stack is read-only" that code can carry, because a future change
 * that wanted to write would have to add the method and this test would fail in the
 * same commit. And the pager finishes: a cursor that never advances is bounded
 * rather than spun on until the export's own timeout.
 */

describe('the old-table reader', () => {
  it('has one method, and it reads', () => {
    for (const reader of [
      recordedFixtureReader(goodOldTable()),
      pagedOldTableReader({ description: 'test', query: async () => ({ items: [], lastEvaluatedKey: null }) }),
    ]) {
      expect(Object.keys(reader).sort()).toEqual(['description', 'listByPrefix']);
      for (const forbidden of ['put', 'write', 'delete', 'transact', 'update']) {
        expect(Object.keys(reader)).not.toContain(forbidden);
      }
    }
  });

  it('answers a prefix with only the items under it', async () => {
    const reader = recordedFixtureReader(goodOldTable());
    const templates = await reader.listByPrefix('TEMPLATE#');
    expect(templates.map(item => item.sk)).toEqual(['TEMPLATE#T1', 'TEMPLATE#T2']);
    // `SUPPRESS#` covers both scopes in one query: the firm keys are a longer prefix
    // of the same space, and a handle is `encodeURIComponent`d so `#` cannot collide.
    const suppressions = await reader.listByPrefix('SUPPRESS#');
    expect(suppressions).toHaveLength(4);
    expect(suppressions.filter(item => item.sk.startsWith('SUPPRESS#FIRM#'))).toHaveLength(1);
  });

  it('follows the cursor to the end and concatenates the pages', async () => {
    const pages: DynamoQueryPage[] = [
      { items: [{ sk: 'FIRM#one', workspaceId: 'w', data: {} }], lastEvaluatedKey: { sk: { S: 'FIRM#one' } } },
      { items: [{ sk: 'FIRM#two', workspaceId: 'w', data: {} }], lastEvaluatedKey: { sk: { S: 'FIRM#two' } } },
      { items: [{ sk: 'FIRM#three', workspaceId: 'w', data: {} }], lastEvaluatedKey: null },
    ];
    const seen: unknown[] = [];
    const reader = pagedOldTableReader({
      description: 'paged',
      query: async request => {
        seen.push(request.exclusiveStartKey);
        return pages[seen.length - 1] ?? { items: [], lastEvaluatedKey: null };
      },
    });
    const items = await reader.listByPrefix('FIRM#');
    expect(items.map(item => item.sk)).toEqual(['FIRM#one', 'FIRM#two', 'FIRM#three']);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toEqual({ sk: { S: 'FIRM#one' } });
  });

  it('treats an empty LastEvaluatedKey as the end, as the old store did', async () => {
    const reader = pagedOldTableReader({
      description: 'paged',
      query: async () => ({ items: [], lastEvaluatedKey: undefined }),
    });
    expect(await reader.listByPrefix('FIRM#')).toEqual([]);
  });

  it('gives up on a cursor that never advances rather than spinning', async () => {
    let calls = 0;
    const reader = pagedOldTableReader({
      description: 'stuck',
      query: async () => {
        calls += 1;
        return { items: [], lastEvaluatedKey: { sk: { S: 'FIRM#stuck' } } };
      },
    });
    await expect(reader.listByPrefix('FIRM#')).rejects.toBeInstanceOf(OldTableReadError);
    expect(calls).toBe(MAX_PAGES_PER_PREFIX);
  });
});
