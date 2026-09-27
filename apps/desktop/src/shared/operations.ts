import { z } from 'zod';
import { CALL_OUTCOMES, instant, uuid } from '@fss/contracts';
import { crmStateSchema, addFirmDraftSchema } from '../renderer/firmWorkspaceContract.ts';
import { replyStateSchema, REPLY_DISPOSITIONS } from '../renderer/replyContract.ts';
import { draftStepSchema, sequenceStateSchema } from '../renderer/sequenceContract.ts';
import { todayStateSchema } from '../renderer/todayContract.ts';
import {
  addCallingNumberInputSchema,
  adminStateSchema,
  allowStatesInputSchema,
  recordHolidayCalendarInputSchema,
  recordSendingAuthenticationInputSchema,
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

const stageChangeInput = z.strictObject({
  opportunityId: uuid,
  toStageKey: z.string().min(1).max(80),
  /** Section 8.1: a Lost change requires one. The server enforces it; this sends it. */
  reason: z.string().max(500).nullable(),
});

const mergeResolutionInput = z.strictObject({
  sourceFirmId: uuid,
  targetFirmId: uuid,
  /** Field name to the chosen value, one per conflict the API listed. */
  resolutions: z.record(z.string().max(80), z.string().max(2000)),
});

const enrollInput = z.strictObject({ sequenceVersionId: uuid, contactId: uuid });

/** "Check again" on an address, at the version the page showed (lane g90). */
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
   * Every API path the main process may reach for this operation, and nothing else.
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
    ],
    input: z.strictObject({ firmId: uuid }),
    output: todayStateSchema,
    transform: 'stale expansion from the in-memory page, eviction on 404 or not_assigned, and the dial advice per usable number',
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
    calls: [{ method: 'POST', path: '/calls/log' }],
    input: outcomeInput,
    output: todayStateSchema,
    transform: 'the call just handed off names the contact and number; the callback instant is the domain’s; no occurredAt',
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
    calls: [{ method: 'POST', path: '/messages/resolve-ambiguity' }],
    input: z.strictObject({ messageId: uuid, opportunityId: uuid }),
    output: replyStateSchema,
    transform: 'refuses a candidate that is not one of this card’s own before it asks the server',
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
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/sequences/versions' },
      { method: 'POST', path: '/enrollments' },
    ],
    input: firmId,
    output: crmStateSchema,
    transform: 'the firm page at its declared version, plus the sequences it could be enrolled in; a failed slice says so rather than reading as none',
  },
  'crm.openPipeline': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/pipeline/board' },
      { method: 'GET', path: '/pipeline/stages' },
      { method: 'GET', path: '/firms' },
    ],
    input: nothing,
    output: crmStateSchema,
    transform: 'the board, or the two reads that built it before the board endpoint, with the opportunity ids a firm page has already shown',
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
  'crm.resolveMerge': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/merges/firms' },
      { method: 'GET', path: '/firms' },
      { method: 'POST', path: '/crm/firm-page' },
      { method: 'GET', path: '/sequences' },
      { method: 'POST', path: '/enrollments' },
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
    ],
    input: nothing,
    output: crmStateSchema,
    transform: 'the open firm page\u2019s own id, never the window\u2019s word for it',
  },
  'crm.enroll': {
    kind: 'command',
    calls: [
      { method: 'POST', path: '/enrollments/enroll' },
      { method: 'POST', path: '/crm/firm-page' },
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
    transform: 'the sign-off and the stop line appended, the variables the text names declared, and approve in the same command',
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
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
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
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
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
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
    ],
    input: saveSettingInputSchema,
    output: adminStateSchema,
    transform: 'an empty note is sent as "Changed on the Mac"; the slice is read again rather than patched from the answer',
  },
  'settings.openHistory': {
    kind: 'read',
    calls: [
      { method: 'POST', path: '/settings/history' },
      { method: 'GET', path: '/settings?include=postal_address' },
      { method: 'POST', path: '/outbound/status' },
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
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
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
      { method: 'GET', path: '/calling-identities' },
      { method: 'GET', path: '/postures/reference' },
      { method: 'GET', path: '/postures' },
      { method: 'GET', path: '/pipeline/stages' },
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
export const IMPORT_IPC_CHANNELS = { choose: 'callie:import:choose' } as const;

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
}

declare global {
  var callieApi: OperationApi | undefined;
  var callieDial: DialBridge | undefined;
  var callieImport: ImportBridge | undefined;
}
