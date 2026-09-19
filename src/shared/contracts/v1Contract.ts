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
/** The four lanes of the morning list (design section 4), in the order the Today page shows them. */
export const TODAY_LANES = ['replies', 'callbacks', 'due', 'new'] as const;
export const todayLaneSchema = z.enum(TODAY_LANES);
export type TodayLane = z.infer<typeof todayLaneSchema>;
/** How many cards each lane holds; the `list` attempt and the LIST_BUILT log line carry exactly this. */
export const laneCountsSchema = z.strictObject({ replies: z.number().int().nonnegative(), callbacks: z.number().int().nonnegative(), due: z.number().int().nonnegative(), new: z.number().int().nonnegative() });
export type LaneCounts = z.infer<typeof laneCountsSchema>;

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
  /** The `list` attempt's counts per lane (S1). */
  lanes: laneCountsSchema.optional(),
});
export type AttemptDetail = z.infer<typeof attemptDetailSchema>;

export const attemptKindSchema = z.enum(['tick', 'tick_phase', 'command', 'events_page', 'send', 'hold', 'research', 'poll', 'pairing', 'list']);
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

/** The user-facing hold reasons (design section 5). The exact closed code travels beside the reason. */
export const V1_HOLD_REASONS = ['paused', 'mailbox_not_connected', 'template_not_approved', 'cap_reached', 'no_email', 'no_phone', 'outside_hours',
  'state_not_cleared', 'suppressed', 'replied', 'evidence_stale', 'provider_error', 'send_unknown', 'budget_exhausted'] as const;
export const v1HoldReasonSchema = z.enum(V1_HOLD_REASONS);
export type V1HoldReason = z.infer<typeof v1HoldReasonSchema>;

/**
 * The Today view (design section 3; slice S1): the four lanes of the day record expanded into call cards. Everything a
 * card says about now (local time, open or closed, dialAllowed and its hold) is computed by the worker at request time
 * from the firm's zone and the code floor window; the Mac never computes it. The addresses and excerpts that derived
 * the state never travel: only the city and the state code do.
 */
const count = z.number().int().nonnegative();
export const todayNextStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('first_call') }),
  z.strictObject({ kind: z.literal('call'), stepIndex: count, stepCount: count, dueAt: instant.nullable() }),
  z.strictObject({ kind: z.literal('reply') }),
  z.strictObject({ kind: z.literal('callback'), dueOn: z.iso.date().nullable() }),
]);
export type TodayNextStep = z.infer<typeof todayNextStepSchema>;
export const todayCardSchema = z.strictObject({
  firmId: z.string().min(1).max(200),
  lane: todayLaneSchema,
  /** Why the firm is in its lane: reply_waiting, callback_due, step_due or new_firm. */
  reason: attemptReasonSchema,
  name: z.string().min(1).max(300),
  /** The number to dial, with the verification word the route carries; null when the firm has no usable phone. */
  phone: z.strictObject({ number: z.string().min(1).max(60), verification: z.enum(['published', 'confirmed', 'unverified', 'listed']) }).nullable(),
  website: z.string().max(253).nullable(),
  city: z.string().max(200).nullable(),
  state: v1StateCodeSchema.nullable(),
  timeZone: z.string().max(64).nullable(),
  /** `HH:MM` on the firm's clock now; null without a zone. */
  localTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** Whether the firm's clock is inside the usual business day (Monday to Friday 09:00 to 17:00): a guess from the zone, not the firm's posted hours. */
  openNow: z.boolean().nullable(),
  dialAllowed: z.boolean(),
  holdReason: v1HoldReasonSchema.nullable(),
  holdCode: attemptReasonSchema.nullable(),
  /** Today's opener: the standing territory policy's offer text. */
  offer: z.string().max(4000).nullable(),
  lastOutcome: z.strictObject({ outcome: attemptReasonSchema, at: instant, note: z.string().max(2000).nullable() }).nullable(),
  nextStep: todayNextStepSchema,
});
export type TodayCard = z.infer<typeof todayCardSchema>;
export const todayHoldCountSchema = z.strictObject({ reason: v1HoldReasonSchema, code: attemptReasonSchema, count: count.min(1) });
export const todayHeaderSchema = z.strictObject({
  date: z.iso.date(),
  builtAt: instant,
  poolSize: count,
  counts: laneCountsSchema,
  /** Firms left out of the new lane under a hold, by reason and closed code, in the order the build checks them. */
  holds: z.array(todayHoldCountSchema),
  /** Every exclusion count of the build, holds included, by closed code. */
  excluded: z.record(attemptReasonSchema, count.min(1)),
  lastTick: lastTickLineSchema.nullable(),
  postures: z.array(statePostureSummarySchema),
  /** States the firms derive to for which no posture has been recorded; the Today page warns about these. */
  statesWithoutPosture: z.array(v1StateCodeSchema),
});
export type TodayHeader = z.infer<typeof todayHeaderSchema>;
const cards = z.array(todayCardSchema);
export const todayListSchema = z.strictObject({ header: todayHeaderSchema, lanes: z.strictObject({ replies: cards, callbacks: cards, due: cards, new: cards }) });
export type TodayList = z.infer<typeof todayListSchema>;
export const todayEmptyReasonSchema = z.enum(['not_built_yet', 'no_posture', 'no_candidates']);
export type TodayEmptyReason = z.infer<typeof todayEmptyReasonSchema>;
export const todayViewSchema = z.union([
  z.strictObject({ asOf: instant, list: todayListSchema }),
  z.strictObject({ asOf: instant, list: z.null(), reason: todayEmptyReasonSchema, postures: z.array(statePostureSummarySchema), statesWithoutPosture: z.array(v1StateCodeSchema) }),
]);
export type TodayView = z.infer<typeof todayViewSchema>;

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
