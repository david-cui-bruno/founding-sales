import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import type { FirmCard } from './firms';

/**
 * The morning list's storage (FSS target design sections 2 and 4; slice S1): `DUE#<nextDueAt>#<firmId>` pointers the
 * due lane reads as one range instead of a scan, and `DAY#<yyyy-mm-dd>` (item 4). Until S3 writes the pointer beside
 * the sequence in one transaction, `backfillDuePointers` maintains it from the enrollment records on read: one pointer
 * per active enrollment with a due instant, put only when absent. A pointer is a hint, never the truth: the range read
 * checks every pointer against the enrollment it names and skips one the sequence has moved past. Nothing is deleted
 * (the worker's role has no DeleteItem); a stale pointer simply stops matching.
 */

export const DUE_PREFIX = 'DUE#';
/** The end of the DUE# range up to and including a due instant: `~` sorts after the `#` that precedes the firm id. */
export const dueRangeEnd = (until: string): string => `${DUE_PREFIX}${accountInstantSchema.parse(until)}~`;
export const dueKey = (nextDueAt: string, firmId: string): string => `${DUE_PREFIX}${accountInstantSchema.parse(nextDueAt)}#${keyPart(firmId)}`;
export const duePointerSchema = z.strictObject({ version: z.literal(1), firmId: z.string().min(1), enrollmentId: z.string().min(1), stepId: z.string().min(1),
  nextDueAt: accountInstantSchema, writtenAt: accountInstantSchema });
export type DuePointer = z.infer<typeof duePointerSchema>;
/** Dynamo allows 100 items per transaction; the backfill writes the pointers in batches of this size. */
const POINTER_BATCH = 100;

/** The pointer an enrollment should have now, or null for a firm with no due instant (not enrolled, resting, stopped, completed). */
export function expectedDuePointer(firm: FirmCard, writtenAt: string): DuePointer | null {
  const enrollment = firm.enrollment;
  if (!enrollment || enrollment.state !== 'active' || !enrollment.nextDueAt || !enrollment.currentStepId) return null;
  return { version: 1, firmId: firm.firmId, enrollmentId: enrollment.enrollmentId, stepId: enrollment.currentStepId, nextDueAt: enrollment.nextDueAt, writtenAt };
}

/** Put every missing pointer, absent-fenced, in batches; a batch a concurrent writer beat is left to it. Counts only. */
export async function backfillDuePointers(store: DynamoStore, firms: readonly FirmCard[]): Promise<{ written: number; present: number }> {
  const existing = new Set((await store.list<unknown>(DUE_PREFIX)).map(row => row.key));
  const now = store.now();
  const missing: DuePointer[] = []; let present = 0;
  for (const firm of firms) {
    const pointer = expectedDuePointer(firm, now);
    if (!pointer) continue;
    if (existing.has(dueKey(pointer.nextDueAt, pointer.firmId))) present++; else missing.push(pointer);
  }
  let written = 0;
  for (let index = 0; index < missing.length; index += POINTER_BATCH) {
    const batch = missing.slice(index, index + POINTER_BATCH);
    try { await store.transact(batch.map(pointer => store.put(dueKey(pointer.nextDueAt, pointer.firmId), pointer, null))); written += batch.length; }
    catch { /* Another tick wrote some of these first; the next backfill sees them as present. */ }
  }
  return { written, present };
}

/**
 * Every pointer due at or before `until`, ascending, verified against the enrollment the firm carries now: the firm must
 * still be enrolled on that enrollment, standing on that step, due at that instant. Anything else is stale and skipped.
 */
export async function readDuePointers(store: DynamoStore, firms: readonly FirmCard[], until: string): Promise<DuePointer[]> {
  const byFirm = new Map(firms.map(firm => [firm.firmId, firm]));
  const result = await store.options.dynamo.send(new QueryCommand({ TableName: store.options.tableName, ConsistentRead: true,
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    ExpressionAttributeValues: { ':pk': store.key('').pk, ':from': { S: DUE_PREFIX }, ':to': { S: dueRangeEnd(until) } }, ScanIndexForward: true }));
  const pointers: DuePointer[] = [];
  for (const item of result.Items ?? []) {
    if (typeof item.data?.S !== 'string') continue;
    let raw: unknown;
    try { raw = JSON.parse(item.data.S); } catch { continue; }
    const parsed = duePointerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.nextDueAt > until) continue;
    const pointer = parsed.data;
    const firm = byFirm.get(pointer.firmId);
    const live = firm ? expectedDuePointer(firm, pointer.writtenAt) : null;
    if (!live || live.enrollmentId !== pointer.enrollmentId || live.stepId !== pointer.stepId || live.nextDueAt !== pointer.nextDueAt) continue;
    pointers.push(pointer);
  }
  return pointers.sort((a, b) => a.nextDueAt < b.nextDueAt ? -1 : a.nextDueAt > b.nextDueAt ? 1 : a.firmId < b.firmId ? -1 : 1);
}
