import { z } from 'zod';
import { accountIdSchema, accountInstantSchema } from '../../../../src/shared/contracts/accountContract';
import { budgetSchema, type Budget } from './discoveryReservationStore';
import { integer } from './dynamoStore';
import type { ResearchOnceResult } from './researchOnceContract';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ordinal = integer.positive();
const identity = { version: z.literal(2), workspaceId: accountIdSchema, pairingId: z.uuid() };
export const researchCycleReferenceSchema = z.strictObject({ ordinal, admissionFingerprint: hash });
export const researchCyclePredecessorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('legacy'), anchorFingerprint: hash }),
  researchCycleReferenceSchema.extend({ kind: z.literal('cycle') }),
]);
export const researchCycleAdmissionSchema = z.strictObject({ ...identity, kind: z.literal('research.cycle.admit'),
  expectedSourceRevision: integer.positive().max(Number.MAX_SAFE_INTEGER - 1), researchFingerprint: hash, descriptorFingerprint: hash,
  predecessor: researchCyclePredecessorSchema, observationFingerprint: hash,
  expectedDiscoveryBudget: budgetSchema, expectedResearchBudget: budgetSchema, proposedDiscoveryLimitMicros: integer.positive(), disclosureAcknowledged: z.literal(true) });
export const researchCycleStatusSchema = z.strictObject({ ...identity, kind: z.literal('research.cycle.status'), reference: researchCycleReferenceSchema.optional() });
export const researchCycleExecuteSchema = z.strictObject({ ...identity, kind: z.literal('research.cycle.execute'), reference: researchCycleReferenceSchema });
export const researchCycleSchema = z.discriminatedUnion('kind', [researchCycleAdmissionSchema, researchCycleStatusSchema, researchCycleExecuteSchema]);
export const researchCycleObservationSchema = z.strictObject({ key: z.string().min(1).max(300), revision: ordinal.nullable(), fingerprint: hash.nullable() });
export const researchCycleReceiptSchema = z.strictObject({ version: z.literal(2), ordinal, request: researchCycleAdmissionSchema,
  fingerprint: hash, runId: z.uuid(), legacyAnchorFingerprint: hash, expectedExecutionRevision: ordinal,
  observations: z.array(researchCycleObservationSchema).min(1).max(8), deltaMicros: integer, recordedAt: accountInstantSchema });
export const researchCycleHeadSchema = z.strictObject({ version: z.literal(2), workspaceId: accountIdSchema, pairingId: z.uuid(),
  researchFingerprint: hash, legacyAnchorFingerprint: hash, reference: researchCycleReferenceSchema });
export type ResearchCycleReference = z.infer<typeof researchCycleReferenceSchema>;
export type ResearchCyclePredecessor = z.infer<typeof researchCyclePredecessorSchema>;
export type ResearchCycleReceipt = z.infer<typeof researchCycleReceiptSchema>;
export type ResearchCycleAdmission = z.infer<typeof researchCycleAdmissionSchema>;
export type ResearchCycleStatusRequest = z.infer<typeof researchCycleStatusSchema>;
export type ResearchCycleExecuteRequest = z.infer<typeof researchCycleExecuteSchema>;
export type ResearchCycleRequest = z.infer<typeof researchCycleSchema>;
export type ResearchCycleAdmissionResult = { version: 2; kind: 'research.cycle.admit.result'; state: 'held' | 'applied'; receipt: ResearchCycleReceipt | null };
export type ResearchCycleStatusResult = { version: 2; kind: 'research.cycle.status.result'; admissionState: 'not-observed' | 'applied';
  receipt: ResearchCycleReceipt | null; head: ResearchCycleReference | null;
  source: { revision: number; state: 'active' | 'paused'; researchFingerprint: string | null } | null;
  discoveryBudget: Budget | null; researchBudget: Budget | null; descriptorFingerprint: string | null;
  predecessor: ResearchCyclePredecessor | null; observationFingerprint: string | null;
  authorityState: 'ready' | 'paused' | 'superseded' | 'held'; outcome: ResearchOnceResult | null; checkedAt: string; blockers: string[] };
export type ResearchCycleResult = ResearchCycleAdmissionResult | ResearchCycleStatusResult;
export function parseResearchCycle(raw: unknown): ResearchCycleRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 4096) throw Error();
    return researchCycleSchema.parse(raw);
  } catch { throw Error('research_cycle_invalid_request'); }
}
