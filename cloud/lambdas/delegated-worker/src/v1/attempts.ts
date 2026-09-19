import { randomBytes } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { attemptRecordSchema, DIAGNOSTICS_ATTEMPT_LIMIT, type AttemptKind, type AttemptRecord } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';

/**
 * The attempt log (FSS target design section 2, `ATTEMPT#<ts>#<id>`): the worker's own account of what it
 * tried, kept 30 days in the workspace partition. Everything the Diagnostics page shows comes from here.
 *
 * Writing is best effort by design: the log describes the work, it never decides it. A failed write is one
 * console warning naming the event and the kind, and no caller ever sees an exception from `recordAttempt`.
 * A record is never logged: its detail is the contract's closed object (codes, identifiers, counts) or null,
 * and a record the contract refuses is dropped, never coerced.
 */

export const ATTEMPT_PREFIX = 'ATTEMPT#';
/** The end of the ATTEMPT# key range: `~` sorts after every character an ISO instant or hex suffix can contain. */
export const ATTEMPT_RANGE_END = 'ATTEMPT#~';
export const ATTEMPT_TTL_SECONDS = 30 * 24 * 3600;
/** With a kind filter the query reads this many newest rows before filtering; without one it reads only the page. */
const FILTERED_FETCH_LIMIT = 100;

/** What a call site supplies; `at` is always the store's clock. */
export type AttemptInput = Omit<AttemptRecord, 'at'>;

/**
 * A closed code from a command kind (`bootstrap-selected-account`), an error class (`DynamoReadUnavailable`) or any
 * other short word: lower-case words joined by one underscore, at most 40 characters, never empty. Pure.
 */
export function attemptCode(value: string): string {
  const code = value.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
  return code || 'unknown';
}

/** Writes one attempt. Never throws: a record the contract refuses or a write that fails is one console warning without the record. */
export async function recordAttempt(store: DynamoStore, input: AttemptInput): Promise<void> {
  let record: AttemptRecord;
  try { record = attemptRecordSchema.parse({ ...input, at: store.now() }); }
  catch {
    console.warn(JSON.stringify({ event: 'attempt_record_invalid', kind: String(input.kind).slice(0, 20) }));
    return;
  }
  const key = `${ATTEMPT_PREFIX}${record.at}#${randomBytes(4).toString('hex')}`;
  const ttl = Math.floor(Date.parse(record.at) / 1000) + ATTEMPT_TTL_SECONDS;
  try { await store.transact([store.put(key, record, null, { ttl })]); }
  catch { console.warn(JSON.stringify({ event: 'attempt_record_write_failed', kind: record.kind })); }
}

/**
 * The newest attempts, newest first, at most 20. With a kind filter the query reads up to 100 newest rows and
 * filters them here; DynamoDB's own `Limit` applies before any filter, so a filtered page could otherwise come
 * back short. The page cap is enforced here as well: the store never relies on `Limit` alone.
 */
export async function listAttempts(store: DynamoStore, input: { kind?: AttemptKind; limit?: number }): Promise<AttemptRecord[]> {
  const limit = Math.min(DIAGNOSTICS_ATTEMPT_LIMIT, Math.max(1, Math.floor(input.limit ?? DIAGNOSTICS_ATTEMPT_LIMIT)));
  const result = await store.options.dynamo.send(new QueryCommand({ TableName: store.options.tableName, ConsistentRead: true,
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    ExpressionAttributeValues: { ':pk': store.key('').pk, ':from': { S: ATTEMPT_PREFIX }, ':to': { S: ATTEMPT_RANGE_END } },
    ScanIndexForward: false, Limit: input.kind ? FILTERED_FETCH_LIMIT : limit }));
  const rows = (result.Items ?? []).flatMap(item => {
    if (typeof item.sk?.S !== 'string' || typeof item.data?.S !== 'string') return [];
    let parsed: unknown;
    try { parsed = JSON.parse(item.data.S); } catch { return []; }
    const record = attemptRecordSchema.safeParse(parsed);
    return record.success ? [{ key: item.sk.S, record: record.data }] : [];
  });
  // Newest first whatever order the adapter returned. Rows written in the same millisecond differ only by their
  // random suffix, so the log promises no order among them; a reader that cares compares instants, not positions.
  rows.sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  return rows.filter(row => !input.kind || row.record.kind === input.kind).slice(0, limit).map(row => row.record);
}
