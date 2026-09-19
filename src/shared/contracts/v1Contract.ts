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
/** Human-readable detail. The worker sanitises it before storage (no addresses, bearer tokens or long secrets). */
export const attemptDetailSchema = z.string().max(400);

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

/** One paired device as Diagnostics lists it. The token itself is never part of any view. */
export const diagnosticsDeviceSchema = z.strictObject({
  deviceId: uuid,
  label: z.string().min(1).max(80),
  createdAt: instant,
  lastSeenAt: instant.nullable(),
  revokedAt: instant.nullable(),
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

export const revokeDeviceCommandSchema = z.strictObject({ commandId: uuid, kind: z.literal('revoke_device'), deviceId: uuid });
/** Every `/v1` command, discriminated on `kind`. S0 ships `revoke_device` only; later slices add theirs here. */
export const v1CommandSchema = z.discriminatedUnion('kind', [revokeDeviceCommandSchema]);
export type V1Command = z.infer<typeof v1CommandSchema>;

/**
 * What one `/v1/commands` request came to. `duplicate` means this commandId was already answered: the receipt
 * then carries the first answer's reason, or its outcome (`applied`) when the first answer had no reason.
 */
export const v1CommandReceiptSchema = z.strictObject({
  commandId: uuid,
  outcome: z.enum(['applied', 'duplicate', 'refused']),
  reason: attemptReasonSchema.nullable(),
});
export type V1CommandReceipt = z.infer<typeof v1CommandReceiptSchema>;
