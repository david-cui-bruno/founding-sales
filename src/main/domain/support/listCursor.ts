import { createHash } from 'node:crypto';
import { z } from 'zod';

export type ListCursorErrorCode = 'LIST_CURSOR_INVALID' | 'LIST_CURSOR_STALE';
export class ListCursorError extends Error {
  constructor(readonly code: ListCursorErrorCode) {
    super(code);
    this.name = 'ListCursorError';
  }
}
const readCursorSchema = z.object({
  v: z.literal(1),
  scope: z.enum(['leads', 'review']),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  index: z.number().int().safe().positive(),
}).strict();
export type ReadCursor = z.infer<typeof readCursorSchema>;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Stateless, O(N) fingerprint guard. Hashes identify projections, not authority. */
export function pageFromSnapshot<T>(input: {
  scope: ReadCursor['scope']; queryKey: string; snapshotKey: string;
  rows: readonly T[]; cursor: string | null; limit: number;
}): { rows: T[]; nextCursor: string | null } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new ListCursorError('LIST_CURSOR_INVALID');
  }
  const queryHash = hash(input.queryKey);
  const snapshotHash = hash(input.snapshotKey);
  let index = 0;
  if (input.cursor !== null) {
    let cursor: ReadCursor;
    try {
      if (input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
      const bytes = Buffer.from(input.cursor, 'base64url');
      if (bytes.toString('base64url') !== input.cursor) throw new Error();
      cursor = readCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new ListCursorError('LIST_CURSOR_INVALID');
    }
    if (cursor.scope !== input.scope || cursor.queryHash !== queryHash) {
      throw new ListCursorError('LIST_CURSOR_INVALID');
    }
    if (cursor.snapshotHash !== snapshotHash) throw new ListCursorError('LIST_CURSOR_STALE');
    if (cursor.index >= input.rows.length || cursor.index % input.limit !== 0) {
      throw new ListCursorError('LIST_CURSOR_INVALID');
    }
    index = cursor.index;
  }
  const rows = input.rows.slice(index, index + input.limit);
  const nextIndex = index + rows.length;
  const next: ReadCursor = { v: 1, scope: input.scope, queryHash, snapshotHash, index: nextIndex };
  return {
    rows,
    nextCursor: nextIndex < input.rows.length
      ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
  };
}
