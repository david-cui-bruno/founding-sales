import { randomBytes } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { attemptRecordSchema, DIAGNOSTICS_ATTEMPT_LIMIT, type AttemptKind, type AttemptRecord } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';

/**
 * The attempt log (FSS target design section 2, `ATTEMPT#<ts>#<id>`): the worker's own account of what it
 * tried, kept 30 days in the workspace partition. Everything the Diagnostics page shows comes from here.
 *
 * Writing is best effort by design: the log describes the work, it never decides it. A failed write is a
 * console warning, and no caller ever sees an exception from `recordAttempt`. Details are sanitised before
 * they are stored so that an address, a bearer token or a long secret can never reach a device through the
 * view.
 */

export const ATTEMPT_PREFIX = 'ATTEMPT#';
/** The end of the ATTEMPT# key range: `~` sorts after every character an ISO instant or hex suffix can contain. */
export const ATTEMPT_RANGE_END = 'ATTEMPT#~';
export const ATTEMPT_TTL_SECONDS = 30 * 24 * 3600;
/** With a kind filter the query reads this many newest rows before filtering; without one it reads only the page. */
const FILTERED_FETCH_LIMIT = 100;
export const REDACTED = '[redacted]';

/** What a call site supplies; `at` is always the store's clock. */
export type AttemptInput = Omit<AttemptRecord, 'at'>;

const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** `Bearer` and anything glued to it, including the bare word: the scheme name alone is enough to invite a paste. */
const BEARER = /Bearer(?:\s+[A-Za-z0-9._~+/=-]+)?/g;
const LONG_BASE64URL_RUN = /[A-Za-z0-9_-]{32,}/g;

/** Pure. Removes addresses, bearer tokens and 32+ character base64url runs, then bounds the length to the contract's 400. */
export function sanitiseAttemptDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  const cleaned = detail.replace(EMAIL_ADDRESS, REDACTED).replace(BEARER, REDACTED).replace(LONG_BASE64URL_RUN, REDACTED);
  return cleaned.length > 400 ? cleaned.slice(0, 400) : cleaned;
}

/** Writes one attempt. Never throws: a record the contract refuses or a write that fails is one console warning with no detail from the cause. */
export async function recordAttempt(store: DynamoStore, input: AttemptInput): Promise<void> {
  let record: AttemptRecord;
  try {
    record = attemptRecordSchema.parse({ ...input, at: store.now(), detail: sanitiseAttemptDetail(input.detail) });
  } catch {
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
  // Newest first whatever order the adapter returned; a fixed clock leaves same-instant rows in key order.
  rows.sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  return rows.filter(row => !input.kind || row.record.kind === input.kind).slice(0, limit).map(row => row.record);
}
