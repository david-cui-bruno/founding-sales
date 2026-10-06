import {learningInputSchema,learningReportSchema,targetingViewSchema,targetingProposalSchema,targetingApplySchema} from '@fss/contracts';
import {meetingQualificationViewSchema,saveMeetingQualificationSchema} from '@fss/contracts';
import {firmQualificationReadSchema} from '@fss/contracts';
import {sourcingFeedbackSchema,sourcingFeedbackSavedSchema} from '@fss/contracts';
import { qualificationReadSchema, qualificationViewSchema, qualificationRequestSchema, qualificationQueuedSchema, qualificationAdmissionSchema, qualificationAdmittedSchema } from '@fss/contracts';
import { candidateInputSchema, candidateListInputSchema, candidateListSchema, candidateReviewInputSchema, candidateDeleteInputSchema, candidateSavedSchema, candidateChangedSchema } from '@fss/contracts';
import { meetingRecordingSetupViewSchema,retryMeetingRecordingSetupSchema } from '@fss/contracts';
import { meetingDraftEditSchema,meetingFollowThroughViewSchema } from '@fss/contracts';
import { z } from 'zod';
import { saveMeetingNotesSchema, changeMeetingTaskSchema, meetingNotesRevisionSchema, meetingTaskViewSchema, meetingOutcomesViewSchema } from '@fss/contracts';
import {
  CALL_OUTCOMES,
  meetingTranscriptPageSchema,
  recordingRecoveriesSchema,
  applyCallProposalsResultSchema,
  callLogRowSchema,
  correctCallOutcomeCommandSchema,
  correctCallOutcomeResultSchema,
  correctionPreviewRequestSchema,
  correctionPreviewResponseSchema,
  callAnalysisNotesSchema,
  callAnalysisResponseSchema,
  callProposalEditsSchema,
  callProposalKeySchema,
  callRecapResponseSchema,
  doNotCallChoiceSchema,
  proposalAcceptanceResponseSchema,
  callTrialResponseSchema,
  reviewItemSchema,
  callCadenceSchema,
  callRecordingResponseSchema,
  callTranscriptResponseSchema,
  callSessionDtoSchema,
  callsPlacedTodayResponseSchema,
  firmMeetingDtoSchema,
  firmRecordingSchema,
  firmTimelineSchema,
  firmBasicsIssueSchema,
  TODAY_CARD_BLOCKERS,
  instant,
  meetingAttendanceSetSchema,
  MEETING_ATTENDANCE_CHOICES,
  meetingBriefResponseSchema,
  meetingMatchedSchema,
  stageSuggestionSchema,
  unmatchedMeetingDtoSchema,
  uuid,
} from '@fss/contracts';
import { briefImportViewSchema } from './briefImport.ts';
import { recordingItemIdSchema, recordingsViewSchema, recordingRecoveryViewSchema } from './recordings.ts';
import { crmStateSchema, addFirmDraftSchema } from '../renderer/firmWorkspaceContract.ts';
import { replyModelStateSchema, replyStateSchema, REPLY_DISPOSITIONS, REPLY_MODELS } from '../renderer/replyContract.ts';
import { draftStepSchema, sequenceStateSchema } from '../renderer/sequenceContract.ts';
import { researchStateSchema } from '../renderer/researchContract.ts';
import { todayStateSchema } from '../renderer/todayContract.ts';
import {
  addCallingNumberInputSchema,
  adminStateSchema,
  allowStatesInputSchema,
  recordHolidayCalendarInputSchema,
  recordSendingAuthenticationInputSchema,
  saveIntegrationInputSchema,
  saveSettingInputSchema,
  setSendingCapInputSchema,
  SETTINGS_TAB_SCREENS,
} from '../renderer/settingsContract.ts';
import { mailboxStateSchema } from './contract.ts';

/**
 * Every operation the converted views may ask the main process for, as a closed list
 * (D4; specification 14.2).
 *
 * Until 1.0.12 each view had a bridge of its own — `callieToday` with nine methods,
 * `callieReplies` with six — and each was a hand-written pair: a method in the preload, a
 * channel name, a handler in `todayWindow.ts` that cast the argument and hoped. This is
 * the same surface stated once. The preload exposes two functions, `api.read(op, input)`
 * and `api.command(op, input)`, and both sides look the operation up here.
 *
 * It is a **registry of operations, not a path pass-through**, and that distinction is
 * the whole point:
 *
 *   * a renderer names an operation, never a URL, so nothing it sends can choose an
 *     endpoint, a method or a body shape the list below does not already allow;
 *   * `input` and `output` are Zod schemas checked on both sides of the bridge, so a
 *     state that grew a field it should not have — a token, a `tel:` URI — fails at the
 *     boundary instead of reaching the page;
 *   * `calls` records every API path the main process may reach for it — a `POST` for
 *     several *reads* (`docs/decisions/g3b-reads-are-posts.md`), and empty for the
 *     operations answered from the main process's own state — so "which routes does this
 *     build still call" is a list a test walks rather than a grep;
 *   * `transform` names the main-process work the operation needs — the stale expansion
 *     and refusal eviction on Today's card, the wall-clock callback resolved against the
 *     business zone on a reply — so a handler that quietly stopped doing it is a name
 *     with nothing behind it rather than a silent change of behaviour.
 *
 * Three things deliberately stay outside it. **Dialling** is its own named channel,
 * because it opens a URI on the operating system rather than returning an answer, and a
 * generic `command(op, input)` is not where that should live. **Choosing a file to
 * import** is another, for the same reason: macOS's open dialog belongs to the main
 * process, and since 1.0.13 the CSV's text never crosses the bridge at all — the window
 * asks for a file and is given the server's preview of it. **Sign-in** stays on
 * `apiClient.ts`, the unauthenticated client with its closed list of six methods: the
 * registry's calls all carry a bearer token, and the one call made before there is a
 * token should not be able to reach them.
 *
 * Since 1.0.13 every view is here. Firms, Sequences, Settings and the Mailbox row had
 * forty-eight hand-written channels between them, each a method in the preload, a name,
 * and a handler that cast its argument and hoped; they are the entries below, and the
 * casting is the input schemas.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const nothing = z.strictObject({});

/** A read Today made by itself, on focus or at the rollover: it keeps the last notice. */
const refreshInput = z.strictObject({ quiet: z.boolean().optional() });

const snoozeInput = z.strictObject({
  itemId: uuid,
  reason: z.string().min(1).max(500),
  /**
   * The explicit instant a manual task comes back, as a `datetime-local` — no zone, which
   * the main process resolves against the business zone. Empty for an automated task's
   * pause, which a person releases rather than a clock.
   */
  returnAt: z.string().max(40),
});

const outcomeInput = z.strictObject({
  firmId: uuid,
  itemId: uuid.nullable(),
  /** The call named by the page; never replaced by the bridge's own last call. */
  callSessionId: uuid.nullable().optional(),
  contactId: uuid.nullable(),
  routeId: uuid.nullable(),
  outcome: z.enum(CALL_OUTCOMES),
  note: z.string().max(2000),
  callback: z
    .strictObject({
      localDate: z.string().max(10),
      localTime: z.string().max(5),
      dueAt: z.string().max(40),
      sourceTimeZone: z.string().max(64),
    })
    .nullable(),
  doNotCallCoversAllContact: z.boolean(),
  /** What a `do_not_call` stops (migration 0037, P1). Absent is the checkbox above. */
  doNotCall: doNotCallChoiceSchema.optional(),
  /** The form's own command id (rules K5/K6): a retry resends the request under it. */
  commandId: uuid.optional(),
  /**
   * The follow-up the salesperson agreed to on the call (migration 0025). `null` is
   * "none", which is the default the form offers, and the only value the server accepts
   * for any outcome other than `interested`. It names the approved template version that
   * was promised, because that is what the permission is bound to (P0-2), or the agreed
   * sequence version (send-path v2). "Call me Tuesday" is `callback` above and grants no
   * e-mail permission at all.
   */
  followUpPermission: z
    .discriminatedUnion('scope', [
      z.strictObject({ scope: z.literal('single_email'), templateVersionId: uuid }),
      // Send-path v2 (slice S3): an agreed published sequence, enrolled by the server in
      // the same command. The card shows its preview before this can be sent.
      // `previewBasis` is the preview the person heard (review of S3, P1-3).
      z.strictObject({
        scope: z.literal('agreed_sequence'),
        sequenceVersionId: uuid,
        previewBasis: z.strictObject({
          anchorAt: instant,
          timeZone: z.string().min(1).max(64),
          calendarVersionId: z.string().min(1).max(64),
          steps: z.array(z.strictObject({ ordinal: z.number().int().min(1).max(50), sendAt: instant })).min(1).max(50),
        }),
      }),
    ])
    .nullable(),
});

/**
 * A firm's calling basics as typed (slice S2, `POST /crm/firms/basics`). Absent leaves a
 * field alone; null clears the locality or the state.
 */
const firmBasicsInput = z.strictObject({
  firmId: uuid,
  phone: z.strictObject({ number: z.string().min(1).max(40), replacesRouteId: uuid.optional() }).optional(),
  locality: z.string().max(200).nullable().optional(),
  regionCode: z.string().max(10).nullable().optional(),
  timeZone: z.string().min(1).max(64).optional(),
});

/** What saving the basics came to: the saved values, or the refusal and its fields. */
export const firmBasicsAnswerSchema = z.strictObject({
  saved: z
    .strictObject({
      firmId: uuid,
      routeId: uuid.nullable(),
      locality: z.string().max(200).nullable(),
      regionCode: z.string().max(10).nullable(),
      timeZone: z.string().max(64).nullable(),
      blockers: z.array(z.enum(TODAY_CARD_BLOCKERS)),
    })
    .nullable(),
  reason: z.string().max(80).nullable(),
  issues: z.array(firmBasicsIssueSchema),
});
export type FirmBasicsAnswer = z.infer<typeof firmBasicsAnswerSchema>;

/**
 * The outcomes the form offers for an incoming call: it was answered (migration 0034).
 * `do_not_call` is one the server accepts too, but an incoming call names no number, so
 * without "covers all contact" it would suppress nothing; the firm page's own stop
 * controls are where that is decided, not a quick log.
 */
export const INCOMING_CALL_OUTCOMES = ['interested', 'callback_requested', 'not_interested', 'referral_or_wrong_person'] as const satisfies readonly (typeof CALL_OUTCOMES)[number][];

/** "Log incoming call" (slice S2): a callback David took on his mobile. */
const incomingCallInput = z.strictObject({
  firmId: uuid,
  contactId: uuid.nullable(),
  /** When the call happened, as an instant: the form's local time on this Mac. */
  occurredAt: instant,
  durationSeconds: z.number().int().min(0).max(86_400).nullable(),
  outcome: z.enum(INCOMING_CALL_OUTCOMES),
  note: z.string().max(2000),
});

export const incomingCallAnswerSchema = z.strictObject({
  logged: z.boolean(),
  /** The refusal code, or a follow-up code the window says (a callback that needs a time). */
  reason: z.string().max(80).nullable(),
});
export type IncomingCallAnswer = z.infer<typeof incomingCallAnswerSchema>;

/** Send-path v2 (slice S3): which agreed sequence to preview, for whom, at the open firm. */
const followUpPreviewInput = z.strictObject({ firmId: uuid, contactId: uuid, sequenceVersionId: uuid });

/**
 * The research ceilings an admin may change. Every bound is also a CHECK in migration
 * 0022 and a refusal in `updateResearchSettings`; this one stops the Mac offering a
 * value it already knows the server will refuse. The model is not here: v1 admits one.
 */
const researchSettingsInput = z.strictObject({
  enabled: z.boolean().optional(),
  dailyFirmCeiling: z.number().int().min(0).max(10_000).optional(),
  dailyCostCeilingCents: z.number().int().min(0).max(1_000_000).optional(),
  monthlyCostCeilingCents: z.number().int().min(0).max(10_000_000).optional(),
  maxPagesPerFirm: z.number().int().min(1).max(8).optional(),
});

const confirmReplyInput = z.strictObject({
  messageId: uuid,
  disposition: z.enum(REPLY_DISPOSITIONS),
  callback: z
    .strictObject({
      localDate: z.string().max(10),
      localTime: z.string().max(5),
      sourceTimeZone: z.string().max(64),
    })
    .nullable(),
  firmWideOptOut: z.boolean(),
  note: z.string().max(2000),
  /**
   * Whether this confirmation grants a contextual-reply permission (migration 0025).
   * `true` is the default the form offers for `interested` and `follow_up_later` — David:
   * "an inbound question permits a contextual reply" — and `false` is the person saying
   * no follow-up. It is ignored for every other disposition.
   */
  grantFollowUp: z.boolean(),
});

/** One dead job, as `GET /admin/jobs/dead` lists it. Never a payload: a job's arguments
 *  can name a firm, an address and a message, and this screen is an operational one. */
export const deadJobSchema = z.object({
  id: uuid,
  kind: z.string().max(80),
  idempotencyKey: z.string().max(200),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(0),
  requeuedCount: z.number().int().min(0),
  errorCode: z.string().max(200).nullable(),
  errorDetail: z.string().max(2000).nullable(),
  deadAt: instant,
});
export type DeadJob = z.infer<typeof deadJobSchema>;

const deadJobsSchema = z.object({ deadJobs: z.array(deadJobSchema) });

/** `POST /outbound/status` for one fence, reduced to what Diagnostics shows. */
export const fenceStatusSchema = z
  .object({
    id: uuid,
    state: z.string().max(40),
    recipientAddress: z.string().max(320),
    dispatchStartedAt: instant.nullable(),
    sentAt: instant.nullable(),
    heldReason: z.string().max(80).nullable(),
    adminResolution: z.enum(['delivered', 'skipped']).nullable(),
    reconcileAttempts: z.number().int().min(0),
  })
  .nullable();

const requeuedSchema = z.object({ requeued: z.literal(true), jobId: uuid, kind: z.string().max(80) });

const resolvedSendSchema = z.object({
  outboundMessageId: uuid,
  resolution: z.enum(['delivered', 'skipped']),
});


// --- Firms, Sequences and Settings -------------------------------------

const firmId = z.strictObject({ firmId: uuid });

const contactEditInput = z.strictObject({
  contactId: uuid,
  fullName: z.string().trim().min(1).max(200),
  title: z.string().max(200).nullable(),
  makePrimary: z.boolean(),
});

/** The board read: Lost sits behind a filter the window remembers (slice K). */
const openPipelineInput = z.strictObject({ includeLost: z.boolean().optional() });

const valueChangeInput = z.strictObject({
  opportunityId: uuid,
  monthlyCents: z.number().int().min(0).max(100_000_000),
  kind: z.enum(['estimated', 'agreed']),
});

const stageChangeInput = z.strictObject({
  opportunityId: uuid,
  toStageKey: z.string().min(1).max(80),
  /** Section 8.1: a Lost change requires one. The server enforces it; this sends it. */
  reason: z.string().max(500).nullable(),
  /**
   * Lane M1: the stage the person saw the deal at, sent by the one-click suggestion; a deal
   * moved elsewhere since is refused (`stage_changed_elsewhere`) rather than moved.
   */
  expectedStageKey: z.string().min(1).max(40).optional(),
});

const mergeResolutionInput = z.strictObject({
  sourceFirmId: uuid,
  targetFirmId: uuid,
  /** Field name to the chosen value, one per conflict the API listed. */
  resolutions: z.record(z.string().max(80), z.string().max(2000)),
});

const enrollInput = z.strictObject({ sequenceVersionId: uuid, contactId: uuid });

/** "Check again" on an address, at the version the page showed (lane g90). */
/**
 * "I will handle this firm myself" (P1-1 of the GPT-6 review of PR 332). The reason is
 * the person's sentence; the opportunity is the open page's, never the window's word for
 * it. This is the only control that writes the `salesperson_command` origin, which is the
 * one manual mode an evidenced follow-up does not run beside.
 */
const takeOverInput = z.strictObject({ reason: z.string().min(1).max(2000) });

/** One held outgoing message of the open Firm page, and the firm a person named (S1 review P1-C). */
const resolveOutgoingInput = z.strictObject({ messageId: uuid, opportunityId: uuid });

const checkRouteInput = z.strictObject({ routeId: uuid, routeVersion: z.number().int().min(1) });

const saveStepsInput = z.strictObject({
  sequenceVersionId: uuid,
  steps: z.array(draftStepSchema).max(50),
});

/**
 * A template version, written or edited (wave 2, S3; D5). One press saves and approves:
 * `approve: true` is the same command, refused whole with every issue when the text does
 * not pass, so nothing is written that cannot be approved.
 */
const templateDraftInput = z.strictObject({
  /** The version being edited in place, or null for a new template. */
  templateVersionId: uuid.nullable(),
  name: z.string().max(200),
  subject: z.string().max(400),
  body: z.string().max(8000),
  signOff: z.string().max(300),
});

const versionInput = z.strictObject({ sequenceVersionId: uuid });

// ---------------------------------------------------------------------------
// Calling from Callie (slice C1)
// ---------------------------------------------------------------------------

/**
 * Whether a firm's Call button places the call in Callie or hands the number to the phone
 * app. `tel` **only** when the server said calling is off (`not_found`); `unavailable`
 * when it could not say — no answer, a 503, a refusal — and the Call button waits rather
 * than placing an untracked call through the phone app (review of C1, fold 1).
 */
export const callingViewSchema = z.strictObject({
  provider: z.enum(['tel', 'twilio', 'unavailable']),
  /** "Attempt N of 4", parked; null with `tel`. */
  cadence: callCadenceSchema.nullable(),
});
export type CallingView = z.infer<typeof callingViewSchema>;

/**
 * What the page needs to place one call: the session id — the only thing the Voice SDK
 * sends — and the Twilio Voice access token its Device connects with. **The token crosses
 * the bridge on purpose**: WebRTC runs in the page, so the Device does, and the token is
 * Twilio's (outgoing through our TwiML app only, an hour), not Callie's API credential.
 * The number never does. `attempt` and the rendered voicemail script are for the call view.
 */
export const callStartSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    sessionId: uuid,
    token: z.string().min(1).max(8192),
    attempt: z.number().int().min(1).nullable(),
    voicemailScript: z.string().max(2000).nullable(),
  }),
  z.strictObject({ ok: z.literal(false), reason: z.string().min(1).max(80) }),
]);
export type CallStart = z.infer<typeof callStartSchema>;

/**
 * `requestId` names one press of Call (review of C1, fold 3): the page makes it, and the
 * cancel for that press carries it, so a cancel that arrives after a newer start is
 * about the old press and leaves the newer one alone.
 */
const callStartInput = z.strictObject({ firmId: uuid, contactId: uuid.nullable(), routeId: uuid, requestId: uuid });
const callCancelInput = z.strictObject({ requestId: uuid });

/** The firm page's call history; null when it could not be read. */
export const callHistoryViewSchema = z.strictObject({ calls: z.array(callSessionDtoSchema).nullable() });

/**
 * Slice 3a, lane C: the after-call analysis, applying it, Needs review and the recap. Every
 * view is "the answer, or null/false with the server's code", never a thrown error, so a
 * 404 from an API without the route is a hidden block and not an error page.
 */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const reasonCode = z.string().max(80).nullable();
export const analysisViewSchema = z.strictObject({ analysis: callAnalysisResponseSchema.nullable(), reason: reasonCode });
export type AnalysisView = z.infer<typeof analysisViewSchema>;
export const proposalsApplyViewSchema = z.strictObject({
  applied: applyCallProposalsResultSchema.nullable(),
  /** The whole batch's refusal code. A refused Apply wrote nothing (it is atomic). */
  reason: reasonCode,
  /** Each refused key's own code, when the refusal named them; empty otherwise. */
  keyReasons: z.record(z.string().max(80), z.string().max(80)),
});
export type ProposalsApplyView = z.infer<typeof proposalsApplyViewSchema>;
export const declinedViewSchema = z.strictObject({ declined: z.boolean(), reason: reasonCode });
export const dismissedViewSchema = z.strictObject({ dismissed: z.boolean(), reason: reasonCode });
export const resolvedViewSchema = z.strictObject({ resolved: z.boolean(), reason: reasonCode });
export const stoppedViewSchema = z.strictObject({ stopped: z.boolean(), reason: reasonCode });
export const reviewViewSchema = z.strictObject({ items: z.array(reviewItemSchema).nullable(), failed: z.boolean() });
export type ReviewView = z.infer<typeof reviewViewSchema>;
export const recapViewSchema = z.strictObject({ recap: callRecapResponseSchema.nullable() });
export const acceptanceViewSchema = z.strictObject({ acceptance: proposalAcceptanceResponseSchema.nullable() });
/** Slice S3T: the 10-call trial; null when the read did not answer (an older API: the section hides). */
export const trialViewSchema = z.strictObject({ trial: callTrialResponseSchema.nullable() });

/**
 * S3X lane X2: correcting a logged outcome. Each view is the answer or null with the server's
 * code, never a thrown error, so a route an older API does not serve hides the control.
 */
export const callLogsViewSchema = z.strictObject({ calls: z.array(callLogRowSchema).nullable() });
export type CallLogsView = z.infer<typeof callLogsViewSchema>;
export const correctionPreviewViewSchema = z.strictObject({ preview: correctionPreviewResponseSchema.nullable(), reason: reasonCode });
export type CorrectionPreviewView = z.infer<typeof correctionPreviewViewSchema>;
export const correctedViewSchema = z.strictObject({ corrected: correctCallOutcomeResultSchema.nullable(), reason: reasonCode });
export type CorrectedView = z.infer<typeof correctedViewSchema>;
export const liftedViewSchema = z.strictObject({ lifted: z.boolean(), reason: reasonCode });
/** The correction's body as the renderer sends it: its own command id, kept for a retry. */
export const correctOutcomeInputSchema = correctCallOutcomeCommandSchema.omit({ clientVersion: true }).extend({ commandId: uuid });
export type CorrectOutcomeInput = z.infer<typeof correctOutcomeInputSchema>;

/** One recording's audio for the page to play; `reason` when it could not be read. */
export const callRecordingViewSchema = z.strictObject({
  recording: callRecordingResponseSchema.nullable(),
  reason: z.string().max(80).nullable(),
});

/**
 * One call's transcript (slice C2). `transcript` null and `reason` null when the call has
 * none (the API's 404): the page shows nothing. `reason` is the code when it could not be
 * read, for the page to put in a sentence.
 */
export const callTranscriptViewSchema = z.strictObject({
  transcript: callTranscriptResponseSchema.nullable(),
  reason: z.string().max(80).nullable(),
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface HttpCall {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export interface Operation {
  /** A read never mints a command id; a command always does, unless `envelope` says otherwise. */
  readonly kind: 'read' | 'command';
  /**
   * Every API path the main process may reach for this operation, and nothing else. A
   * query value that is an identifier is written `{uuid}` (the call reads of slice C1).
   *
   * Empty for the operations answered from the main process's own state. Several for the
   * ones whose transform reads more than one route — a firm page also reads the sequences
   * it could be enrolled in — because the useful guarantee is the *set of paths this
   * build can call*, and a test walks it: a route the server is about to delete either
   * appears here or has no caller left (`test/operations.test.ts`).
   */
  readonly calls: readonly HttpCall[];
  /**
   * How the answer arrives. Every command answers `{ status, replayed, result }`
   * (`routeSupport`) except `/admin/jobs/requeue`, which predates that shape and answers
   * a plain body — so it says so here rather than being parsed by a client that would
   * read its success as a refusal.
   */
  readonly envelope?: 'accepted' | 'plain';
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /** The main-process work this operation needs, named so the wiring can be checked. */
  readonly transform: string;
}

export const OPERATIONS = {
  // --- Today -------------------------------------------------------------
  'today.state': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: todayStateSchema,
    transform: 'the session snapshot: the encrypted 24-hour cache, stale, online, mayMutate',
  },
  'today.refresh': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/today' }],
    input: refreshInput,
    output: todayStateSchema,
    transform: 'the session manager re-reads the list into the encrypted cache; a quiet read keeps the notice',
  },
  'today.expand': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/today/firm' },
      { method: 'POST', path: '/dial/check' },
      // The approved templates the outcome form may promise on a call (migration 0025).
      { method: 'POST', path: '/templates' },
      // The published sequences a call may agree to (send-path v2, slice S3).
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
    ],
    input: z.strictObject({ firmId: uuid }),
    output: todayStateSchema,
    transform: 'stale expansion from the in-memory page, eviction on 404 or not_assigned, the dial advice per usable number, the approved templates a call may promise and the published sequences it may agree to',
  },
  'today.previewFollowUp': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/calls/follow-up-preview' }],
    input: followUpPreviewInput,
    output: todayStateSchema,
    transform: 'the server’s preview of an agreed sequence for the open card: each step’s template, subject and expected instant',
  },
  'today.callsPlaced': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/today/calls-placed' }],
    input: nothing,
    output: callsPlacedTodayResponseSchema.nullable(),
    transform: 'none: the server’s count for its own business date, or null when the read did not answer',
  },
  'today.collapse': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: todayStateSchema,
    transform: 'forgets the open card, its advice and the URIs behind it',
  },
  'today.snooze': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/today/snooze' }],
    input: snoozeInput,
    output: todayStateSchema,
    transform: 'a datetime-local resolved against the business zone through the domain’s own clock',
  },
  'today.recordOutcome': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/calls/log' },
      // After a stale preview, the fresh one for "Record the agreed dates" (P1-B).
      { method: 'POST', path: '/calls/follow-up-preview' },
    ],
    input: outcomeInput,
    output: todayStateSchema,
    transform: 'the call just handed off names the contact and number; the callback instant is the domain’s; no occurredAt',
  },
  'today.recordAgreedDates': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/follow-up' }],
    input: z.strictObject({ firmId: uuid, callLogId: uuid }),
    output: todayStateSchema,
    transform: 'the pending agreement of a recorded call, sent on the fresh preview the person was read (its basis), after a stale preview',
  },
  'today.scheduleCallback': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/callbacks/schedule' }],
    input: z.strictObject({ callLogId: uuid, localDate: z.string().max(10), localTime: z.string().max(5) }),
    output: todayStateSchema,
    transform: 'the local day and time resolved against the business zone before they leave the Mac',
  },
  'today.releasePause': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/today/pause/release' }],
    input: z.strictObject({ holdId: uuid }),
    output: todayStateSchema,
    transform: 're-reads the list and the open card, keeping the command’s notice',
  },

  'today.completeTask': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/today/tasks/complete' }],
    input: z.strictObject({ taskId: uuid }),
    output: todayStateSchema,
    transform: 're-reads the list and the open card, keeping the command’s notice',
  },

  // --- Calling from Callie (slice C1) -----------------------------------------
  'calling.status': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/calling?firmId={uuid}' }],
    input: z.strictObject({ firmId: uuid }),
    output: callingViewSchema,
    transform: 'tel only on the server’s calling-off answer (not_found); no answer or any other refusal is unavailable, never tel',
  },
  'calling.start': {
    kind: 'command',
    calls: [
      { method: 'GET', path: '/calls/calling?firmId={uuid}' },
      { method: 'POST', path: '/calls/session' },
      { method: 'POST', path: '/calls/access-token' },
    ],
    input: callStartInput,
    output: callStartSchema,
    transform: 'the route version and calling identity from the open card; session, then token; the voicemail script rendered for attempts 1 and 4; the session remembered for the outcome',
  },
  'calling.cancel': {
    kind: 'command',
    calls: [],
    input: callCancelInput,
    output: z.strictObject({ cancelled: z.boolean() }),
    transform: 'the start with this request id, if it is still the current one, is given up: a late session or token binds nothing, and a bound session is unbound; a cancel for an older start changes nothing (cancelled false)',
  },
  'calling.setActive': {
    kind: 'command',
    calls: [],
    input: z.strictObject({ active: z.boolean() }),
    output: z.strictObject({ active: z.boolean() }),
    transform: 'the live-call flag the updater waits on; ending it installs a deferred update',
  },
  'calling.resume': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/calls/cadence/resume' },
      { method: 'GET', path: '/calls/calling?firmId={uuid}' },
      // The open card's advice again: the parking hold had made its numbers not callable.
      { method: 'POST', path: '/dial/check' },
    ],
    input: z.strictObject({ firmId: uuid }),
    output: callingViewSchema,
    transform: 'the review of a parked firm, then its cadence and the open card’s dial advice read again',
  },
  'calling.history': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/history?firmId={uuid}&include=summary,outcome,notes' }],
    input: z.strictObject({ firmId: uuid }),
    output: callHistoryViewSchema,
    transform: 'none: the firm’s placed calls, each with its summary and logged outcome when it has them, or null when the read did not answer',
  },
  'calling.analysis': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/analysis?callSessionId={uuid}' }],
    input: z.strictObject({ callSessionId: uuid }),
    output: analysisViewSchema,
    transform: 'none: one call’s analysis, keyed by its session and never by the open view; null when it has none or the route is absent',
  },
  'calling.analysisRetry': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/calls/analysis/retry' },
      { method: 'GET', path: '/calls/analysis?callSessionId={uuid}' },
    ],
    input: z.strictObject({ callSessionId: uuid, reason: z.enum(['retry', 'reanalysis']) }),
    output: analysisViewSchema,
    transform: 'asks for a new analysis of the call, then reads it back; the server’s refusal code is the reason',
  },
  'calling.analysisEdit': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/analysis/edit' }],
    input: z.strictObject({ callSessionId: uuid, notes: callAnalysisNotesSchema }),
    output: analysisViewSchema,
    transform: 'David’s notes as a new version of the analysis; the answer is the analysis read',
  },
  'calling.proposalsApply': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/proposals/apply' }],
    input: z.strictObject({
      analysisId: uuid,
      transcriptSha256: sha256Hex,
      proposalHash: sha256Hex,
      keys: z.array(callProposalKeySchema).min(1).max(40),
      edits: callProposalEditsSchema.optional(),
      /** The same id for the same click, so a retry is answered from its receipt. */
      commandId: uuid.optional(),
    }),
    output: proposalsApplyViewSchema,
    transform: 'the selected keys of one analysis in one request, with the three identifiers the server checks; a refusal’s code is the reason',
  },
  'calling.proposalsDecline': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/proposals/decline' }],
    input: z.strictObject({
      analysisId: uuid,
      proposalHash: sha256Hex,
      keys: z.array(callProposalKeySchema).min(1).max(40),
    }),
    output: declinedViewSchema,
    transform: 'records the decision only; a declined suggestion stays applicable',
  },
  'calling.pendingDismiss': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/pending/dismiss' }],
    input: z.strictObject({ callSessionId: uuid }),
    output: dismissedViewSchema,
    transform: 'releases the call’s pending-review hold without logging the call',
  },
  'calling.recap': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/recap' }],
    input: nothing,
    output: recapViewSchema,
    transform: 'none: the day’s recap, or null when the read did not answer (the block is then hidden)',
  },
  'calling.acceptance': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/proposals/acceptance' }],
    input: nothing,
    output: acceptanceViewSchema,
    transform: 'none: the per-type acceptance counts, read-only; null when the read did not answer',
  },
  'calling.trial': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/trial' }],
    input: nothing,
    output: trialViewSchema,
    transform: 'none: the 10-call trial since the 3a release, read-only; null when the read did not answer',
  },
  'review.list': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/review' }],
    input: nothing,
    output: reviewViewSchema,
    transform: 'none: Needs review’s three sources as the server lists them; null when the API does not serve it; failed when it did not answer (the page keeps its last list)',
  },
  'review.stageResolve': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/review/stage/resolve' }],
    input: z.strictObject({ itemId: uuid }),
    output: resolvedViewSchema,
    transform: 'resolves one stage review item by id',
  },
  'suppressions.firmStop': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/suppressions/record' }],
    // Migration 0037: `phone` is "stop calls to this firm", `all` is "stop all contact with
    // this firm". Absent sends no channel, which the server reads as `all`.
    input: z.strictObject({ firmId: uuid, channel: z.enum(['phone', 'all']).optional() }),
    output: stoppedViewSchema,
    transform: 'sends scope firm, the firm, source prospect_do_not_call and the channel when one is chosen, and nothing else; the explicit confirm is the caller’s',
  },
  // --- S3X lane X2: correcting a logged outcome -----------------------------------
  'calling.logs': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls?firmId={uuid}&include=corrections' }],
    input: z.strictObject({ firmId: uuid }),
    output: callLogsViewSchema,
    transform: 'none: every call log of the firm from the database alone, each with its corrections; null when the read did not answer',
  },
  'calling.correctionPreview': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/calls/logs/correction-preview' }],
    input: correctionPreviewRequestSchema,
    output: correctionPreviewViewSchema,
    transform: 'none: what correcting this log to this outcome would meet, or the refusal code',
  },
  'calling.correctOutcome': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/logs/correct' }],
    input: correctOutcomeInputSchema,
    output: correctedViewSchema,
    transform: 'the review’s body under the renderer’s own command id, so a retry is answered from its receipt; a refusal’s code is the reason',
  },
  'suppressions.supersede': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/suppressions/supersede' }],
    input: z.strictObject({ eventId: z.string().min(1).max(200), commandId: uuid }),
    output: liftedViewSchema,
    transform: 'the existing single-stop lift, reason correction, under the renderer’s command id; the explicit confirm is the caller’s',
  },
  'calling.recording': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/recording?sessionId={uuid}' }],
    input: z.strictObject({ sessionId: uuid }),
    output: callRecordingViewSchema,
    transform: 'none: the audio the API proxied from Twilio, never a URL',
  },
  'calling.transcript': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/calls/transcript?callSessionId={uuid}' }],
    input: z.strictObject({ callSessionId: uuid }),
    output: callTranscriptViewSchema,
    transform: 'the API’s 404 becomes "no transcript" (nothing shown); any other refusal is its code',
  },

  'sourcing.learning': {kind:'read',calls:[{method:'POST',path:'/sourcing/learning'}],input:learningInputSchema,output:z.object({view:learningReportSchema.nullable(),reason:z.string().nullable()}),transform:'Current accepted outcomes for first-contact cohorts'},
  'sourcing.targeting': {kind:'read',calls:[{method:'POST',path:'/sourcing/targeting'}],input:z.strictObject({}),output:z.object({view:targetingViewSchema.nullable(),reason:z.string().nullable()}),transform:'Active search policy and pending approved changes'},
  'sourcing.proposeTargeting': {kind:'command',calls:[{method:'POST',path:'/sourcing/targeting/save'}],input:targetingProposalSchema.safeExtend({commandId:uuid}),output:z.object({result:z.object({id:uuid,revision:z.number().int().positive()}).nullable(),reason:z.string().nullable()}),transform:'Save a targeting proposal without applying it'},
  'sourcing.applyTargeting': {kind:'command',calls:[{method:'POST',path:'/sourcing/targeting/apply'}],input:targetingApplySchema.extend({commandId:uuid}),output:z.object({result:z.object({policyVersion:z.string()}).nullable(),reason:z.string().nullable()}),transform:'Explicit admin approval changes future discovery and new-lead ordering'},
  'sourcing.feedback': {
    kind:'command',calls:[{method:'POST',path:'/sourcing/qualification/feedback'}],
    input:sourcingFeedbackSchema.extend({commandId:uuid}),
    output:z.object({result:sourcingFeedbackSavedSchema.nullable(),reason:z.string().nullable()}),
    transform:'Record feedback against the evidence shown without changing stops or deals',
  },
  'sourcing.firmQualification': {
    kind:'read',calls:[{method:'POST',path:'/sourcing/qualification/firm'}],input:firmQualificationReadSchema,
    output:z.object({view:qualificationViewSchema.nullable(),reason:z.string().nullable()}),
    transform:'Sourcing evidence attached explicitly to this firm',
  },
  'sourcing.qualification': {
    kind: 'read', calls: [{method:'POST',path:'/sourcing/qualification/read'}],
    input: qualificationReadSchema,
    output: z.object({view:qualificationViewSchema.nullable(),reason:z.string().nullable()}),
    transform: 'Read current evidence and historical observations',
  },
  'sourcing.qualify': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/qualification/request'}],
    input: qualificationRequestSchema.extend({commandId:uuid}),
    output: z.object({result:qualificationQueuedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'Queue bounded research against the displayed candidate revision',
  },
  'sourcing.admit': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/qualification/admit'}],
    input: qualificationAdmissionSchema.extend({commandId:uuid}),
    output: z.object({result:qualificationAdmittedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'Explicit reviewed admission without starting outreach',
  },
  'sourcing.list': {
    kind: 'read', calls: [{method:'POST',path:'/sourcing/candidates/list'}],
    input: candidateListInputSchema,
    output: z.object({view:candidateListSchema.nullable(),reason:z.string().nullable()}),
    transform: 'workspace-scoped candidate drafts; source evidence remains unverified',
  },
  'sourcing.save': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/candidates/save'}],
    input: candidateInputSchema.extend({commandId:uuid}),
    output: z.object({result:candidateSavedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'save or deduplicate a candidate without opening a firm, deal or enrollment',
  },
  'sourcing.review': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/candidates/review'}],
    input: candidateReviewInputSchema.extend({commandId:uuid}),
    output: z.object({result:candidateChangedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'revision-checked human research triage, never automatic verification',
  },
  'sourcing.check': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/candidates/check'}],
    input: candidateDeleteInputSchema.extend({commandId:uuid}),
    output: z.object({result:candidateChangedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'revision-checked removal of an independent candidate draft',
  },
  'sourcing.delete': {
    kind: 'command', calls: [{method:'POST',path:'/sourcing/candidates/delete'}],
    input: candidateDeleteInputSchema.extend({commandId:uuid}),
    output: z.object({result:candidateChangedSchema.nullable(),reason:z.string().nullable()}),
    transform: 'revision-checked removal of an independent candidate draft',
  },

  // --- Research (lane R) --------------------------------------------------
  'research.state': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: researchStateSchema,
    transform: 'the research last read; nothing about it is ever written to disk',
  },
  'research.open': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/research/firm' },
      { method: 'POST', path: '/research/settings' },
      { method: 'GET', path: '/settings/finishing' },
    ],
    input: z.strictObject({ firmId: uuid }),
    output: researchStateSchema,
    transform: 'the firm’s brief, facts, runs and links, plus the ceilings and the month’s spend for an admin',
  },
  'research.run': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/research/firm/run' },
      { method: 'POST', path: '/research/firm' },
    ],
    input: z.strictObject({ firmId: uuid }),
    output: researchStateSchema,
    transform: 're-reads the firm keeping the command’s notice: a queued run is a running row, not a brief',
  },
  'research.addLink': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/research/firm/links/add' },
      { method: 'POST', path: '/research/firm' },
    ],
    input: z.strictObject({ firmId: uuid, url: z.string().min(8).max(500) }),
    output: researchStateSchema,
    transform: 're-reads the firm keeping the command’s notice; the link is saved even when the run it triggers refuses',
  },
  'research.saveSettings': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/research/settings' },
      { method: 'GET', path: '/settings/finishing' },
    ],
    input: researchSettingsInput,
    output: researchStateSchema,
    transform: 'one admin-only path answers both the read and the update; a salesperson is given no settings at all',
  },

  // --- Replies -----------------------------------------------------------
  'replies.state': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: replyStateSchema,
    transform: 'the lane as last read; nothing about replies is ever written to disk',
  },
  'replies.refresh': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/replies' },
      { method: 'POST', path: '/replies/settings' },
    ],
    input: nothing,
    output: replyStateSchema,
    transform: 'the lane and the classifier settings; a failed read empties the lane rather than keeping a card',
  },
  'replies.open': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/replies/card' }],
    input: z.strictObject({ messageId: uuid }),
    output: replyStateSchema,
    transform: 'the card is held only while it is open, and never cached',
  },
  'replies.forget': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: replyStateSchema,
    transform: 'drops the lane, the open card and the one body held for it; a read still in flight will not store what it brings back',
  },
  'replies.collapse': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: replyStateSchema,
    transform: 'forgets the open card',
  },
  'replies.confirm': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/replies/confirm' },
      { method: 'POST', path: '/replies' },
      { method: 'POST', path: '/replies/settings' },
    ],
    input: confirmReplyInput,
    output: replyStateSchema,
    transform: 'the wall-clock callback resolved against the business zone; the model’s proposal is never substituted',
  },
  'replies.resolve': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/messages/resolve-ambiguity' },
      { method: 'POST', path: '/replies/card' },
      { method: 'POST', path: '/replies' },
      { method: 'POST', path: '/replies/settings' },
    ],
    input: z.strictObject({ messageId: uuid, opportunityId: uuid }),
    output: replyStateSchema,
    transform: 'refuses a candidate that is not one of this card’s own before it asks the server',
  },

  // --- Settings › Reply suggestions (slice 3a, C0) -------------------------
  'replies.model': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/replies/settings' }],
    input: nothing,
    output: replyModelStateSchema,
    transform: 'the model, the effort and whether suggestions are on, and nothing else; the caps stay on the server',
  },
  'replies.saveModel': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/replies/settings/update' },
      { method: 'POST', path: '/replies/settings' },
    ],
    input: z.strictObject({ modelName: z.enum(REPLY_MODELS) }),
    output: replyModelStateSchema,
    transform: 'sends the model name alone, never the effort or a cap, then reads the setting back',
  },

  // --- Settings › Diagnostics --------------------------------------------
  'diagnostics.sendStatus': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/outbound/status' }],
    input: z.strictObject({ outboundMessageId: uuid }),
    output: z.object({ fence: fenceStatusSchema }),
    transform: 'the fence alone, without the subject or the body the status read never carries',
  },
  'diagnostics.resolveSend': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/outbound/resolve' }],
    input: z.strictObject({ outboundMessageId: uuid, resolution: z.enum(['delivered', 'skipped']) }),
    output: resolvedSendSchema,
    transform: 'none: 12.5’s admin decision, sent as the command it is',
  },
  'diagnostics.deadJobs': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/admin/jobs/dead' }],
    input: nothing,
    output: deadJobsSchema,
    transform: 'none: the list as the server has it',
  },
  'diagnostics.requeueJob': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/admin/jobs/requeue' }],
    envelope: 'plain',
    input: z.strictObject({ jobId: uuid, reason: z.string().trim().min(1).max(500) }),
    output: requeuedSchema,
    transform: 'its own parser: this route answers a plain body, not the accepted envelope',
  },

  // --- Firms -------------------------------------------------------------
  'crm.state': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/pipeline/board' },
      { method: 'GET', path: '/pipeline/stages' },
    ],
    input: nothing,
    output: crmStateSchema,
    transform: 'the screen the main process holds; the board is read once if it holds neither a board nor a firm',
  },
  'crm.openFirm': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: firmId,
    output: crmStateSchema,
    transform: 'the firm page at its declared version, plus the sequences it could be enrolled in; a failed slice says so rather than reading as none',
  },
  // S4F: one older page of a firm's activity timeline. Not a screen: the answer is the page
  // alone (or null when the read did not answer), and nothing the bridge holds changes.
  'crm.firmTimeline': {
    kind: 'read',
    calls: [{ method: 'POST', path: '/crm/firm-page' }],
    input: z.strictObject({ firmId: uuid, before: z.string().min(1).max(120) }),
    output: z.strictObject({ timeline: firmTimelineSchema.nullable() }),
    transform: 'the firm page read with only the timeline negotiated, and only its timeline kept; null when the caller is not the firm\'s assignee or an admin',
  },
  'crm.openPipeline': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/pipeline/board' },
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/firms' },
    ],
    input: openPipelineInput,
    output: crmStateSchema,
    transform: 'the board (Lost only when includeLost is set, and remembered until a read says otherwise), or the two reads that built it before the board endpoint, with the opportunity ids a firm page has already shown',
  },
  'crm.openAddFirm': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: crmStateSchema,
    transform: 'the empty form, and the file a half-finished import was holding is let go',
  },
  'crm.openImport': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: crmStateSchema,
    transform: 'the empty import screen, and the file a half-finished import was holding is let go',
  },
  'crm.addFirm': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/crm/firms/add' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
    ],
    input: addFirmDraftSchema,
    output: crmStateSchema,
    transform: 'a blank field is left out and a blank contact is no contact; a refusal comes back as the form with every field the server named',
  },
  'crm.commitImport': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/import/commit' }],
    input: nothing,
    output: crmStateSchema,
    transform: 'the file the main process is holding, with the command id minted per row at the preview, so a second press replays rather than imports twice',
  },
  'crm.saveContact': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/contacts/update' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
    ],
    input: contactEditInput,
    output: crmStateSchema,
    transform: 'the route\u2019s patch shape, with an emptied title as the explicit null that clears it',
  },
  'crm.changeStage': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/opportunities/stage' },
      { method: 'POST', path: '/pipeline/board' },
      { method: 'GET', path: '/pipeline/stages' },
    ],
    input: stageChangeInput,
    output: crmStateSchema,
    transform: 'an absent reason is left out of the body, and the board is read again when the change landed',
  },
  'crm.setValue': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/opportunities/value' },
      { method: 'POST', path: '/pipeline/board' },
      { method: 'GET', path: '/pipeline/stages' },
    ],
    input: valueChangeInput,
    output: crmStateSchema,
    transform: 'the amount in whole cents and its kind; the board is read again when the value landed',
  },
  'crm.resolveMerge': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/merges/firms' },
      { method: 'GET', path: '/firms' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/enrollments' },
      { method: 'POST', path: '/sequences/versions' },
    ],
    input: mergeResolutionInput,
    output: crmStateSchema,
    transform: 'a refusal carrying conflicts becomes the conflict screen, with both firms named from what this window already holds',
  },
  'crm.openOpportunity': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/opportunities/open' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    // Lane M1: `stageKey` opens it at "Demo booked" from the firm's one-click suggestion, for
    // `firmId`, the firm whose suggestion was drawn (review M1R, finding 2): a stage always
    // names its firm, so the open never lands on whichever page the bridge read last.
    input: z
      .strictObject({ firmId: uuid.optional(), stageKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u).optional() })
      .refine(input => input.stageKey === undefined || input.firmId !== undefined, {
        message: 'a stage names the firm it opens for',
      }),
    output: crmStateSchema,
    transform: 'the open firm page\u2019s own id; with a stage, the firm the window drew the suggestion for (lane M1: the page the bridge read last may be another firm\u2019s, and the server decides who may open one); the stage it opens at, when one is named',
  },
  'crm.takeOver': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/opportunities/manual' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: takeOverInput,
    output: crmStateSchema,
    transform: 'the open firm page\u2019s own opportunity, and a reason the person typed',
  },
  'crm.resolveOutgoing': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/messages/resolve-ambiguity' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: resolveOutgoingInput,
    output: crmStateSchema,
    transform: 'refuses a message or a firm the open page did not show before it asks the server; human is always false',
  },
  'crm.enroll': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/enrollments/enroll' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: enrollInput,
    output: crmStateSchema,
    transform: 'the firm and its open opportunity are the page\u2019s, not the window\u2019s; a closed one is refused before the server is asked',
  },
  'crm.checkRoute': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/contacts/routes/check' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'POST', path: '/messages/held-outgoing' },
    ],
    input: checkRouteInput,
    output: crmStateSchema,
    transform: 'the route\u2019s refusals said about an address rather than about a number',
  },

  // --- Sequences ---------------------------------------------------------
  'sequences.state': {
    kind: 'read',
    calls: [
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: nothing,
    output: sequenceStateSchema,
    transform: 'four reads in one pass; a slice that failed is empty and says which read failed, rather than reading as none',
  },
  'sequences.openSequence': {
    kind: 'read',
    calls: [
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: z.strictObject({ sequenceId: uuid }),
    output: sequenceStateSchema,
    transform: 'the chosen sequence is remembered, and its versions are the slice read again',
  },
  'sequences.createSequence': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/sequences/create' },
      { method: 'POST', path: '/sequences/versions/draft' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: z.strictObject({ name: z.string().trim().min(1).max(200) }),
    output: sequenceStateSchema,
    transform: 'the named plan and its first empty version, in two receipted commands, then the sequence opened',
  },
  'sequences.saveSteps': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/sequences/versions/steps' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: saveStepsInput,
    output: sequenceStateSchema,
    transform: 'the steps numbered by their place, each carrying exactly the field its channel takes; a published version is edited in place and the edit reaches its live enrollments',
  },
  'sequences.saveTemplate': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/templates/create' },
      { method: 'POST', path: '/templates/update' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: templateDraftInput,
    output: sequenceStateSchema,
    transform: 'the sign-off appended, the variables the text names declared, and approve in the same command',
  },
  'sequences.publish': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/sequences/versions/publish' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: versionInput,
    output: sequenceStateSchema,
    transform: 'none: the version as saved, and the server decides',
  },
  'sequences.retire': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/sequences/versions/retire' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/templates' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: versionInput,
    output: sequenceStateSchema,
    transform: 'none: the version as saved, and the server decides',
  },

  // --- Settings ----------------------------------------------------------
  'settings.state': {
    kind: 'read',
    calls: [
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/diagnostics' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: nothing,
    output: adminStateSchema,
    transform: 'what the main process holds, read once; an admin whose sending status is not held asks for it again',
  },
  'settings.show': {
    kind: 'read',
    calls: [
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/diagnostics' },
      { method: 'POST', path: '/dashboard' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: z.strictObject({ screen: z.enum(SETTINGS_TAB_SCREENS) }),
    output: adminStateSchema,
    transform: 'the tab\u2019s reads, the postal address asked for by name, and everything read under a role that has since changed is dropped',
  },
  'settings.saveSetting': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/settings/update' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: saveSettingInputSchema,
    output: adminStateSchema,
    transform: 'an empty note is sent as "Changed on the Mac"; the slice is read again rather than patched from the answer',
  },
  'settings.saveIntegration': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/settings/update' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: saveIntegrationInputSchema,
    output: adminStateSchema,
    transform: 'one of the four call-to-booking settings, written with the standard note; the integrations are read again, and a refusal stays on the section rather than the page banner',
  },
  'settings.openHistory': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/settings/history' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: z.strictObject({ settingKey: saveSettingInputSchema.shape.settingKey }),
    output: adminStateSchema,
    transform: 'the whole answer, values included, so History can say what changed and not only when',
  },
  'settings.loadDashboard': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/dashboard' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: z.strictObject({ from: z.string().max(40), to: z.string().max(40) }),
    output: adminStateSchema,
    transform: 'the window asked for, without moving the tab on screen; a failed read leaves the figures in place',
  },
  'settings.retireStage': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/pipeline/stages/retire' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: z.strictObject({ stageKey: z.string().min(1).max(80) }),
    output: adminStateSchema,
    transform: 'none: the stages are read again from the settings snapshot',
  },
  'settings.acknowledgeAlert': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/admin/alerts/acknowledge' },
      { method: 'GET', path: '/diagnostics' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: z.strictObject({ alertId: uuid }),
    output: adminStateSchema,
    transform: 'its own client: the acknowledge is audited but not receipted, so it carries no command id',
  },
  'settings.setSendingCap': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/outbound/cap' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: setSendingCapInputSchema,
    output: adminStateSchema,
    transform: 'absent and null are kept apart, because null clears a lowering and absent leaves it; nothing is clamped',
  },
  'settings.recordSendingAuthentication': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/outbound/authentication' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: recordSendingAuthenticationInputSchema,
    output: adminStateSchema,
    transform: 'none: 12.7\u2019s checklist is a person recording that they looked, and FSS never queries DNS',
  },
  'settings.recordHolidayCalendar': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/sequences/holidays' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/settings/integrations?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording' },
    ],
    input: recordHolidayCalendarInputSchema,
    output: adminStateSchema,
    transform: 'the calendar is superseded rather than edited, and is read back through the settings snapshot that carries it',
  },
  'settings.addCallingNumber': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/calling-identities/register' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: addCallingNumberInputSchema,
    output: adminStateSchema,
    transform: 'the number as typed, with a blank label left out; the register attests it, so there is no second command',
  },
  'settings.retireCallingNumber': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/calling-identities/disable' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: z.strictObject({ identityId: uuid }),
    output: adminStateSchema,
    transform: 'none: the row stays, because call logs reference it',
  },
  'settings.allowStates': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/postures/allow' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: allowStatesInputSchema,
    output: adminStateSchema,
    transform: 'one confirmation for every state named, with a blank note left out; the server copies the statements and the citations from the release',
  },
  'settings.revokePosture': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/postures/revoke' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
      { method: 'GET', path: '/settings/finishing' },
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
    ],
    input: z.strictObject({ postureId: uuid }),
    output: adminStateSchema,
    transform: 'none: the list is read again, and calls to that state wait until a new posture is recorded',
  },

  // --- The Mailbox row on This Mac ---------------------------------------
  'mailbox.state': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/gmail/status' }],
    input: nothing,
    output: mailboxStateSchema,
    transform: 'the status as last read, without the consent URL, which never crosses this boundary',
  },
  'mailbox.refresh': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/gmail/status' }],
    input: nothing,
    output: mailboxStateSchema,
    transform: 'reads the status again and stops waiting for a grant, if it was waiting',
  },
  'mailbox.connect': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/gmail/connect' },
      { method: 'GET', path: '/gmail/status' },
    ],
    input: nothing,
    output: mailboxStateSchema,
    transform: 'the consent screen is opened by the system browser from the main process, and the status is polled until the grant lands or expires',
  },
  'mailbox.switch': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/gmail/connect' },
      { method: 'GET', path: '/gmail/status' },
    ],
    input: z.strictObject({ switchTo: z.email().max(320) }),
    output: mailboxStateSchema,
    transform:
      'the same consent flow as connect, asking Google for the named account; the status is polled until that address is the connected one, this attempt is refused, or its grant expires',
  },

  // --- Meetings (slice M1) ------------------------------------------------
  // Straight through the authenticated client, like Diagnostics: no state is kept.
  'meetings.forFirm': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/meetings/firm?firmId={uuid}' }],
    input: z.strictObject({ firmId: uuid }),
    output: z.strictObject({ meetings: z.array(firmMeetingDtoSchema).nullable(), stageSuggestion: stageSuggestionSchema.nullable() }),
    transform:
      'none: the firm’s meetings with their state, time and how attendance was confirmed, and the one-click stage move a live booking suggests (lane M1); meetings null when the read did not answer',
  },
  // Lane M2: the meeting brief, opened from a Meetings row.
  'meetings.recordingSetup': {
    kind:'read',calls:[{method:'GET',path:'/meetings/recording-setup?meetingId={uuid}'}],input:z.strictObject({meetingId:uuid}),
    output:z.strictObject({view:meetingRecordingSetupViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'current recording setting, never a claim that audio exists',
  },
  'meetings.retryRecordingSetup': {
    kind:'command',calls:[{method:'POST',path:'/meetings/recording-setup/retry'}],input:retryMeetingRecordingSetupSchema.extend({commandId:uuid}),
    output:z.strictObject({view:meetingRecordingSetupViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'audited versioned retry with retained command identity',
  },
  'meetings.followThrough': {
    kind:'read', calls:[{method:'GET',path:'/meetings/follow-through?meetingId={uuid}'}],input:z.strictObject({meetingId:uuid}),
    output:z.strictObject({view:meetingFollowThroughViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'current recap and follow-through, never cached on disk',
  },
  'meetings.editRecap': {
    kind:'command',calls:[{method:'POST',path:'/meetings/recap/edit'}],
    input:z.discriminatedUnion('action',[meetingDraftEditSchema.options[0].extend({commandId:uuid}),meetingDraftEditSchema.options[1].extend({commandId:uuid}),meetingDraftEditSchema.options[2].extend({commandId:uuid}),meetingDraftEditSchema.options[3].extend({commandId:uuid})]),
    output:z.strictObject({view:meetingFollowThroughViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'durable edit hold and versioned save, discard or cancellation',
  },
  'meetings.qualification': {
    kind:'read',calls:[{method:'GET',path:'/meetings/qualification?meetingId={uuid}'}],input:z.strictObject({meetingId:uuid}),
    output:z.strictObject({view:meetingQualificationViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'current commercial qualification, derived from accepted evidence and attendance',
  },
  'meetings.saveQualification': {
    kind:'command',calls:[{method:'POST',path:'/meetings/qualification/save'}],input:saveMeetingQualificationSchema,
    output:z.strictObject({view:meetingQualificationViewSchema.nullable(),reason:z.string().max(80).nullable()}),transform:'optional versioned qualification confirmation; no stage or outreach changes',
  },
  'meetings.outcomes': {
    kind: 'read', calls: [{ method: 'GET', path: '/meetings/outcomes?meetingId={uuid}' }], input: z.strictObject({ meetingId: uuid }),
    output: z.strictObject({ view: meetingOutcomesViewSchema.nullable(), reason: z.string().max(80).nullable() }), transform: 'current correctable meeting notes and tasks, never cached on disk',
  },
  'meetings.saveNotes': {
    kind: 'command', calls: [{ method: 'POST', path: '/meetings/notes' }], input: saveMeetingNotesSchema.safeExtend({ commandId: uuid }),
    output: z.strictObject({ notes: meetingNotesRevisionSchema.nullable(), reason: z.string().max(80).nullable() }), transform: 'versioned notes save with retained command identity',
  },
  'meetings.changeTask': {
    kind: 'command', calls: [{ method: 'POST', path: '/meetings/tasks/change' }],
    input: z.discriminatedUnion('action', [changeMeetingTaskSchema.options[0].extend({ commandId: uuid }), changeMeetingTaskSchema.options[1].extend({ commandId: uuid }), changeMeetingTaskSchema.options[2].extend({ commandId: uuid })]),
    output: z.strictObject({ task: meetingTaskViewSchema.nullable(), reason: z.string().max(80).nullable() }), transform: 'versioned edit, completion or cancellation of a meeting task',
  },
  'meetings.brief': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/meetings/brief?meetingId={uuid}&include=meeting_tasks' }],
    input: z.strictObject({ meetingId: uuid }),
    output: z.strictObject({ brief: meetingBriefResponseSchema.nullable(), reason: z.string().max(80).nullable() }),
    transform: 'none: the brief, or null with the reason when the read did not answer (not_found for a meeting the caller may not read)',
  },
  'meetings.unmatched': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/meetings/unmatched' }],
    input: nothing,
    output: z.strictObject({ meetings: z.array(unmatchedMeetingDtoSchema).nullable() }),
    transform: 'none: the bookings no firm is attached to, or null when the read did not answer',
  },
  'meetings.match': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/meetings/match' }],
    input: z.strictObject({ meetingId: uuid, firmId: uuid }),
    output: z.strictObject({ matched: meetingMatchedSchema.nullable(), reason: z.string().max(80).nullable() }),
    transform: 'none: the match, or the refusal code the window turns into a sentence',
  },
  'meetings.setAttendance': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/meetings/attendance' }],
    input: z.strictObject({ meetingId: uuid, attendance: z.enum(MEETING_ATTENDANCE_CHOICES), commandId: uuid }),
    output: z.strictObject({ set: meetingAttendanceSetSchema.nullable(), reason: z.string().max(80).nullable() }),
    transform:
      'lane M1: Attended, No-show or Undo for one meeting under the renderer’s own command id, so a retry is answered from its receipt; a refusal’s code is the reason',
  },

  // --- Slice S2: the firm's calling basics, and an incoming call ----------------
  // Straight through the authenticated client, like Meetings: each answers its own small
  // shape, and the view that asked (Today, or the firm page) reads its own state again.
  'firms.saveBasics': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/crm/firms/basics' }],
    input: firmBasicsInput,
    output: firmBasicsAnswerSchema,
    transform: 'none: the saved basics and what still blocks a call, or the refusal code and every field at fault',
  },
  'calls.logIncoming': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/calls/log' }],
    input: incomingCallInput,
    output: incomingCallAnswerSchema,
    transform: 'direction inbound and nothing a placed call binds: no ticket, session, route or calling identity',
  },

  // --- Lane PB: importing prepared briefs from a JSON file ----------------------------
  // Briefs are read-only in Callie; a corrected file is the only change path. The import is
  // held in the main process (`main/briefImport.ts`); the file is chosen on its own channel,
  // `IMPORT_IPC_CHANNELS.chooseBriefs`.
  'firms.briefImportState': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: briefImportViewSchema,
    transform: 'the prepared-brief import the main process is holding: the preview and any results, never the text',
  },
  'firms.briefImportCommit': {
    kind: 'command',
    calls: [{ method: 'POST', path: '/firms/brief/import' }],
    input: z.strictObject({ previewId: z.number().int().min(1) }),
    output: briefImportViewSchema,
    transform: 'one import command with the valid rows of the preview on screen, under the id minted at that preview, so a second press replays',
  },
  'firms.briefImportReset': {
    kind: 'command',
    calls: [],
    input: nothing,
    output: briefImportViewSchema,
    transform: 'lets the file and its preview go',
  },

  // --- Lane M4: importing demo recordings ------------------------------------------------
  // Held in the main process (`main/recordings/importer.ts`), which watches the folder and
  // uploads on its own: its traffic (`GET /meetings/recordings/candidates`, `POST
  // /meetings/recordings/upload-url`, `POST /meetings/recordings/register`) is that module's,
  // as `POST /today` is the session manager's, and none of these four reaches the server
  // itself. An item is named by its opaque id, never by a path. Choosing the folder and
  // importing one by hand are channels (`IMPORT_IPC_CHANNELS`): macOS's panel.
  'recordings.state': {
    kind: 'read',
    calls: [],
    input: nothing,
    output: recordingsViewSchema,
    transform: 'the import the main process holds: the folder, and the folders that overlapped a Callie meeting, never any other',
  },
  'recordings.chooseMeeting': {
    kind: 'command',
    calls: [],
    input: z.strictObject({ itemId: recordingItemIdSchema, meetingId: uuid }),
    output: recordingsViewSchema,
    transform: 'attaches a folder to one of the meetings it overlapped, and queues its upload; any other meeting is refused',
  },
  'recordings.ignore': {
    kind: 'command',
    calls: [],
    input: z.strictObject({ itemId: recordingItemIdSchema }),
    output: recordingsViewSchema,
    transform: '“Not a Callie demo”: the folder is never uploaded or shown again',
  },
  'recordings.retry': {
    kind: 'command',
    calls: [],
    input: z.strictObject({ itemId: recordingItemIdSchema }),
    output: recordingsViewSchema,
    transform: 'a failed folder is listed and evaluated afresh, and every file sent again under new commands',
  },
  // M4 reset, R4: the firm's registered recordings, from the server's rows (which follow a
  // fold, and show another Mac's uploads), straight through the authenticated client.
  'meetings.transcript': {
    kind: 'read', calls: [{ method: 'GET', path: '/meetings/transcript?meetingId={uuid}' }, { method: 'GET', path: '/meetings/transcript?meetingId={uuid}&cursor={string}' }],
    input: z.strictObject({ meetingId: uuid, cursor: z.string().max(500).optional() }),
    output: z.strictObject({ page: meetingTranscriptPageSchema.nullable(), reason: z.string().nullable() }),
    transform: 'bounded source-grouped transcript page, or an explicit reason',
  },
  'recordings.recoveries': {
    kind: 'read', calls: [{ method: 'GET', path: '/meetings/recordings/recovery' }], input: z.strictObject({}),
    output: recordingRecoveriesSchema.extend({ items: recordingRecoveriesSchema.shape.items.nullable() }),
    transform: 'only missing recordings that need a reupload, or null on a failed read',
  },
  'recordings.reupload': {
    kind: 'command', calls: [{ method: 'POST', path: '/meetings/recordings/recovery-url' }, { method: 'POST', path: '/meetings/recordings/recovery-complete' }], input: z.strictObject({ recordingId: uuid }), output: recordingRecoveryViewSchema,
    transform: 'recover the same recording from its retained local source; never receives a path',
  },
  'recordings.forFirm': {
    kind: 'read',
    calls: [{ method: 'GET', path: '/meetings/recordings?firmId={uuid}' }],
    input: z.strictObject({ firmId: uuid }),
    output: z.strictObject({ recordings: z.array(firmRecordingSchema).nullable(), truncated: z.boolean() }),
    transform: 'none: the registered recordings of the firm’s meetings, or null when the read did not answer',
  },
} as const satisfies Readonly<Record<string, Operation>>;

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as readonly OperationName[];

/** One of the operations, or null. Compared with each literal, so `__proto__` is refused. */
export function operationOf(value: unknown): OperationName | null {
  return OPERATION_NAMES.find(name => name === value) ?? null;
}

export type OperationInput<N extends OperationName> = z.infer<(typeof OPERATIONS)[N]['input']>;
export type OperationOutput<N extends OperationName> = z.infer<(typeof OPERATIONS)[N]['output']>;

export type ReadOperation = {
  [N in OperationName]: (typeof OPERATIONS)[N]['kind'] extends 'read' ? N : never;
}[OperationName];
export type CommandOperation = {
  [N in OperationName]: (typeof OPERATIONS)[N]['kind'] extends 'command' ? N : never;
}[OperationName];

/** The two channels the whole registry travels on, and the two handoffs beside them. */
export const OPERATION_IPC_CHANNELS = {
  read: 'callie:op:read',
  command: 'callie:op:command',
} as const;

export const DIAL_IPC_CHANNELS = { call: 'callie:dial:call' } as const;

/** Choosing a CSV to import: macOS's open dialog, which belongs to the main process. */
export const IMPORT_IPC_CHANNELS = {
  choose: 'callie:import:choose',
  chooseBriefs: 'callie:import:choose-briefs',
  // Lane M4: the demo recordings folder to watch, and one folder imported by hand.
  chooseRecordingsFolder: 'callie:import:choose-recordings-folder',
  importRecordingFolder: 'callie:import:import-recording-folder',
  chooseRecordingRecoveryFile: 'callie:import:choose-recording-recovery-file',
} as const;

/**
 * What the renderer is given. Two functions and a closed vocabulary: a view that wants
 * something the list does not offer has to add it here, in front of whoever reviews it.
 */
export interface OperationApi {
  read<N extends ReadOperation>(operation: N, input: OperationInput<N>): Promise<OperationOutput<N>>;
  command<N extends CommandOperation>(operation: N, input: OperationInput<N>): Promise<OperationOutput<N>>;
}

/** Dialling: its own channel, because it opens a URI rather than answering with one. */
export interface DialBridge {
  call(input: { readonly firmId: string; readonly contactId: string | null; readonly routeId: string }): Promise<
    OperationOutput<'today.state'>
  >;
}

/**
 * Importing a CSV: its own channel, because the file is chosen in macOS's open dialog.
 *
 * It takes nothing and answers the Firms state. The dialog, the read and the preview all
 * happen in the main process, so the file's text never crosses the bridge — a page that
 * cannot name a path cannot ask for one, and a page that never holds the CSV cannot leak
 * it. Cancelling the dialog is the state unchanged.
 */
export interface ImportBridge {
  choose(): Promise<OperationOutput<'crm.state'>>;
  /**
   * Lane PB: choose a prepared-brief JSON file. The same rule: the main process opens the
   * panel, reads and previews the file, and answers the preview, never the briefs.
   */
  chooseBriefs(): Promise<OperationOutput<'firms.briefImportState'>>;
  /**
   * Lane M4: choose the demo recordings folder this Mac watches, and import one recording
   * folder by hand (the same pipeline, the same rule: a folder overlapping no Callie meeting
   * is never read). The main process opens the panel; the window is given the import's view.
   */
  chooseRecordingsFolder(): Promise<OperationOutput<'recordings.state'>>;
  importRecordingFolder(): Promise<OperationOutput<'recordings.state'>>;
  chooseRecordingRecoveryFile(recordingId: string): Promise<OperationOutput<'recordings.reupload'>>;
}

declare global {
  var callieApi: OperationApi | undefined;
  var callieDial: DialBridge | undefined;
  var callieImport: ImportBridge | undefined;
}
