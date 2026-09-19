import { z } from 'zod';
import {
  attemptKindSchema,
  diagnosticsViewSchema,
  settingsViewSchema,
  todayViewSchema,
  v1CommandReceiptSchema,
  v1CommandSchema,
  type SettingsView,
  type TodayView,
} from '../../../src/shared/contracts/v1Contract';

/**
 * What crosses the client's own IPC bridge (`window.callie`), validated on both sides. The worker's shape
 * is the shared `/v1` contract; this file only adds the client's envelopes around it: the pairing state,
 * the honest outcomes of a read or a command (ok, unavailable, unauthenticated, unpaired) and the sentences
 * the renderer shows. No token ever appears in any of these shapes.
 */
const instant = z.iso.datetime({ precision: 3 });
const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(40);

export const CLIENT_CHANNELS = {
  status: 'client:status',
  pair: 'client:pair',
  get: 'client:get',
  command: 'client:command',
  unpair: 'client:unpair',
} as const;

export const clientStatusSchema = z.strictObject({
  state: z.enum(['unpaired', 'paired']),
  /** The worker's https origin (or plain http to the loopback interface, for the stub); null when unconfigured. */
  endpoint: z.string().nullable(),
  endpointSource: z.enum(['environment', 'file', 'none']),
  deviceId: uuid.nullable(),
  workspaceId: z.string().nullable(),
  pairedAt: instant.nullable(),
  /** The plain sentence the Pair page shows after the worker refused the stored token and the client forgot it. */
  notice: z.string().nullable(),
});
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const pairRequestSchema = z.strictObject({ codeOrPath: z.string().min(1).max(4096) });
export type PairRequest = z.infer<typeof pairRequestSchema>;
export const pairResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('paired'), status: clientStatusSchema, codeFileDeleted: z.boolean() }),
  z.strictObject({ outcome: z.literal('refused'), reason: slug, sentence: z.string() }),
  z.strictObject({ outcome: z.literal('unavailable'), reason: slug, sentence: z.string() }),
]);
export type PairResult = z.infer<typeof pairResultSchema>;

export const viewPathSchema = z.enum(['/v1/diagnostics', '/v1/today', '/v1/settings']);
export type ViewPath = z.infer<typeof viewPathSchema>;
export const readRequestSchema = z.strictObject({ view: viewPathSchema, kind: attemptKindSchema.optional() });
export type ReadRequest = z.infer<typeof readRequestSchema>;

const unavailableSchema = z.strictObject({
  outcome: z.literal('unavailable'),
  reason: slug,
  status: z.number().int().nullable(),
  sentence: z.string(),
});
const unauthenticatedSchema = z.strictObject({
  outcome: z.literal('unauthenticated'),
  reason: z.enum(['device_revoked', 'device_expired']).nullable(),
  /** True when the client forgot its token because the worker named the reason; the Pair page follows. */
  cleared: z.boolean(),
  sentence: z.string(),
});
const unpairedSchema = z.strictObject({ outcome: z.literal('unpaired'), sentence: z.string() });

/** Where an ok view came from: the worker just now, or the last good `/v1/today` file this Mac kept when the worker did not answer. */
export const viewSourceSchema = z.enum(['worker', 'last_good']);
export type ViewSource = z.infer<typeof viewSourceSchema>;
export const readResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('ok'), fetchedAt: instant, view: z.unknown(), source: viewSourceSchema.optional(),
    /** For a last-good answer: the sentence of the failed read it stands in for. */
    sentence: z.string().optional() }),
  unavailableSchema,
  unauthenticatedSchema,
  unpairedSchema,
]);
export type ReadResult<View = unknown> =
  | { outcome: 'ok'; fetchedAt: string; view: View; source?: ViewSource; sentence?: string }
  | z.infer<typeof unavailableSchema>
  | z.infer<typeof unauthenticatedSchema>
  | z.infer<typeof unpairedSchema>;

export const commandResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('ok'), receipt: v1CommandReceiptSchema }),
  unavailableSchema,
  unauthenticatedSchema,
  unpairedSchema,
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

/** The Today view is the contract's own schema (slice S1): the four lanes as cards, or `{ list: null, reason }`. */
export { todayViewSchema, type TodayView };
/** The Settings view is the contract's own schema (S1b: postures and reference texts; the rest with S5). */
export { settingsViewSchema, type SettingsView };
export const lastGoodTodaySchema = z.strictObject({ fetchedAt: instant, view: todayViewSchema });
export type LastGoodToday = z.infer<typeof lastGoodTodaySchema>;

/** The view schema for each path the client reads. */
export const viewSchemas = {
  '/v1/diagnostics': diagnosticsViewSchema,
  '/v1/today': todayViewSchema,
  '/v1/settings': settingsViewSchema,
} as const;

export { attemptKindSchema, diagnosticsViewSchema, v1CommandSchema };
export const ATTEMPT_KINDS = attemptKindSchema.options;
