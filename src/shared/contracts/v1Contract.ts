import { z } from 'zod';
import { US_STATE_CODES } from './territoryClearanceContract';

/**
 * The `/v1` contract of the rebuilt core (FSS target design, 18 Sep 2026, slices S0 and S1).
 *
 * The worker is the single source of truth and the Mac is a thin client holding one device token. This
 * file is the whole shape the client and the worker agree on: the attempt log a device may read, the
 * pairing redeem exchange, the commands, the per-state posture (S1) and the Today view (S1). Every schema
 * is strict: an unknown key on either side is a contract break, never a silent pass-through.
 */

const instant = z.iso.datetime({ precision: 3 });
const uuid = z.string().uuid();
/** A device label as Diagnostics shows it: printable, at most 80 characters. */
const deviceLabel = z.string().min(1).max(80);

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

/** The last scheduled tick as a view reads it off the persisted tick record: when, how it ended, how long. */
export const lastTickLineSchema = z.strictObject({ at: instant, status: z.enum(['inactive', 'completed', 'aborted']), durationMs: z.number().int().nonnegative() });
export type LastTickLine = z.infer<typeof lastTickLineSchema>;

/**
 * David's calling posture per state (design section 2, `STATE#<ST>`; slice S1). His decision, not a checkbox: the
 * registration and do-not-call status he checked, each with the citation he read (at most 400 characters), the
 * counsel he consulted if any, and the revision of the clearance reference text that stood beside the control. The
 * worker stamps `decidedAt` and `decidedBy` (the device label) and sets `reviewAt` twelve months on; every prior
 * decision for the state is appended, whole, to `history`. A posture is never seeded: absent means no decision.
 */
export const v1StateCodeSchema = z.enum(US_STATE_CODES);
export type V1StateCode = z.infer<typeof v1StateCodeSchema>;
export const statePostureSchema = z.enum(['calling', 'not_calling']);
export type StatePosture = z.infer<typeof statePostureSchema>;
export const STATE_POSTURE_CITATION_MAX = 400;
const citation = z.string().max(STATE_POSTURE_CITATION_MAX);
export const stateRegistrationSchema = z.strictObject({ status: z.enum(['registered', 'exempt', 'none_required', 'unknown']), citation });
export const stateDncListSchema = z.strictObject({ status: z.enum(['subscribed', 'not_required', 'unknown']), citation });
export const stateCounselSchema = z.strictObject({ name: z.string().min(1).max(120), date: z.iso.date(), memoRef: z.string().max(200) });
/** What David decides for one state; the device sends exactly this inside `set_state_posture`. */
const statePostureDecisionShape = {
  posture: statePostureSchema,
  registration: stateRegistrationSchema,
  dncList: stateDncListSchema,
  counsel: stateCounselSchema.optional(),
  /** `TERRITORY_RULES_REVISION` of the clearance statements shown beside the control when the decision was made. */
  referenceTextRevision: z.number().int().positive(),
};
/** One decision as stored: the decision plus the worker's stamps. History entries are exactly this shape. */
const statePostureEntryShape = { ...statePostureDecisionShape, state: v1StateCodeSchema, decidedAt: instant, decidedBy: deviceLabel, reviewAt: instant };
export const statePostureEntrySchema = z.strictObject(statePostureEntryShape);
export type StatePostureEntry = z.infer<typeof statePostureEntrySchema>;
export const statePostureRecordSchema = z.strictObject({ ...statePostureEntryShape, history: z.array(statePostureEntrySchema).max(200) });
export type StatePostureRecord = z.infer<typeof statePostureRecordSchema>;
/** The posture as the Today header and Diagnostics show it: no citations, just the decision and whether its review is overdue. */
export const statePostureSummarySchema = z.strictObject({ state: v1StateCodeSchema, posture: statePostureSchema, decidedAt: instant, decidedBy: deviceLabel, reviewAt: instant, reviewOverdue: z.boolean() });
export type StatePostureSummary = z.infer<typeof statePostureSummarySchema>;

export const diagnosticsViewSchema = z.strictObject({
  asOf: instant,
  attempts: z.array(attemptRecordSchema).max(DIAGNOSTICS_ATTEMPT_LIMIT),
  lastTick: lastTickLineSchema.nullable(),
  devices: z.array(diagnosticsDeviceSchema),
  /** Postures by state, until Settings ships in S5. Optional so a client built against the S0 shape still validates. */
  postures: z.array(statePostureSummarySchema).optional(),
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
/** Record David's calling posture for one state (S1). The worker stamps the instant and the device; the decision is his. */
export const setStatePostureCommandSchema = z.strictObject({ commandId, kind: z.literal('set_state_posture'), state: v1StateCodeSchema, ...statePostureDecisionShape });
export type SetStatePostureCommand = z.infer<typeof setStatePostureCommandSchema>;
/** Every `/v1` command, discriminated on `kind`. S0 ships `revoke_device`, S1 adds `set_state_posture`; later slices add theirs here. */
export const v1CommandSchema = z.discriminatedUnion('kind', [revokeDeviceCommandSchema, setStatePostureCommandSchema]);
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
