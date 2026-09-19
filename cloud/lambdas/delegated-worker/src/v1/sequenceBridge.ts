import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { attemptReasonSchema } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { dueKey, duePointerSchema } from './dayBuild';

/**
 * STAND-IN FOR SLICE S2. `src/v1/sequence.ts` (SEQ#/DUE#) and `src/v1/suppression.ts` (the SUPPRESS# set) are
 * owned by slice S2 and did not exist on its branch when S3 reached this point. This file is the smallest
 * surface S3 needs from them, written so that the replacement is one import change and nothing else:
 *
 *   - `SequencePort`    what the send fence and the mail poller ask of the sequence: hold a step, record one
 *                       sent, pause for a reply, stop the sequence. S2's `sequence.ts` implements exactly this.
 *   - `SuppressionPort` what they ask of suppression: write the set, read whether a firm or handle is on it.
 *                       S2's `suppression.ts` implements exactly this.
 *
 * The default implementations below write the `SEQ#<firmId>` and `SUPPRESS#` shapes the design names (section 2)
 * and keep the `DUE#<nextDueAt>#<firmId>` pointer beside the sequence in the same transaction. S2 owns the
 * cadence itself (`advanceTerritorySequence`, the start-anchored due rule, wrong-number route retirement,
 * rest and re-entry); nothing here computes a cadence. The send job passes the next step it read from the
 * derived version, so replacing this file changes where that comes from, not what the fence does with it.
 *
 * Nothing here sends, dials or books. Suppression is permanent: there is no unsuppress anywhere in this file.
 */

export const SEQ_PREFIX = 'SEQ#';
export const seqKey = (firmId: string): string => `${SEQ_PREFIX}${keyPart(firmId)}`;

export const heldStepSchema = z.strictObject({ stepId: z.string().min(1).max(200), code: attemptReasonSchema,
  templateId: z.string().min(1).max(40).nullable(), at: accountInstantSchema });
export const sentStepSchema = z.strictObject({ stepId: z.string().min(1).max(200), sentAt: accountInstantSchema });
export const sequenceRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  startedAt: accountInstantSchema,
  currentStepId: z.string().min(1).max(200).nullable(),
  nextDueAt: accountInstantSchema.nullable(),
  entries: z.union([z.literal(1), z.literal(2)]),
  restUntil: accountInstantSchema.nullable(),
  state: z.enum(['active', 'paused', 'stopped']),
  /** Why the sequence is paused or stopped, as a closed code David reads on Today. */
  holdCode: attemptReasonSchema.nullable(),
  heldSteps: z.array(heldStepSchema).max(40),
  sentSteps: z.array(sentStepSchema).max(40),
  /** The enrollment the DUE# pointer names, so S1's pointer schema stays satisfied while the old records are the truth. */
  enrollmentId: z.string().min(1).max(200),
  updatedAt: accountInstantSchema,
});
export type SequenceRecord = z.infer<typeof sequenceRecordSchema>;

export type SequenceSeed = { firmId: string; enrollmentId: string; startedAt: string; currentStepId: string | null; nextDueAt: string | null };
export type NextStep = { stepId: string; dueAt: string } | null;

export interface SequencePort {
  read(firmId: string): Promise<SequenceRecord | null>;
  /** Records one closed hold on one step. Never advances, never sends: the step stays where it is. */
  holdStep(input: SequenceSeed & { stepId: string; code: string; templateId?: string | null }): Promise<void>;
  /** The step went out. Appends it to `sentSteps` and moves the sequence to `next`, writing the DUE# pointer with it. */
  recordSent(input: SequenceSeed & { stepId: string; sentAt: string; next: NextStep }): Promise<void>;
  /** A reply arrived: the sequence waits for David's decision under the `replied` hold. */
  pauseForReply(input: SequenceSeed & { code: string }): Promise<void>;
  /** The firm asked to stop, or a bounce ended the route. Permanent for `opt_out`. */
  stop(input: SequenceSeed & { code: string }): Promise<void>;
}

export const SUPPRESS_PREFIX = 'SUPPRESS#';
export const suppressFirmKey = (firmId: string): string => `${SUPPRESS_PREFIX}FIRM#${keyPart(firmId)}`;
/** Canonical handle keys: a lowercase email address, or a number already in E.164. */
export const suppressHandleKey = (handle: string): string => `${SUPPRESS_PREFIX}${keyPart(handle.trim().toLowerCase())}`;
export const SUPPRESSION_SOURCES = ['call', 'reply', 'manual', 'dnc_evidence'] as const;
export const suppressionRecordSchema = z.strictObject({
  version: z.literal(1), firmId: z.string().min(1).max(200).nullable(), handle: z.string().min(1).max(320).nullable(),
  reason: attemptReasonSchema, source: z.enum(SUPPRESSION_SOURCES), evidenceRef: z.string().max(200).nullable(),
  recordedBy: z.string().min(1).max(80), at: accountInstantSchema,
});
export type SuppressionRecord = z.infer<typeof suppressionRecordSchema>;

export interface SuppressionPort {
  /** Writes the firm item and one item per known handle in a single transaction. Permanent; there is no undo. */
  suppress(input: { firmId: string; handles?: readonly string[]; reason: string; source: SuppressionRecord['source']; evidenceRef?: string | null; recordedBy: string }): Promise<void>;
  isSuppressed(firmId: string, handles?: readonly string[]): Promise<boolean>;
}

/** The stand-in sequence store. Replaced wholesale by S2's `sequence.ts`; the port above is the contract. */
export function createSequencePort(store: DynamoStore): SequencePort {
  const load = async (firmId: string): Promise<{ record: SequenceRecord; rev: number } | null> => {
    const row = await store.get<unknown>(seqKey(firmId));
    if (!row) return null;
    const parsed = sequenceRecordSchema.safeParse(row.data);
    return parsed.success ? { record: parsed.data, rev: row.rev } : null;
  };
  const seeded = (seed: SequenceSeed, now: string): SequenceRecord => sequenceRecordSchema.parse({
    version: 1, firmId: seed.firmId, startedAt: seed.startedAt, currentStepId: seed.currentStepId, nextDueAt: seed.nextDueAt,
    entries: 1, restUntil: null, state: 'active', holdCode: null, heldSteps: [], sentSteps: [], enrollmentId: seed.enrollmentId, updatedAt: now });
  const write = async (seed: SequenceSeed, change: (record: SequenceRecord, now: string) => SequenceRecord, pointer: NextStep = null): Promise<void> => {
    const now = store.now();
    const held = await load(seed.firmId);
    const next = change(held?.record ?? seeded(seed, now), now);
    const items: TransactWriteItem[] = [store.put(seqKey(seed.firmId), sequenceRecordSchema.parse({ ...next, updatedAt: now }), held?.rev ?? null)];
    if (pointer) {
      items.push(store.put(dueKey(pointer.dueAt, seed.firmId), duePointerSchema.parse({ version: 1, firmId: seed.firmId,
        enrollmentId: seed.enrollmentId, stepId: pointer.stepId, nextDueAt: pointer.dueAt, writtenAt: now }), null));
    }
    try { await store.transact(items); }
    catch {
      // The pointer already exists (the same due step, written by an earlier run): the sequence write alone still stands.
      if (!pointer) throw new Error('sequence_write_conflict');
      await store.transact([items[0]!]);
    }
  };
  return {
    async read(firmId: string): Promise<SequenceRecord | null> { return (await load(firmId))?.record ?? null; },
    async holdStep(input): Promise<void> {
      await write(input, (record, now) => ({ ...record,
        heldSteps: [...record.heldSteps.filter(step => step.stepId !== input.stepId),
          { stepId: input.stepId, code: attemptReasonSchema.parse(input.code), templateId: input.templateId ?? null, at: now }].slice(-40) }));
    },
    async recordSent(input): Promise<void> {
      await write(input, record => ({ ...record,
        sentSteps: [...record.sentSteps.filter(step => step.stepId !== input.stepId), { stepId: input.stepId, sentAt: input.sentAt }].slice(-40),
        heldSteps: record.heldSteps.filter(step => step.stepId !== input.stepId),
        currentStepId: input.next?.stepId ?? null, nextDueAt: input.next?.dueAt ?? null,
        state: input.next ? 'active' : 'paused', holdCode: input.next ? null : 'sequence_complete' }), input.next);
    },
    async pauseForReply(input): Promise<void> {
      await write(input, record => ({ ...record, state: 'paused', holdCode: attemptReasonSchema.parse(input.code), nextDueAt: null }));
    },
    async stop(input): Promise<void> {
      await write(input, record => ({ ...record, state: 'stopped', holdCode: attemptReasonSchema.parse(input.code), currentStepId: null, nextDueAt: null }));
    },
  };
}

/** The stand-in suppression set. Replaced wholesale by S2's `suppression.ts`; the port above is the contract. */
export function createSuppressionPort(store: DynamoStore): SuppressionPort {
  return {
    async suppress(input): Promise<void> {
      const at = store.now();
      const base = { version: 1 as const, reason: attemptReasonSchema.parse(input.reason), source: input.source,
        evidenceRef: input.evidenceRef ?? null, recordedBy: input.recordedBy, at };
      const handles = [...new Set((input.handles ?? []).map(handle => handle.trim().toLowerCase()).filter(handle => handle.length > 0))].sort();
      const items: TransactWriteItem[] = [];
      if (!(await store.get<unknown>(suppressFirmKey(input.firmId)))) {
        items.push(store.put(suppressFirmKey(input.firmId), suppressionRecordSchema.parse({ ...base, firmId: input.firmId, handle: null }), null));
      }
      for (const handle of handles) {
        if (await store.get<unknown>(suppressHandleKey(handle))) continue;
        items.push(store.put(suppressHandleKey(handle), suppressionRecordSchema.parse({ ...base, firmId: input.firmId, handle }), null));
      }
      // Every item together or none: a firm is never suppressed without its known routes.
      if (items.length) await store.transact(items);
    },
    async isSuppressed(firmId, handles = []): Promise<boolean> {
      if (await store.get<unknown>(suppressFirmKey(firmId))) return true;
      for (const handle of handles) if (await store.get<unknown>(suppressHandleKey(handle))) return true;
      return false;
    },
  };
}
