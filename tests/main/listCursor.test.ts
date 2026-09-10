import { describe, expect, it } from 'vitest';
import { pageFromSnapshot } from '../../src/main/domain/support/listCursor';

const input: Parameters<typeof pageFromSnapshot<number>>[0] = { scope: 'leads' as const, queryKey: 'exact query', snapshotKey: 'ordered rows v1', rows: [1, 2, 3], cursor: null, limit: 2 };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function firstCursor() {
  const cursor = pageFromSnapshot(input).nextCursor;
  expect(cursor).not.toBeNull();
  return cursor!;
}

describe('full-projection snapshot cursor', () => {
  it('returns bounded pages and terminates without changing the input', () => {
    expect(pageFromSnapshot(input).rows).toEqual([1, 2]);
    expect(pageFromSnapshot({ ...input, cursor: firstCursor() })).toEqual({ rows: [3], nextCursor: null });
    expect(input.rows).toEqual([1, 2, 3]);
    expect(pageFromSnapshot({ ...input, rows: [] })).toEqual({ rows: [], nextCursor: null });
  });
  it.each(['1', '200junk', '-1', '', '!', 'a'.repeat(1025)])('rejects invalid encoding %s', cursor => {
    expect(() => pageFromSnapshot({ ...input, cursor })).toThrow('LIST_CURSOR_INVALID');
  });
  it('rejects noncanonical base64 padding', () => {
    expect(() => pageFromSnapshot({ ...input, cursor: `${firstCursor()}=` })).toThrow('LIST_CURSOR_INVALID');
  });
  it.each([
    { v: 2 }, { scope: 'other' }, { extra: true }, { index: -1 }, { index: 0 },
    { index: 1.5 }, { index: Number.MAX_SAFE_INTEGER + 1 }, { index: 3 },
    { queryHash: 'not-a-hash' }, { snapshotHash: null },
  ])('rejects a structurally invalid cursor %j', change => {
    const decoded: object = JSON.parse(Buffer.from(firstCursor(), 'base64url').toString());
    expect(() => pageFromSnapshot({ ...input, cursor: encode({ ...decoded, ...change }) })).toThrow('LIST_CURSOR_INVALID');
  });
  it('binds scope and exact query controls', () => {
    const cursor = firstCursor();
    expect(() => pageFromSnapshot({ ...input, scope: 'review', cursor })).toThrow('LIST_CURSOR_INVALID');
    expect(() => pageFromSnapshot({ ...input, queryKey: 'different query', cursor })).toThrow('LIST_CURSOR_INVALID');
  });
  it('rejects changed projections, even when the visible page boundary is unchanged', () => {
    expect(() => pageFromSnapshot({ ...input, snapshotKey: 'ordered rows v2', cursor: firstCursor() })).toThrow('LIST_CURSOR_STALE');
  });
  it('rejects a changed snapshot before treating its old index as out of range', () => {
    expect(() => pageFromSnapshot({ ...input, snapshotKey: 'empty now', rows: [], cursor: firstCursor() })).toThrow('LIST_CURSOR_STALE');
  });
});
