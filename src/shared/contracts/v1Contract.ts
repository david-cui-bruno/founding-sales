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
/**
 * One earlier decision, as Settings shows it under the current posture (S5). Every posture David has ever recorded
 * for a state is kept on the record, and Settings is where he reads them back: what he decided, when, and on which
 * device. The citations he typed stay on the record and never travel in a view, here or anywhere else.
 */
export const statePostureHistoryEntrySchema = z.strictObject({ posture: statePostureSchema, decidedAt: instant, decidedBy: deviceLabel, reviewAt: instant,
  registrationStatus: stateRegistrationSchema.shape.status, dncStatus: stateDncListSchema.shape.status,
  /** Whether counsel was named on that decision. The name, date and memo reference stay on the record. */
  counsel: z.boolean(), referenceTextRevision: z.number().int().positive() });
export type StatePostureHistoryEntry = z.infer<typeof statePostureHistoryEntrySchema>;

/** The user-facing hold reasons (design section 5). The exact closed code travels beside the reason. */
export const V1_HOLD_REASONS = ['paused', 'mailbox_not_connected', 'template_not_approved', 'cap_reached', 'no_email', 'no_phone', 'outside_hours',
  'state_not_cleared', 'suppressed', 'replied', 'evidence_stale', 'provider_error', 'send_unknown', 'budget_exhausted'] as const;
export const v1HoldReasonSchema = z.enum(V1_HOLD_REASONS);
export type V1HoldReason = z.infer<typeof v1HoldReasonSchema>;

/**
 * The ten outcomes of one dialed call (design section 3, `log_call_outcome`; slice S2). Closed: David picks one
 * button on the outcome form and the worker decides everything that follows from it. `opt_out` and a `neverCall`
 * reason are the two that suppress, permanently; `wrong_number` retires the route it was dialed on.
 */
export const V1_CALL_OUTCOMES = ['answered_interested', 'answered_not_interested', 'gatekeeper', 'voicemail', 'no_answer', 'busy',
  'wrong_number', 'requested_info', 'callback', 'opt_out'] as const;
export const v1CallOutcomeSchema = z.enum(V1_CALL_OUTCOMES);
export type V1CallOutcome = z.infer<typeof v1CallOutcomeSchema>;
export const CALL_NOTE_MAX = 2000;
/** What David typed about the call. Never a decision: the outcome word is what the worker acts on. */
const callNote = z.string().max(CALL_NOTE_MAX);
/** Why this firm is never called again. David's words, kept whole on the suppression record. */
export const NEVER_CALL_REASON_MAX = 400;
export const neverCallSchema = z.strictObject({ reason: z.string().trim().min(1).max(NEVER_CALL_REASON_MAX) });
export type NeverCall = z.infer<typeof neverCallSchema>;
/** Where a suppression came from. `call` is the outcome form, `reply` the mailbox (S3), `manual` the suppress command, `dnc_evidence` research. */
export const v1SuppressionSourceSchema = z.enum(['call', 'reply', 'manual', 'dnc_evidence']);
export type V1SuppressionSource = z.infer<typeof v1SuppressionSourceSchema>;
/** A callback David promised on a call, as the card and the Firm view show it. */
export const v1PendingCallbackSchema = z.strictObject({ dueOn: z.iso.date(), promisedAt: instant });
export type V1PendingCallback = z.infer<typeof v1PendingCallbackSchema>;

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
  /** The callback David promised on the last call and has not made yet (S2); the callbacks lane leads the morning on its due day. */
  pendingCallback: v1PendingCallbackSchema.nullable().optional(),
  nextStep: todayNextStepSchema,
  /**
   * The draft waiting for David on this firm, if any (S3). Optional so a client built against the S1 card shape
   * still validates; the worker always sends it, as null when there is nothing waiting.
   */
  pendingDraft: z.strictObject({ draftId: z.string().min(1).max(200), kind: z.enum(['reply', 'followup']),
    status: z.enum(['pending', 'approved']), subject: z.string().max(240), createdAt: instant }).nullable().optional(),
  /**
   * Why the firm's sequence is not moving, as the send fence and the mail poller recorded it (S3). Separate from
   * `holdReason`, which is about dialling this card right now; both can be set, and both are closed codes.
   */
  sequenceHold: z.strictObject({ reason: v1HoldReasonSchema, code: attemptReasonSchema, stepId: z.string().max(200).nullable() }).nullable().optional(),
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

/**
 * The Firm view (design section 3, `GET /v1/firms`; slice S2). Everything the worker holds about one firm that
 * David may read: its routes with the verification word and whether each is retired or suppressed, where it stands
 * in the sequence, every call logged against it, the callbacks promised, the suppression record if there is one, a
 * one-line evidence summary and the holds that stop a dial now. No address, excerpt, token or provider message
 * travels: the city and the state code are the only place words, exactly as on a card.
 */
export const v1FirmStatusSchema = z.enum(['new', 'listed', 'in_sequence', 'resting', 'done', 'suppressed']);
export type V1FirmStatus = z.infer<typeof v1FirmStatusSchema>;
export const v1FirmRouteSchema = z.strictObject({
  routeId: z.string().min(1).max(200),
  channel: z.enum(['phone', 'email']),
  /** The E.164 number or the lower-case address, as it would be dialed or addressed. */
  value: z.string().min(1).max(254),
  verification: z.enum(['published', 'confirmed', 'unverified', 'listed']),
  /** Retired for a wrong number: never dialed again, never deleted. */
  retired: z.boolean(),
  suppressed: z.boolean(),
});
export type V1FirmRoute = z.infer<typeof v1FirmRouteSchema>;
export const v1FirmCallSchema = z.strictObject({
  at: instant,
  outcome: v1CallOutcomeSchema,
  note: z.string().max(CALL_NOTE_MAX).nullable(),
  callbackOn: z.iso.date().nullable(),
  neverCallReason: z.string().max(NEVER_CALL_REASON_MAX).nullable(),
  /** The route the call was dialed on, and the worker's own dial verdict at that instant. */
  routeId: z.string().max(200).nullable(),
  dialAllowed: z.boolean(),
  holdCode: attemptReasonSchema.nullable(),
  deviceId: uuid.nullable(),
});
export type V1FirmCall = z.infer<typeof v1FirmCallSchema>;
/** Where the firm stands in the standing sequence, and which record said so: the new `SEQ#` or the carried enrollment. */
export const v1FirmSequenceSchema = z.strictObject({
  source: z.enum(['sequence', 'enrollment']),
  state: z.enum(['active', 'paused', 'stopped']),
  startedAt: instant,
  currentStepId: z.string().max(200).nullable(),
  stepIndex: z.number().int().nonnegative().nullable(),
  stepCount: z.number().int().nonnegative(),
  nextDueAt: instant.nullable(),
  restingUntil: instant.nullable(),
  entries: z.union([z.literal(1), z.literal(2)]),
  /** Email steps the cadence walked past; each one held, never drafted or sent here. */
  heldStepIds: z.array(z.string().max(200)).max(40),
  lastAdvance: attemptReasonSchema.nullable(),
});
export type V1FirmSequence = z.infer<typeof v1FirmSequenceSchema>;
export const v1FirmSuppressionSchema = z.strictObject({
  reason: z.string().max(NEVER_CALL_REASON_MAX),
  source: v1SuppressionSourceSchema,
  evidenceRef: z.string().max(200).nullable(),
  recordedBy: deviceLabel,
  at: instant,
  /** The canonical handles suppressed with the firm: E.164 numbers and lower-case addresses. */
  handles: z.array(z.string().min(1).max(254)).max(100),
});
export type V1FirmSuppression = z.infer<typeof v1FirmSuppressionSchema>;
/** One line about the firm's evidence: how many sources, when it was last researched, whether it is a hand-entered firm. */
export const v1FirmEvidenceSchema = z.strictObject({ sources: count, researchedAt: instant.nullable(), enteredBy: z.enum(['research', 'hand']) });
/**
 * The mail side of one firm, as the Firm view reports it (S3's records read through S2's view). No body, no
 * address and no provider message travels: a send is its step, its state and when it went; a reply is when it
 * arrived, what it was classified as and whether David has answered it; a draft is what is waiting for him.
 */
export const v1FirmSendSchema = z.strictObject({
  stepId: z.string().min(1).max(200),
  state: z.enum(['dispatching', 'accepted', 'not_sent', 'unknown']),
  sentAt: instant.nullable(),
  reason: attemptReasonSchema.nullable(),
  templateId: z.enum(['T1', 'T2', 'T3', 'T4', 'T5']).nullable(),
});
export type V1FirmSend = z.infer<typeof v1FirmSendSchema>;
export const v1FirmReplySchema = z.strictObject({
  replyId: z.string().min(1).max(200),
  at: instant,
  classification: attemptReasonSchema,
  matchedBy: z.enum(['message_id', 'sender']),
  /** David's decision, when the reply needed one; null while it is still waiting. */
  decision: z.enum(['stop', 'continue']).nullable(),
  resolvedAt: instant.nullable(),
});
export type V1FirmReply = z.infer<typeof v1FirmReplySchema>;
export const v1FirmDraftSchema = z.strictObject({
  draftId: z.string().min(1).max(200),
  kind: z.enum(['reply', 'followup']),
  status: z.enum(['pending', 'approved', 'sent']),
  subject: z.string().max(240),
  createdAt: instant,
});
export type V1FirmDraft = z.infer<typeof v1FirmDraftSchema>;
export const v1FirmViewSchema = z.strictObject({
  asOf: instant,
  firmId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  website: z.string().max(253).nullable(),
  city: z.string().max(200).nullable(),
  state: v1StateCodeSchema.nullable(),
  timeZone: z.string().max(64).nullable(),
  status: v1FirmStatusSchema,
  localTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  dialAllowed: z.boolean(),
  holdReason: v1HoldReasonSchema.nullable(),
  holdCode: attemptReasonSchema.nullable(),
  routes: z.array(v1FirmRouteSchema).max(100),
  sequence: v1FirmSequenceSchema.nullable(),
  calls: z.array(v1FirmCallSchema).max(200),
  callbacks: z.array(v1PendingCallbackSchema).max(100),
  suppression: v1FirmSuppressionSchema.nullable(),
  /** The mail side (S3). Optional so a client built against the S2 shape still validates; the worker always sends all three. */
  sends: z.array(v1FirmSendSchema).max(40).optional(),
  replies: z.array(v1FirmReplySchema).max(100).optional(),
  drafts: z.array(v1FirmDraftSchema).max(40).optional(),
  evidence: v1FirmEvidenceSchema,
  /** Every hold that stands between this firm and a dial now, by reason and closed code. */
  holds: z.array(todayHoldCountSchema).max(20),
});
export type V1FirmView = z.infer<typeof v1FirmViewSchema>;

/**
 * The Settings view, first slice (S1b, ahead of S5): David's postures by state and the clearance reference texts he
 * reads beside the posture control, served by the worker so the client shows exactly the revision the worker records
 * as `referenceTextRevision`. Only these two keys for now; templates, limits, research, phone, grant and devices are S5.
 */
export const referenceCitationSchema = z.strictObject({ title: z.string().min(1).max(200), url: z.url().max(2048), quote: z.string().min(1).max(600) });
export const stateReferenceTextSchema = z.strictObject({ state: v1StateCodeSchema, name: z.string().min(1).max(100), summary: z.string().min(1).max(4000),
  citation: referenceCitationSchema, furtherCitations: z.array(referenceCitationSchema).max(10) });
export type StateReferenceText = z.infer<typeof stateReferenceTextSchema>;

/**
 * The rest of Settings (slice S5): every control the design's "Controls you use today, mapped" table keeps, as the
 * worker serves it. Reading Settings decides nothing; each section is the record as it stands, with the closed
 * reasons a control is not usable beside it, never a silent zero.
 */

/** Minutes from midnight on the firm's own clock. 0 to 1440, so 20:00 is 1200 and the end of the day is 1440. */
const minuteOfDay = z.number().int().min(0).max(24 * 60);
export const callWindowSchema = z.strictObject({ startMinute: minuteOfDay, endMinute: minuteOfDay })
  .refine(window => window.startMinute < window.endMinute, 'call_window_empty');
export type CallWindowShape = z.infer<typeof callWindowSchema>;
export const stateCallWindowSchema = z.strictObject({ state: v1StateCodeSchema, window: callWindowSchema });

/**
 * `SETTINGS#calls` as Settings shows it. `floor` is the window fixed in code (Monday to Friday, 08:00 to 20:00 on
 * the firm's own clock); `window` is what David narrowed it to, and `byState` narrows one state further. Nothing
 * here can widen the floor: `set_call_policy` refuses a window the floor does not contain.
 */
export const callPolicyViewSchema = z.strictObject({
  floor: z.strictObject({ days: z.array(z.number().int().min(0).max(6)).max(7), window: callWindowSchema }),
  window: callWindowSchema,
  byState: z.array(stateCallWindowSchema).max(60),
  /** How many cards one run of the list offers, when David has narrowed it; null means the code's own number. */
  capPerRun: z.number().int().positive().max(1000).nullable(),
  revision: count,
  updatedAt: instant.nullable(),
});
export type CallPolicyView = z.infer<typeof callPolicyViewSchema>;

/**
 * `SETTINGS#phone`. The worker records that David confirmed the Phone.app setup on some Mac and the digest of the
 * proof he confirmed; the proof file itself never leaves the Mac, and this record is never a permission to dial.
 */
export const phoneSetupViewSchema = z.strictObject({
  status: z.enum(['confirmed', 'cleared']),
  confirmedAt: instant.nullable(),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  confirmedBy: deviceLabel.nullable(),
  revision: count,
  updatedAt: instant.nullable(),
});
export type PhoneSetupView = z.infer<typeof phoneSetupViewSchema>;

/** `SETTINGS#paused`. While paused nothing sends and nothing polls; the reason is the sentence every page shows. */
export const pausedViewSchema = z.strictObject({
  paused: z.boolean(),
  reason: z.string().max(200).nullable(),
  at: instant.nullable(),
  by: deviceLabel.nullable(),
  revision: count,
});
export type PausedView = z.infer<typeof pausedViewSchema>;

/** One template with its standing approval and the footer check, as Settings shows it. Approving is never sending. */
export const settingsTemplateSchema = z.strictObject({
  templateId: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  variables: z.array(z.string().min(1).max(40)).max(20),
  revision: z.number().int().positive(),
  state: z.enum(['draft', 'approved']),
  approvedAt: instant.nullable(),
  approvedRevision: z.number().int().positive().nullable(),
  /** Whether the standing approval still covers this exact text and the current postal address. */
  approved: z.boolean(),
  /** Whether the body ends with the footer block the current postal address makes. False with no address. */
  footerPresent: z.boolean(),
  /** Every reason this text could not be approved right now, in the order David reads them; empty when it could. */
  issues: z.array(attemptReasonSchema).max(20),
});
export type SettingsTemplate = z.infer<typeof settingsTemplateSchema>;

/** `SETTINGS#sending` with the ceiling fixed in code beside it and today's cap line. Settings may only narrow. */
export const sendingViewSchema = z.strictObject({
  dailyLimit: count,
  ramp: z.strictObject({ startPerDay: count, stepPerDay: count, maxPerDay: count }),
  ceiling: z.strictObject({ dailyLimit: count, startPerDay: count, stepPerDay: count, maxPerDay: count }),
  postalAddress: z.string().max(200).nullable(),
  revision: count,
  updatedAt: instant.nullable(),
  /** The cap line: today's Eastern date, the cap it works out to, the warm-up day it is, and how many are used. */
  capLine: z.strictObject({ date: z.iso.date(), cap: count, day: z.number().int().positive(), used: count, remaining: count }),
  /** The footer every approved body must end with, built from the postal address; null until there is one. */
  footerBlock: z.string().max(1000).nullable(),
});
export type SendingView = z.infer<typeof sendingViewSchema>;

/**
 * `SETTINGS#research` as Settings shows it, which is S4's record and nothing invented beside it: the query grid,
 * the daily budget under the ceiling fixed in code, and the operator descriptor's window. The descriptor is the
 * one thing David has to keep current — research stops when it expires — so its dates are here, not only its
 * status, and the section names the day it runs out. `todaySpend` is today's counter, which is arithmetic about
 * what research already did and never a permission to do more.
 */
export const researchDescriptorViewSchema = z.strictObject({
  reviewedAt: instant,
  expiresAt: instant,
  status: z.enum(['reviewed', 'expired']),
});
export const researchViewSchema = z.strictObject({
  queries: z.array(z.string().min(1).max(500)).max(400),
  dailyBudget: count,
  /** The ceiling fixed in code. `set_research_config` may only set a budget below it. */
  budgetCeiling: count,
  /** Null until David records the review window. Research is held while it is null or expired. */
  descriptor: researchDescriptorViewSchema.nullable(),
  todaySpend: z.strictObject({ date: z.iso.date(), spent: count, budget: count, remaining: count }),
  revision: count,
  updatedAt: instant,
});
export type ResearchView = z.infer<typeof researchViewSchema>;

/**
 * The Google grant as Settings reads it from the table alone: no refresh, no network call, because a view is never
 * an action. Until the cutover (S6) the grant is still the pairing-bound `GOOGLE_GRANT#<pairingId>` record the old
 * flow wrote; S6 replaces it with a fresh consent, which is what `reconsentAtCutover` says.
 */
export const GOOGLE_GRANT_STATUSES = ['connected', 'not_connected', 'revoked', 'multiple_grants'] as const;
export const googleGrantViewSchema = z.strictObject({
  status: z.enum(GOOGLE_GRANT_STATUSES),
  email: z.string().max(320).nullable(),
  grants: count,
  reconsentAtCutover: z.literal(true),
  note: z.string().max(400),
});
export type GoogleGrantView = z.infer<typeof googleGrantViewSchema>;

/**
 * The Week view (`GET /v1/week`, design section 3): the last seven Eastern days read from the permanent records —
 * `CALL#`, accepted `SEND#`, `REPLY#`, `CALLBACK#`, the research evidence — plus the holds from `ATTEMPT#`, which
 * is the one source that expires (thirty days), so a hold count is what the log still holds and says so.
 */
export const weekDaySchema = z.strictObject({
  date: z.iso.date(),
  calls: count,
  emailsSent: count,
  replies: count,
  callbacksPromised: count,
  callbacksKept: count,
  firmsResearched: count,
});
export const weekViewSchema = z.strictObject({
  asOf: instant,
  /** The seven Eastern days the view covers, oldest first; `to` is today in New York. */
  from: z.iso.date(),
  to: z.iso.date(),
  days: z.array(weekDaySchema).max(7),
  calls: z.strictObject({ total: count, byOutcome: z.array(z.strictObject({ outcome: v1CallOutcomeSchema, count: count.min(1) })).max(V1_CALL_OUTCOMES.length) }),
  emailsSent: count,
  replies: count,
  callbacks: z.strictObject({ promised: count, kept: count }),
  firmsResearched: count,
  /**
   * Research spend over the seven days, summed from S4's daily counters. Those counters keep three days, so the
   * older days of the week usually have none: `daysCounted` says how many of the seven the sum actually covers,
   * and `spent` is null when it covers none of them. It is never presented as a zero it did not read.
   */
  spend: z.strictObject({ spent: count.nullable(), daysCounted: count, daysMissing: count, counterKeepsDays: z.literal(3) }),
  holds: z.array(z.strictObject({ reason: v1HoldReasonSchema, code: attemptReasonSchema, count: count.min(1) })).max(60),
});
export type WeekView = z.infer<typeof weekViewSchema>;

export const settingsViewSchema = z.strictObject({
  postures: z.array(statePostureSummarySchema),
  referenceTexts: z.strictObject({
    /** `TERRITORY_RULES_REVISION`: what a `set_state_posture` sends back as `referenceTextRevision`. */
    revision: z.number().int().positive(),
    /** The four confirmation statements, by key. */
    statements: z.record(z.string().min(1).max(40), z.string().min(1).max(1000)),
    states: z.array(stateReferenceTextSchema),
  }),
  /**
   * Every other section (S5). All optional so a client built against the S1b shape still validates its answer,
   * and so a worker that has not shipped S5 yet is read as "not served", never as an empty setting.
   */
  /** Every earlier decision per state, newest first. A state with only its first decision has an empty list. */
  postureHistory: z.array(z.strictObject({ state: v1StateCodeSchema, entries: z.array(statePostureHistoryEntrySchema).max(200) })).max(60).optional(),
  templates: z.array(settingsTemplateSchema).max(20).optional(),
  sending: sendingViewSchema.optional(),
  research: researchViewSchema.optional(),
  calls: callPolicyViewSchema.optional(),
  phone: phoneSetupViewSchema.optional(),
  google: googleGrantViewSchema.optional(),
  devices: z.array(diagnosticsDeviceSchema).optional(),
  paused: pausedViewSchema.optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const diagnosticsViewSchema = z.strictObject({
  asOf: instant,
  attempts: z.array(attemptRecordSchema).max(DIAGNOSTICS_ATTEMPT_LIMIT),
  lastTick: lastTickLineSchema.nullable(),
  devices: z.array(diagnosticsDeviceSchema),
  /** Postures by state, until Settings ships in S5. Optional so a client built against the S0 shape still validates. */
  postures: z.array(statePostureSummarySchema).optional(),
  /**
   * The job queue as the worker can see it from the table alone (S3): jobs waiting or running, jobs that failed
   * their last attempt, jobs that exhausted their three attempts and are therefore on the dead-letter queue, and
   * when the scheduler last ran. The API role holds no queue permission by design, so these are counts of `JOB#`
   * records, not a reading of SQS; `deadLettered` is what the worker knows, and the DLQ alarm is what AWS knows.
   */
  queue: z.strictObject({
    queued: count, running: count, failed: count, deadLettered: count,
    lastSchedulerRun: z.strictObject({ at: instant, tickSeq: z.number().int().positive(), enqueued: count, durationMs: count }).nullable(),
  }).optional(),
  /**
   * Research as the worker can see it (S4): how many posture-cleared firms are waiting for a morning that has
   * not offered them yet, what today has spent against its budget, and the window David's operator review
   * covers. `descriptor` is null until he has recorded one, which is honest rather than an assumed approval.
   */
  research: z.strictObject({
    pool: z.strictObject({ researched: count, unlisted: count, postureCleared: count }),
    spentToday: count,
    budget: count,
    descriptor: z.strictObject({ reviewedAt: instant, expiresAt: instant, status: z.enum(['reviewed', 'expired']) }).nullable(),
  }).optional(),
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
/**
 * One dialed call, logged once (slice S2). `observedAt` is when David says the call happened; the worker stamps
 * its own dial evaluation at that instant beside it, so a call logged from a held card is visible as exactly that.
 * `callbackOn` is only read for the `callback` outcome; `neverCall` suppresses whatever the outcome was.
 */
export const logCallOutcomeCommandSchema = z.strictObject({
  commandId, kind: z.literal('log_call_outcome'),
  firmId: z.string().min(1).max(200),
  outcome: v1CallOutcomeSchema,
  note: callNote.optional(),
  callbackOn: z.iso.date().optional(),
  neverCall: neverCallSchema.optional(),
  observedAt: instant,
});
export type LogCallOutcomeCommand = z.infer<typeof logCallOutcomeCommandSchema>;
/** A firm David enters by hand (design section 3). It enters the pool like a researched one; research is never enqueued for it. */
export const addFirmCommandSchema = z.strictObject({
  commandId, kind: z.literal('add_firm'),
  name: z.string().trim().min(1).max(300),
  site: z.string().max(253).optional(),
  phone: z.string().min(1).max(60).optional(),
  email: z.string().min(3).max(254).optional(),
  city: z.string().trim().min(1).max(200),
  state: v1StateCodeSchema,
});
export type AddFirmCommand = z.infer<typeof addFirmCommandSchema>;
/** One route admitted by hand on a firm that already exists. Refused on a suppressed firm. */
export const admitRouteCommandSchema = z.strictObject({
  commandId, kind: z.literal('admit_route'),
  firmId: z.string().min(1).max(200),
  phone: z.string().min(1).max(60).optional(),
  email: z.string().min(3).max(254).optional(),
});
export type AdmitRouteCommand = z.infer<typeof admitRouteCommandSchema>;
/** Suppress a firm or one handle, permanently. There is no unsuppress anywhere in this contract. */
export const suppressCommandSchema = z.strictObject({
  commandId, kind: z.literal('suppress'),
  firmId: z.string().min(1).max(200).optional(),
  handle: z.string().min(1).max(254).optional(),
  reason: z.string().trim().min(1).max(NEVER_CALL_REASON_MAX),
  evidenceRef: z.string().max(200).optional(),
});
export type SuppressCommand = z.infer<typeof suppressCommandSchema>;
/**
 * Email under the standing approval (S3). `approve_template` carries the exact subject and body David approved,
 * which the worker re-checks against every body rule and the footer before it records a standing approval;
 * `set_sending_limit` may only narrow the ceiling fixed in code. Neither of them sends anything.
 */
export const REPLY_TEMPLATE_COMMAND_IDS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export const approveTemplateCommandSchema = z.strictObject({ commandId, kind: z.literal('approve_template'),
  templateId: z.enum(REPLY_TEMPLATE_COMMAND_IDS), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  subject: z.string().min(1).max(160), body: z.string().min(1).max(4000) });
const sendingLimitNumber = z.number().int().nonnegative().max(10000);
export const setSendingLimitCommandSchema = z.strictObject({ commandId, kind: z.literal('set_sending_limit'),
  dailyLimit: sendingLimitNumber.optional(),
  ramp: z.strictObject({ startPerDay: sendingLimitNumber, stepPerDay: sendingLimitNumber, maxPerDay: sendingLimitNumber }).optional(),
  postalAddress: z.string().trim().min(1).max(200).optional() });
/** David's answer to a reply that is not unambiguous. `stop` suppresses permanently; `continue` resumes the cadence. */
export const replyDecisionCommandSchema = z.strictObject({ commandId, kind: z.literal('reply_decision'),
  replyId: z.string().min(1).max(200), decision: z.enum(['stop', 'continue']) });
const draftId = z.string().min(1).max(200);
/** Opens a follow-up draft. The worker never writes the prose: the text arrives with the approval. */
export const requestFollowupCommandSchema = z.strictObject({ commandId, kind: z.literal('request_followup'),
  firmId: z.string().min(1).max(200), draftId, text: z.string().max(24000).optional() });
export const approveFollowupDraftCommandSchema = z.strictObject({ commandId, kind: z.literal('approve_followup_draft'),
  firmId: z.string().min(1).max(200), draftId, text: z.string().min(1).max(24000) });
export const approveReplyDraftCommandSchema = z.strictObject({ commandId, kind: z.literal('approve_reply_draft'),
  firmId: z.string().min(1).max(200), draftId, text: z.string().min(1).max(24000) });

/**
 * The Settings commands (S5). None of them sends, dials or books: they record what David decided.
 * `set_call_policy` may only narrow the window fixed in code; a window the floor does not contain is refused whole.
 * `confirm_phone_setup` records the digest of the proof file the Mac holds, never the proof itself.
 * `pause` stops every send and poll until a `resume`; both carry the reason David typed.
 */
export const setCallPolicyCommandSchema = z.strictObject({ commandId, kind: z.literal('set_call_policy'),
  window: callWindowSchema.optional(),
  byState: z.array(stateCallWindowSchema).max(60).optional(),
  /** Null clears David's narrowing and returns the run to the number fixed in code. */
  capPerRun: z.number().int().positive().max(1000).nullable().optional() });
export type SetCallPolicyCommand = z.infer<typeof setCallPolicyCommandSchema>;
export const confirmPhoneSetupCommandSchema = z.strictObject({ commandId, kind: z.literal('confirm_phone_setup'),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ConfirmPhoneSetupCommand = z.infer<typeof confirmPhoneSetupCommandSchema>;
export const clearPhoneSetupCommandSchema = z.strictObject({ commandId, kind: z.literal('clear_phone_setup') });
export const pauseCommandSchema = z.strictObject({ commandId, kind: z.literal('pause'), reason: z.string().trim().min(1).max(200) });
export const resumeCommandSchema = z.strictObject({ commandId, kind: z.literal('resume'), reason: z.string().trim().min(1).max(200).optional() });

/**
 * What research is allowed to do (S4). The queries are replaced whole, the daily budget may only be set below the
 * ceiling fixed in code, and the descriptor records the window David's operator review actually covers. Narrowing
 * research is always allowed; nothing here starts a research run, and setting a budget is never a spend.
 */
export const setResearchConfigCommandSchema = z.strictObject({ commandId, kind: z.literal('set_research_config'),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  queries: z.array(z.string().trim().min(1).max(500)).max(400).optional(),
  dailyBudget: z.number().int().nonnegative().max(100000).optional(),
  descriptor: z.strictObject({ reviewedAt: instant, expiresAt: instant }).optional() });
export type SetResearchConfigCommand = z.infer<typeof setResearchConfigCommandSchema>;

/**
 * Every `/v1` command, discriminated on `kind`. S0 ships `revoke_device`, S1 adds `set_state_posture`, S2 the dial
 * and log, S3 email under the standing approval, S4 the research configuration, S5 Settings.
 */
export const v1CommandSchema = z.discriminatedUnion('kind', [revokeDeviceCommandSchema, setStatePostureCommandSchema,
  logCallOutcomeCommandSchema, addFirmCommandSchema, admitRouteCommandSchema, suppressCommandSchema,
  approveTemplateCommandSchema, setSendingLimitCommandSchema, replyDecisionCommandSchema, requestFollowupCommandSchema,
  approveFollowupDraftCommandSchema, approveReplyDraftCommandSchema, setResearchConfigCommandSchema,
  setCallPolicyCommandSchema, confirmPhoneSetupCommandSchema, clearPhoneSetupCommandSchema, pauseCommandSchema, resumeCommandSchema]);
export type V1Command = z.infer<typeof v1CommandSchema>;

/**
 * What one `/v1/commands` request came to. `duplicate` means this commandId was already answered to the same
 * device: the receipt then carries the first answer's reason, or its outcome (`applied`) when the first answer
 * had no reason. The same commandId from another device, or with another payload, is `refused` as `command_conflict`.
 */
export const v1CommandSliceSchema = z.discriminatedUnion('kind', [
  /** The card as it stands after the command, or null when the firm has left the list (suppressed, or never on it). */
  z.strictObject({ kind: z.literal('card'), firmId: z.string().min(1).max(200), card: todayCardSchema.nullable() }),
  /** The Settings sections S5's commands return, each the section as it stands after the write. */
  z.strictObject({ kind: z.literal('call_policy'), calls: callPolicyViewSchema }),
  z.strictObject({ kind: z.literal('phone_setup'), phone: phoneSetupViewSchema }),
  z.strictObject({ kind: z.literal('paused'), paused: pausedViewSchema }),
]);
export type V1CommandSlice = z.infer<typeof v1CommandSliceSchema>;
export const v1CommandReceiptSchema = z.strictObject({
  commandId,
  outcome: z.enum(['applied', 'duplicate', 'refused']),
  reason: attemptReasonSchema.nullable(),
  /** The updated view slice (design section 3). Optional: `revoke_device` and `set_state_posture` return none. */
  slice: v1CommandSliceSchema.nullable().optional(),
});
export type V1CommandReceipt = z.infer<typeof v1CommandReceiptSchema>;
