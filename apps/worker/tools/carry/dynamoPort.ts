import type { OldItem } from './oldShapes.ts';

/**
 * The old table, behind an interface (lane G11).
 *
 * Two properties are the point of this file.
 *
 * **It cannot write.** `OldTableReader` has one method and it reads. There is no put,
 * no delete and no transact anywhere in `apps/worker/tools/carry`, which is the
 * strongest form of Appendix G 20's "the old stack is read-only and is never
 * switched back to" that code can carry: a future change that wanted to write to the
 * old table would have to add the method first, and the test that pins this
 * interface's surface would fail in the same commit.
 *
 * **No SDK here.** `pagedOldTableReader` takes a `DynamoQuery` function, exactly as
 * `createS3SuppressionJournal` takes a `putObject`. The AWS SDK is imported in one
 * file, `awsDynamo.ts`, lazily, by the process that has credentials. Nothing in the
 * gate loads it and no test ever reaches the network.
 */

export interface OldTableReader {
  /** What this reader is, for the export's report. Never a table name or an ARN. */
  readonly description: string;
  /** Every item whose sort key begins with `prefix`, in one array. */
  listByPrefix(prefix: string): Promise<readonly OldItem[]>;
}

/**
 * The reader the tests and the rehearsal use: recorded items, answered by prefix.
 *
 * Recorded rather than generated so a rehearsal can replay a real export's *shapes*
 * — the fixtures under `apps/worker/test/fixtures/carry` are synthetic values in
 * those shapes, and the reader treats them identically to a page from the table.
 */
export function recordedFixtureReader(items: readonly OldItem[]): OldTableReader {
  const recorded = [...items];
  return {
    description: 'recorded_fixture',
    listByPrefix: async prefix => {
      return await Promise.resolve(recorded.filter(item => item.sk.startsWith(prefix)));
    },
  };
}

/** One page of a `Query` against the old table, in the shape the adapter returns. */
export interface DynamoQueryPage {
  readonly items: readonly OldItem[];
  /** The SDK's `LastEvaluatedKey`, opaque here, or null when the query is finished. */
  readonly lastEvaluatedKey: unknown | null;
}

export interface DynamoQueryRequest {
  readonly prefix: string;
  readonly exclusiveStartKey: unknown | null;
}

/** What `awsDynamo.ts` supplies. One call, one page. */
export type DynamoQuery = (request: DynamoQueryRequest) => Promise<DynamoQueryPage>;

/**
 * How many pages one prefix may take before the reader gives up.
 *
 * A cursor that never advances is the failure this guards: DynamoDB returns a
 * `LastEvaluatedKey` that equals the previous one only if something is wrong, and a
 * reader that trusted it would spin for as long as the export was allowed to run. A
 * carry of one salesperson's firms is a handful of pages; two thousand is generous
 * and finite.
 */
export const MAX_PAGES_PER_PREFIX = 2_000;

export class OldTableReadError extends Error {
  constructor(readonly code: 'old_table_paging_exhausted', message: string) {
    super(message);
    this.name = 'OldTableReadError';
  }
}

/** A reader over a paged `Query`. Still read-only; still no SDK in this file. */
export function pagedOldTableReader(options: { readonly description: string; readonly query: DynamoQuery }): OldTableReader {
  return {
    description: options.description,
    listByPrefix: async prefix => {
      const collected: OldItem[] = [];
      let cursor: unknown | null = null;
      for (let page = 0; page < MAX_PAGES_PER_PREFIX; page += 1) {
        const result: DynamoQueryPage = await options.query({ prefix, exclusiveStartKey: cursor });
        collected.push(...result.items);
        if (result.lastEvaluatedKey === null || result.lastEvaluatedKey === undefined) return collected;
        cursor = result.lastEvaluatedKey;
      }
      throw new OldTableReadError('old_table_paging_exhausted', `the old table did not finish paging ${prefix}`);
    },
  };
}
