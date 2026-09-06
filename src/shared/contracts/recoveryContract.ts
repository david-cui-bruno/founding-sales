import { z } from 'zod';

export const RECOVERY_SESSION_MS = 10 * 60_000;
export const RECOVERY_ERROR = 'RECOVERY_FAILED';
const timestamp = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const sessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const material = z.string().min(1).max(512);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const backupStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), createdAt: timestamp, verifiedAt: timestamp }).strict(),
  z.object({ status: z.enum(['missing', 'unavailable']), createdAt: z.null(), verifiedAt: z.null() }).strict(),
]);
export const recoveryStatusSchema = z.object({
  setupCompletedAt: timestamp.nullable(), lastRestoreDrillAt: timestamp.nullable(),
  outreachReady: z.boolean(), backup: backupStatusSchema,
}).strict().refine((value) => value.outreachReady === (value.setupCompletedAt !== null && value.lastRestoreDrillAt !== null));
export const beginSetupRequestSchema = z.object({ founderConfirmed: z.literal(true) }).strict();
export const saveSetupRequestSchema = z.object({ sessionId }).strict();
export const completeSetupRequestSchema = z.object({ sessionId, founderConfirmed: z.literal(true) }).strict();
export const restoreDrillRequestSchema = z.discriminatedUnion('materialSource', [
  z.object({ founderConfirmed: z.literal(true), materialSource: z.literal('file') }).strict(),
  z.object({ founderConfirmed: z.literal(true), materialSource: z.literal('paste'), recoveryMaterial: material }).strict(),
]);
export const recoverySessionSchema = z.object({ sessionId, material, generatedAt: timestamp }).strict();
const cancelled = z.object({ kind: z.literal('cancelled') }).strict();
export const saveSetupResultSchema = z.discriminatedUnion('kind', [
  cancelled,
  z.object({ kind: z.literal('saved'), backupBasename: z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)) }).strict(),
]);
export const restoreDrillReceiptSchema = z.object({
  backupTimestamp: timestamp, backupSha256: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), verifiedAt: timestamp,
  aggregateCounts: z.object({ people: count, prospects: count, sourceEvents: count }).strict(),
}).strict();
export const restoreDrillResultSchema = z.discriminatedUnion('kind', [cancelled,
  z.object({ kind: z.literal('completed'), receipt: restoreDrillReceiptSchema }).strict(),
]);
export type RecoveryReadinessStatus = z.infer<typeof recoveryStatusSchema>;
export type RecoverySetupSession = z.infer<typeof recoverySessionSchema>;
export type RestoreDrillReceipt = z.infer<typeof restoreDrillReceiptSchema>;
export type RestoreDrillRequest = z.infer<typeof restoreDrillRequestSchema>;
export type RecoveryProvider = {
  status(): Promise<RecoveryReadinessStatus>;
  beginSetup(input: z.infer<typeof beginSetupRequestSchema>): Promise<RecoverySetupSession>;
  saveSetupMaterial(input: z.infer<typeof saveSetupRequestSchema>): Promise<z.infer<typeof saveSetupResultSchema>>;
  completeSetup(input: z.infer<typeof completeSetupRequestSchema>): Promise<RecoveryReadinessStatus>;
  selectAndRunRestoreDrill(input: RestoreDrillRequest): Promise<z.infer<typeof restoreDrillResultSchema>>;
};
