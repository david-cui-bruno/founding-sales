import { z } from 'zod';
import { budgetSchema } from './discoveryReservationStore';
import { accountInstantSchema, accountIdSchema } from '../../../../src/shared/contracts/accountContract';
const binding = { version: z.literal(1), workspaceId: accountIdSchema, pairingId: z.uuid(),
  expectedSourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), researchFingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
const fingerprintSchema = binding.researchFingerprint;
const nextIdentity = { version: z.literal(1), workspaceId: accountIdSchema, pairingId: z.uuid(), parentRunId: z.uuid(), parentSourceRevision: z.literal(1), researchFingerprint: fingerprintSchema };
export const researchOnceNextAdmissionSchema = z.strictObject({ ...nextIdentity, kind: z.literal('research.once.admit-next'), expectedSourceRevision: z.literal(2),
  descriptorFingerprint: fingerprintSchema, expectedDiscoveryBudget: budgetSchema, expectedResearchBudget: budgetSchema, proposedDiscoveryLimitMicros: binding.expectedSourceRevision });
const nextStatusSchema = z.strictObject({ ...nextIdentity, kind: z.literal('research.once.admit-next.status'), admissionFingerprint: fingerprintSchema });
export const researchOnceNextReceiptSchema = z.strictObject({ version: z.literal(1), request: researchOnceNextAdmissionSchema, fingerprint: fingerprintSchema,
  successorRunId: z.uuid(), expectedExecutionRevision: z.literal(3), parentRevision: binding.expectedSourceRevision, parentFingerprint: fingerprintSchema,
  deltaMicros: binding.expectedSourceRevision, recordedAt: accountInstantSchema });
export type ResearchOnceNextReceipt = z.infer<typeof researchOnceNextReceiptSchema>;
export type ResearchOnceNextRequest = z.infer<typeof researchOnceNextAdmissionSchema> | z.infer<typeof nextStatusSchema>;
export type ResearchOnceNextResult = { version: 1; kind: 'research.once.admit-next.result'; state: 'held' | 'not-observed' | 'applied'; receipt: ResearchOnceNextReceipt | null };
export const researchOnceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...binding, kind: z.literal('research.once'), successor: z.strictObject({ parentRunId: z.uuid(), admissionFingerprint: fingerprintSchema }).optional() }),
  z.strictObject({ ...binding, kind: z.literal('research.once.status'), runId: z.uuid() }),
  researchOnceNextAdmissionSchema, nextStatusSchema,
]);
export type ResearchOnceNativeRequest = z.infer<typeof researchOnceSchema>;
export type ResearchOnceRequest = Exclude<ResearchOnceNativeRequest, ResearchOnceNextRequest>;
export type ResearchOnceResult = { version: 1; kind: 'research.once.result'; state: 'held' | 'empty' | 'in-progress' | 'uncertain' | 'completed';
  runId: string | null; jobId: string | null; accountId: string | null; evidenceReceiptId: string | null; settlementReceiptId: string | null; settled: boolean };
export const heldResearchOnce = (): ResearchOnceResult => ({ version: 1, kind: 'research.once.result', state: 'held', runId: null, jobId: null, accountId: null, evidenceReceiptId: null, settlementReceiptId: null, settled: false });
export function parseResearchOnce(raw: unknown): ResearchOnceNativeRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 4096) throw new Error();
    return researchOnceSchema.parse(raw);
  } catch { throw new Error('research_once_invalid_request'); }
}
