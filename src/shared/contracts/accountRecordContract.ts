import { z } from 'zod';
import { accountClaimSchema, accountInstantSchema, accountRouteSchema, accountSchema, accountSourceSchema } from './accountContract';

/** Canonical account evidence record, not an execution authority or source attestation. */
export const projectionSchema = z.strictObject({ at: accountInstantSchema, account: accountSchema, claims: z.array(accountClaimSchema), routes: z.array(accountRouteSchema) });
export const accountRecordSchema = z.strictObject({ account: accountSchema, history: z.array(projectionSchema).min(1), sources: z.array(accountSourceSchema),
  claims: z.array(accountClaimSchema), routes: z.array(accountRouteSchema), researchRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).positive() });
export type AccountRecord = z.infer<typeof accountRecordSchema>;
