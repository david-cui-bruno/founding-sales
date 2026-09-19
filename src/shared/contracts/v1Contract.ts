import { z } from 'zod';

/**
 * The `/v1` contract of the rebuilt core (FSS target design, 18 Sep 2026, slice S0).
 *
 * The worker is the single source of truth and the Mac is a thin client holding one device token. This
 * file is the whole shape the client and the worker agree on for S0: the attempt log a device may read,
 * the pairing redeem exchange, and the one command S0 ships. Every schema is strict: an unknown key on
 * either side is a contract break, never a silent pass-through.
 */

const instant = z.iso.datetime({ precision: 3 });
const uuid = z.string().uuid();

/** A closed reason slug: lower-case words joined by underscores, never free text, at most 40 characters. */
export const attemptReasonSchema = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(40);
/**
 * What an attempt was about, as a closed object and never free text, so no address, token, excerpt or provider
 * message can reach a device through the view. `code` is the closed word for the thing tried or the thing that
 * stopped it (a command kind, a hold code, a provider outcome, an error class); the rest are identifiers and counts.
 */
export const attemptDetailSchema = z.strictObject({
  code: attemptReasonSchema,
  firmId: z.string().max(80).optional(),
  jobId: z.string().max(80).optional(),
  commandId: z.string().max(80).optional(),
  providerStatus: z.number().int().optional(),
  providerCode: attemptReasonSchema.optional(),
  count: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  cursor: z.string().max(12).optional(),
});
export type AttemptDetail = z.infer<typeof attemptDetailSchema>;

export const attemptKindSchema = z.enum(['tick', 'tick_phase', 'command', 'events_page', 'send', 'hold', 'research', 'poll', 'pairing']);
export type AttemptKind = z.infer<typeof attemptKindSchema>;
export const attemptOutcomeSchema = z.enum(['ok', 'held', 'failed', 'aborted']);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

/** One thing the worker tried, as the Diagnostics page shows it. Newest first when listed. */
export const attemptRecordSchema = z.strictObject({
  at: instant,
  kind: attemptKindSchema,
  outcome: attemptOutcomeSchema,
  reason: attemptReasonSchema.nullable(),
  detail: attemptDetailSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** What the attempt was about (a command id, a phase name, an account id), never a secret. */
  ref: z.string().max(80).nullable(),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const DIAGNOSTICS_ATTEMPT_LIMIT = 20;

/** One paired device as Diagnostics lists it. The token itself is never part of any view; `expiresAt` is ninety days after pairing. */
export const diagnosticsDeviceSchema = z.strictObject({
  deviceId: uuid,
  label: z.string().min(1).max(80),
  createdAt: instant,
  lastSeenAt: instant.nullable(),
  revokedAt: instant.nullable(),
  expiresAt: instant,
});
export type DiagnosticsDevice = z.infer<typeof diagnosticsDeviceSchema>;

export const diagnosticsViewSchema = z.strictObject({
  asOf: instant,
  attempts: z.array(attemptRecordSchema).max(DIAGNOSTICS_ATTEMPT_LIMIT),
  lastTick: z.strictObject({ at: instant, status: z.enum(['inactive', 'completed', 'aborted']), durationMs: z.number().int().nonnegative() }).nullable(),
  devices: z.array(diagnosticsDeviceSchema),
});
export type DiagnosticsView = z.infer<typeof diagnosticsViewSchema>;

/** The pairing code the operator tool minted, sent once by the fresh client. */
export const pairRedeemRequestSchema = z.strictObject({ code: z.string().min(1).max(128) });
export type PairRedeemRequest = z.infer<typeof pairRedeemRequestSchema>;
/** The device token is returned exactly once, here. The worker keeps only its hash. */
export const pairRedeemResponseSchema = z.strictObject({ deviceToken: z.string().min(1), deviceId: uuid, workspaceId: z.string().min(1) });
export type PairRedeemResponse = z.infer<typeof pairRedeemResponseSchema>;

/** A command id is a UUID v4 the client minted; any other UUID version is refused as a malformed request. */
const commandId = z.uuidv4();
export const revokeDeviceCommandSchema = z.strictObject({ commandId, kind: z.literal('revoke_device'), deviceId: uuid });
/** Every `/v1` command, discriminated on `kind`. S0 ships `revoke_device` only; later slices add theirs here. */
export const v1CommandSchema = z.discriminatedUnion('kind', [revokeDeviceCommandSchema]);
export type V1Command = z.infer<typeof v1CommandSchema>;

/**
 * What one `/v1/commands` request came to. `duplicate` means this commandId was already answered to the same
 * device: the receipt then carries the first answer's reason, or its outcome (`applied`) when the first answer
 * had no reason. The same commandId from another device, or with another payload, is `refused` as `command_conflict`.
 */
export const v1CommandReceiptSchema = z.strictObject({
  commandId,
  outcome: z.enum(['applied', 'duplicate', 'refused']),
  reason: attemptReasonSchema.nullable(),
});
export type V1CommandReceipt = z.infer<typeof v1CommandReceiptSchema>;
