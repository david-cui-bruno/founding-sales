import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { normalizeEmail, normalizePhone } from '../../../../../src/main/domain/source/contactNormalization';
import { v1SuppressionSourceSchema, type V1FirmSuppression, type V1SuppressionSource } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { mailSuppressionKey } from '../threadIntakeRepository';

/**
 * The suppression set (FSS target design section 2, `SUPPRESS#FIRM#<firmId>` and `SUPPRESS#<handle>`; slice S2). One
 * firm-level record plus one record per known route, written in a single transaction, so a firm and every way of
 * reaching it stop together or not at all. Permanent by construction: the first record for a key stands and is never
 * overwritten, and this module exposes no unsuppress — neither does any command, view or client path in the design.
 *
 * Canonical keys and nothing else: a phone as E.164 through the shared normalizer, an address lower-cased through the
 * same, and a handle neither normalizer accepts is refused rather than stored in whatever shape it arrived in. Keys
 * are `encodeURIComponent`d exactly like every other sort key, so `+1` and `@` cannot make a second spelling.
 *
 * The old `MAIL_SUPPRESSION#<firmId>` row is written beside the new set while the two cores coexist. Until S3 the old
 * worker still polls and sends, and that row is the fence its reply-draft and dispatch paths already check; writing it
 * is how an opt-out taken on the phone today stops a mail tomorrow. The new set is the truth, the old row is the carry.
 */

export const SUPPRESS_PREFIX = 'SUPPRESS#';
export const SUPPRESS_FIRM_PREFIX = 'SUPPRESS#FIRM#';
export const suppressionFirmKey = (firmId: string): string => `${SUPPRESS_FIRM_PREFIX}${keyPart(firmId)}`;
/** The handle must already be canonical: `canonicalHandle` is the only thing that makes one. */
export const suppressionHandleKey = (handle: string): string => `${SUPPRESS_PREFIX}${keyPart(handle)}`;

const instant = accountInstantSchema;
export const SUPPRESSION_REASON_MAX = 400;
export const suppressionFirmRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(SUPPRESSION_REASON_MAX),
  source: v1SuppressionSourceSchema,
  /** What proves it: the call record, the reply record, the research source. Null when David simply said so. */
  evidenceRef: z.string().max(200).nullable(),
  /** The device label that recorded it. */
  recordedBy: z.string().min(1).max(80),
  at: instant,
  /** Every canonical handle suppressed with the firm, in the order they were written. */
  handles: z.array(z.string().min(1).max(254)).max(100),
});
export type SuppressionFirmRecord = z.infer<typeof suppressionFirmRecordSchema>;
export const suppressionHandleRecordSchema = z.strictObject({
  version: z.literal(1),
  handle: z.string().min(1).max(254),
  channel: z.enum(['phone', 'email']),
  /** The firm the handle was reached through, or null for a handle suppressed on its own. */
  firmId: z.string().min(1).max(200).nullable(),
  reason: z.string().trim().min(1).max(SUPPRESSION_REASON_MAX),
  source: v1SuppressionSourceSchema,
  evidenceRef: z.string().max(200).nullable(),
  recordedBy: z.string().min(1).max(80),
  at: instant,
});
export type SuppressionHandleRecord = z.infer<typeof suppressionHandleRecordSchema>;

export type CanonicalHandle = { channel: 'phone'; handle: string } | { channel: 'email'; handle: string };
/**
 * One handle in the only spelling the suppression set stores: a phone as E.164 under the United States default
 * region, an address lower-cased and validated. Anything neither normalizer accepts is null, never a stored guess.
 * Pure.
 */
export function canonicalHandle(value: string): CanonicalHandle | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return null;
  if (raw.includes('@')) {
    try { return { channel: 'email', handle: normalizeEmail(raw) }; } catch { return null; }
  }
  try { return { channel: 'phone', handle: normalizePhone(raw) }; } catch { return null; }
}

/** Every route of one firm as a canonical handle, de-duplicated, in a stable order. Pure. */
export function canonicalRoutes(routes: readonly { channel: string; value: string }[]): CanonicalHandle[] {
  const seen = new Map<string, CanonicalHandle>();
  for (const route of routes) {
    if (route.channel !== 'phone' && route.channel !== 'email') continue;
    const canonical = canonicalHandle(route.value);
    if (canonical && canonical.channel === route.channel && !seen.has(canonical.handle)) seen.set(canonical.handle, canonical);
  }
  return [...seen.values()].sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);
}

export async function readFirmSuppression(store: DynamoStore, firmId: string): Promise<SuppressionFirmRecord | null> {
  const row = await store.get<unknown>(suppressionFirmKey(firmId));
  if (!row) return null;
  const parsed = suppressionFirmRecordSchema.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

export async function readHandleSuppression(store: DynamoStore, handle: string): Promise<SuppressionHandleRecord | null> {
  const canonical = canonicalHandle(handle);
  if (!canonical) return null;
  const row = await store.get<unknown>(suppressionHandleKey(canonical.handle));
  if (!row) return null;
  const parsed = suppressionHandleRecordSchema.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

/** Every suppressed firm id, for the list build's exclusion. One prefix query. */
export async function listSuppressedFirmIds(store: DynamoStore): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const row of await store.list<unknown>(SUPPRESS_FIRM_PREFIX)) {
    const parsed = suppressionFirmRecordSchema.safeParse(row.stored.data);
    if (parsed.success) ids.add(parsed.data.firmId);
  }
  return ids;
}

/** Whether this firm, or any of these routes, is suppressed. Both sides are checked; either one is a yes. */
export async function isSuppressed(store: DynamoStore, firmId: string | null, routes: readonly { channel: string; value: string }[] = []): Promise<boolean> {
  if (firmId !== null && await readFirmSuppression(store, firmId) !== null) return true;
  for (const handle of canonicalRoutes(routes)) if (await readHandleSuppression(store, handle.handle) !== null) return true;
  return false;
}

export type SuppressInput = {
  firmId?: string | null;
  /** One handle to suppress on its own, or beside the firm. */
  handle?: string | null;
  routes?: readonly { channel: string; value: string }[];
  reason: string;
  source: V1SuppressionSource;
  evidenceRef?: string | null;
  recordedBy: string;
};
export type SuppressPlan =
  | { outcome: 'planned'; items: TransactWriteItem[]; record: SuppressionFirmRecord | null; handles: CanonicalHandle[] }
  | { outcome: 'already'; items: TransactWriteItem[]; record: SuppressionFirmRecord | null; handles: CanonicalHandle[] }
  | { outcome: 'refused'; reason: 'no_subject' | 'handle_invalid' };

/**
 * The writes of one suppression, for the caller's own transaction: the firm record, one record per known route, the
 * handle named on its own if there is one, and the carried `MAIL_SUPPRESSION#` row. A key already suppressed is left
 * exactly as it was — the first reason and the first source are the record — and is proved unchanged with a condition
 * check instead, so a second opt-out is idempotent rather than a rewrite of history.
 */
export async function planSuppress(store: DynamoStore, input: SuppressInput): Promise<SuppressPlan> {
  const firmId = input.firmId ?? null;
  const named = input.handle ? canonicalHandle(input.handle) : null;
  if (input.handle && !named) return { outcome: 'refused', reason: 'handle_invalid' };
  if (firmId === null && named === null) return { outcome: 'refused', reason: 'no_subject' };
  const at = store.now();
  const reason = z.string().trim().min(1).max(SUPPRESSION_REASON_MAX).parse(input.reason);
  const source = v1SuppressionSourceSchema.parse(input.source);
  const evidenceRef = input.evidenceRef ?? null;
  const recordedBy = z.string().min(1).max(80).parse(input.recordedBy);

  const handles = canonicalRoutes(input.routes ?? []);
  if (named && !handles.some(candidate => candidate.handle === named.handle)) handles.push(named);
  const items: TransactWriteItem[] = [];
  let already = true;
  let record: SuppressionFirmRecord | null = null;

  if (firmId !== null) {
    const key = suppressionFirmKey(firmId);
    const existing = await store.get<unknown>(key);
    const parsed = existing ? suppressionFirmRecordSchema.safeParse(existing.data) : null;
    if (existing && parsed?.success) { record = parsed.data; items.push(store.check(key, existing.rev)); }
    else {
      record = suppressionFirmRecordSchema.parse({ version: 1, firmId, reason, source, evidenceRef, recordedBy, at, handles: handles.map(entry => entry.handle) });
      items.push(store.put(key, record, existing?.rev ?? null));
      already = false;
    }
    // The carried fence the old worker's mail paths already check, while the two cores coexist (retired at S7).
    const mailKey = mailSuppressionKey(firmId);
    const mail = await store.get<unknown>(mailKey);
    if (mail) items.push(store.check(mailKey, mail.rev));
    else { items.push(store.put(mailKey, { accountId: firmId, observedAt: at, evidence: [] }, null)); already = false; }
  }

  for (const handle of handles) {
    const key = suppressionHandleKey(handle.handle);
    const existing = await store.get<unknown>(key);
    if (existing) { items.push(store.check(key, existing.rev)); continue; }
    items.push(store.put(key, suppressionHandleRecordSchema.parse({ version: 1, handle: handle.handle, channel: handle.channel,
      firmId, reason, source, evidenceRef, recordedBy, at }), null));
    already = false;
  }
  return { outcome: already ? 'already' : 'planned', items, record, handles };
}

/** The firm's suppression as the Firm view reports it. */
export function firmSuppressionView(record: SuppressionFirmRecord | null): V1FirmSuppression | null {
  if (!record) return null;
  return { reason: record.reason, source: record.source, evidenceRef: record.evidenceRef, recordedBy: record.recordedBy, at: record.at, handles: record.handles };
}
