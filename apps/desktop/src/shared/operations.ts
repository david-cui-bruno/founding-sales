import { z } from 'zod';
import { CALL_OUTCOMES, instant, uuid } from '@fss/contracts';
import { replyStateSchema, REPLY_DISPOSITIONS } from '../renderer/replyContract.ts';
import { todayStateSchema } from '../renderer/todayContract.ts';

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
 *   * `http` records the call the main process actually makes, which is a `POST` for
 *     several *reads* (`docs/decisions/g3b-reads-are-posts.md`), and `null` for the
 *     operations answered from the main process's own state;
 *   * `transform` names the main-process work the operation needs — the stale expansion
 *     and refusal eviction on Today's card, the wall-clock callback resolved against the
 *     business zone on a reply — so a handler that quietly stopped doing it is a name
 *     with nothing behind it rather than a silent change of behaviour.
 *
 * Two things deliberately stay outside it. **Dialling** is its own named channel, because
 * it opens a URI on the operating system rather than returning an answer, and a generic
 * `command(op, input)` is not where that should live. **Sign-in** stays on `apiClient.ts`,
 * the unauthenticated client with its closed list of six methods: the registry's calls all
 * carry a bearer token, and the one call made before there is a token should not be able
 * to reach them. The unconverted views keep their own channels until U2.
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

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface Operation {
  /** A read never mints a command id; a command always does, unless `envelope` says otherwise. */
  readonly kind: 'read' | 'command';
  /** The call the main process makes, or null when it answers from its own state. */
  readonly http: { readonly method: 'GET' | 'POST'; readonly path: string } | null;
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
    http: null,
    input: nothing,
    output: todayStateSchema,
    transform: 'the session snapshot: the encrypted 24-hour cache, stale, online, mayMutate',
  },
  'today.refresh': {
    kind: 'read',
    http: { method: 'POST', path: '/today' },
    input: refreshInput,
    output: todayStateSchema,
    transform: 'the session manager re-reads the list into the encrypted cache; a quiet read keeps the notice',
  },
  'today.expand': {
    kind: 'read',
    http: { method: 'POST', path: '/today/firm' },
    input: z.strictObject({ firmId: uuid }),
    output: todayStateSchema,
    transform: 'stale expansion from the in-memory page, eviction on 404 or not_assigned, and the dial advice per usable number',
  },
  'today.collapse': {
    kind: 'read',
    http: null,
    input: nothing,
    output: todayStateSchema,
    transform: 'forgets the open card, its advice and the URIs behind it',
  },
  'today.snooze': {
    kind: 'command',
    http: { method: 'POST', path: '/today/snooze' },
    input: snoozeInput,
    output: todayStateSchema,
    transform: 'a datetime-local resolved against the business zone through the domain’s own clock',
  },
  'today.recordOutcome': {
    kind: 'command',
    http: { method: 'POST', path: '/calls/log' },
    input: outcomeInput,
    output: todayStateSchema,
    transform: 'the call just handed off names the contact and number; the callback instant is the domain’s; no occurredAt',
  },
  'today.scheduleCallback': {
    kind: 'command',
    http: { method: 'POST', path: '/callbacks/schedule' },
    input: z.strictObject({ callLogId: uuid, localDate: z.string().max(10), localTime: z.string().max(5) }),
    output: todayStateSchema,
    transform: 'the local day and time resolved against the business zone before they leave the Mac',
  },
  'today.releasePause': {
    kind: 'command',
    http: { method: 'POST', path: '/today/pause/release' },
    input: z.strictObject({ holdId: uuid }),
    output: todayStateSchema,
    transform: 're-reads the list and the open card, keeping the command’s notice',
  },

  // --- Replies -----------------------------------------------------------
  'replies.state': {
    kind: 'read',
    http: null,
    input: nothing,
    output: replyStateSchema,
    transform: 'the lane as last read; nothing about replies is ever written to disk',
  },
  'replies.refresh': {
    kind: 'read',
    http: { method: 'POST', path: '/replies' },
    input: nothing,
    output: replyStateSchema,
    transform: 'the lane and the classifier settings; a failed read empties the lane rather than keeping a card',
  },
  'replies.open': {
    kind: 'read',
    http: { method: 'POST', path: '/replies/card' },
    input: z.strictObject({ messageId: uuid }),
    output: replyStateSchema,
    transform: 'the card is held only while it is open, and never cached',
  },
  'replies.forget': {
    kind: 'read',
    http: null,
    input: nothing,
    output: replyStateSchema,
    transform: 'drops the lane, the open card and the one body held for it; a read still in flight will not store what it brings back',
  },
  'replies.collapse': {
    kind: 'read',
    http: null,
    input: nothing,
    output: replyStateSchema,
    transform: 'forgets the open card',
  },
  'replies.confirm': {
    kind: 'command',
    http: { method: 'POST', path: '/replies/confirm' },
    input: confirmReplyInput,
    output: replyStateSchema,
    transform: 'the wall-clock callback resolved against the business zone; the model’s proposal is never substituted',
  },
  'replies.resolve': {
    kind: 'command',
    http: { method: 'POST', path: '/messages/resolve-ambiguity' },
    input: z.strictObject({ messageId: uuid, opportunityId: uuid }),
    output: replyStateSchema,
    transform: 'refuses a candidate that is not one of this card’s own before it asks the server',
  },

  // --- Settings › Diagnostics --------------------------------------------
  'diagnostics.sendStatus': {
    kind: 'read',
    http: { method: 'POST', path: '/outbound/status' },
    input: z.strictObject({ outboundMessageId: uuid }),
    output: z.object({ fence: fenceStatusSchema }),
    transform: 'the fence alone, without the subject or the body the status read never carries',
  },
  'diagnostics.resolveSend': {
    kind: 'command',
    http: { method: 'POST', path: '/outbound/resolve' },
    input: z.strictObject({ outboundMessageId: uuid, resolution: z.enum(['delivered', 'skipped']) }),
    output: resolvedSendSchema,
    transform: 'none: 12.5’s admin decision, sent as the command it is',
  },
  'diagnostics.deadJobs': {
    kind: 'read',
    http: { method: 'GET', path: '/admin/jobs/dead' },
    input: nothing,
    output: deadJobsSchema,
    transform: 'none: the list as the server has it',
  },
  'diagnostics.requeueJob': {
    kind: 'command',
    http: { method: 'POST', path: '/admin/jobs/requeue' },
    envelope: 'plain',
    input: z.strictObject({ jobId: uuid, reason: z.string().trim().min(1).max(500) }),
    output: requeuedSchema,
    transform: 'its own parser: this route answers a plain body, not the accepted envelope',
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

/** The two channels the whole registry travels on, and the dial handoff beside them. */
export const OPERATION_IPC_CHANNELS = {
  read: 'callie:op:read',
  command: 'callie:op:command',
} as const;

export const DIAL_IPC_CHANNELS = { call: 'callie:dial:call' } as const;

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

declare global {
  var callieApi: OperationApi | undefined;
  var callieDial: DialBridge | undefined;
}
