import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { phoneSetupViewSchema, type ConfirmPhoneSetupCommand, type PausedView, type PhoneSetupView } from '../../../../../src/shared/contracts/v1Contract';
import { pausedViewSchema } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { PAUSED_SETTINGS_KEY } from './templates';

/**
 * `SETTINGS#phone` and `SETTINGS#paused` (FSS target design section 2; slice S5).
 *
 * Phone setup. The Phone.app handoff needs a local proof file on the Mac, written and read by the old app's
 * `PhoneRouteSettings` and carried into the thin client by `client/src/main/phone.ts`. That file never leaves the
 * Mac. What the worker keeps is David's statement that he confirmed the setup and the sha256 of the proof he
 * confirmed, so Settings on any device can say whether a Mac is set up and which proof it was. The record is
 * never a permission: the dial gate is the local proof and the launcher's own checks, not this row.
 *
 * Paused. One row saying whether every send and poll is stopped and why. The send fence reads it (S3's
 * `readPaused`) and holds with `paused`; Settings shows the reason as a banner on every page. Pausing is a
 * decision David makes, so the row carries who made it and when, and resuming clears the reason rather than
 * keeping a stale sentence beside a running system.
 */

export const PHONE_SETUP_KEY = 'SETTINGS#phone';
/** The same key S3's send fence reads. Re-exported so a reader of this module sees both settings in one place. */
export { PAUSED_SETTINGS_KEY };

export const phoneSetupRecordSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(['confirmed', 'cleared']),
  confirmedAt: accountInstantSchema.nullable(),
  /** The sha256 of the local proof's fingerprint. Never the proof, never a path, never a number. */
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  confirmedBy: z.string().min(1).max(80).nullable(),
  revision: z.number().int().positive(),
  updatedAt: accountInstantSchema,
});
export type PhoneSetupRecord = z.infer<typeof phoneSetupRecordSchema>;

export async function readPhoneSetup(store: DynamoStore): Promise<{ record: PhoneSetupRecord | null; rev: number | null }> {
  const row = await store.get<unknown>(PHONE_SETUP_KEY);
  if (!row) return { record: null, rev: null };
  const parsed = phoneSetupRecordSchema.safeParse(row.data);
  return { record: parsed.success ? parsed.data : null, rev: row.rev };
}

/** No record is `cleared` with nothing beside it: the honest reading of a workspace where nobody has confirmed yet. */
export function phoneSetupView(record: PhoneSetupRecord | null): PhoneSetupView {
  return phoneSetupViewSchema.parse({
    status: record?.status ?? 'cleared',
    confirmedAt: record?.confirmedAt ?? null,
    proofDigest: record?.proofDigest ?? null,
    confirmedBy: record?.confirmedBy ?? null,
    revision: record?.revision ?? 0,
    updatedAt: record?.updatedAt ?? null,
  });
}

/** The fenced put for `confirm_phone_setup`: David's statement plus the digest of the proof he confirmed. */
export async function planConfirmPhoneSetup(store: DynamoStore, command: ConfirmPhoneSetupCommand, confirmedBy: string):
Promise<{ item: TransactWriteItem; record: PhoneSetupRecord }> {
  const held = await readPhoneSetup(store);
  const now = store.now();
  const record = phoneSetupRecordSchema.parse({ version: 1, status: 'confirmed', confirmedAt: now, proofDigest: command.proofDigest,
    confirmedBy, revision: (held.record?.revision ?? 0) + 1, updatedAt: now });
  return { item: store.put(PHONE_SETUP_KEY, record, held.rev), record };
}

/** The fenced put for `clear_phone_setup`. Clearing keeps no digest: there is nothing left that was confirmed. */
export async function planClearPhoneSetup(store: DynamoStore): Promise<{ item: TransactWriteItem; record: PhoneSetupRecord }> {
  const held = await readPhoneSetup(store);
  const now = store.now();
  const record = phoneSetupRecordSchema.parse({ version: 1, status: 'cleared', confirmedAt: null, proofDigest: null,
    confirmedBy: null, revision: (held.record?.revision ?? 0) + 1, updatedAt: now });
  return { item: store.put(PHONE_SETUP_KEY, record, held.rev), record };
}

/**
 * `SETTINGS#paused`. The stored shape is a superset of what S3's `readPaused` parses (`paused` and `reason`), so
 * the send fence keeps reading this row unchanged while Settings gets the stamps it shows.
 */
export const pausedRecordSchema = z.strictObject({
  version: z.literal(1),
  paused: z.boolean(),
  reason: z.string().max(200).nullable(),
  at: accountInstantSchema,
  by: z.string().min(1).max(80),
  revision: z.number().int().positive(),
});
export type PausedRecord = z.infer<typeof pausedRecordSchema>;

export type PausedReading = { record: PausedRecord | null; rev: number | null; unreadable: boolean };
export async function readPausedRecord(store: DynamoStore): Promise<PausedReading> {
  const row = await store.get<unknown>(PAUSED_SETTINGS_KEY);
  if (!row) return { record: null, rev: null, unreadable: false };
  const parsed = pausedRecordSchema.safeParse(row.data);
  return { record: parsed.success ? parsed.data : null, rev: row.rev, unreadable: !parsed.success };
}

/**
 * No record means not paused. A record this schema refuses is read as paused, with the same closed reason S3's
 * `readPaused` gives the send fence, so Settings and the fence never disagree about whether anything may go out.
 */
export function pausedView(reading: PausedReading): PausedView {
  if (reading.unreadable) return pausedViewSchema.parse({ paused: true, reason: 'paused_record_unreadable', at: null, by: null, revision: 0 });
  const record = reading.record;
  return pausedViewSchema.parse({
    paused: record?.paused ?? false,
    reason: record?.reason ?? null,
    at: record?.at ?? null,
    by: record?.by ?? null,
    revision: record?.revision ?? 0,
  });
}

/** The fenced put for `pause` and `resume`. A resume clears the reason: `{ paused: false, reason: null }`. */
export async function planSetPaused(store: DynamoStore, input: { paused: boolean; reason: string | null; by: string }):
Promise<{ item: TransactWriteItem; record: PausedRecord }> {
  const held = await readPausedRecord(store);
  const record = pausedRecordSchema.parse({ version: 1, paused: input.paused, reason: input.paused ? input.reason : null,
    at: store.now(), by: input.by, revision: (held.record?.revision ?? 0) + 1 });
  return { item: store.put(PAUSED_SETTINGS_KEY, record, held.rev), record };
}
