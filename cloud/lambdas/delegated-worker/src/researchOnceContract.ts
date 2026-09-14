import { z } from 'zod';
import { accountIdSchema } from '../../../../src/shared/contracts/accountContract';
const binding = { version: z.literal(1), workspaceId: accountIdSchema, pairingId: z.uuid(),
  expectedSourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), researchFingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
export const researchOnceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...binding, kind: z.literal('research.once') }),
  z.strictObject({ ...binding, kind: z.literal('research.once.status'), runId: z.uuid() }),
]);
export type ResearchOnceRequest = z.infer<typeof researchOnceSchema>;
export type ResearchOnceResult = { version: 1; kind: 'research.once.result'; state: 'held' | 'empty' | 'in-progress' | 'uncertain' | 'completed';
  runId: string | null; jobId: string | null; accountId: string | null; evidenceReceiptId: string | null; settlementReceiptId: string | null; settled: boolean };
export const heldResearchOnce = (): ResearchOnceResult => ({ version: 1, kind: 'research.once.result', state: 'held', runId: null, jobId: null, accountId: null, evidenceReceiptId: null, settlementReceiptId: null, settled: false });
export function parseResearchOnce(raw: unknown): ResearchOnceRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 4096) throw new Error();
    return researchOnceSchema.parse(raw);
  } catch { throw new Error('research_once_invalid_request'); }
}
