import { z } from 'zod';
import {
  e164,
  instant,
  uuid,
  todayCardDtoSchema,
  todayFirmResponseSchema,
  type CALL_OUTCOMES,
  type TodayCardDto,
  type TodayFirmResponse,
  type TodayRouteDto,
  type TodayTaskDto,
} from '@fss/contracts';

/**
 * What the Today view is given, and the shapes of the operations it may ask for
 * (specification 8.2, 14.2). The operations themselves are `shared/operations.ts`'s.
 *
 * A second contract beside G2's `shared/contract.ts` rather than an extension of it,
 * and the reason is a retention rule rather than a style. `DesktopState.today` is the
 * *cache* shape: it is written to disk, encrypted, for 24 hours (5.3), and G2 made it
 * a `strictObject` with no field a body, a note or a person's name could occupy. The
 * expanded card names contacts, so it must not be cacheable — and the way to make
 * that structural rather than remembered is for the expansion to live in a type the
 * cache has never heard of.
 *
 * So: the cards come from the cache and survive an outage marked stale (4.2); the
 * tasks under a card come from the cloud and are simply absent without it.
 *
 * Like G3b's `firmWorkspaceContract.ts`, nothing here decides anything. Every field
 * is a shape the API already produced, and the window's whole job is to show it and
 * to disable what cannot be done.
 */

/*
 * The wire shapes are `@fss/contracts`' (`packages/contracts/src/today.ts`), and this
 * file only names them for the window (lane g78). Until then the list was declared
 * here and again in `todayBridge.ts`, a firm name was capped at 200 characters where a
 * firm may have 300, and a route's number was any short string rather than E.164.
 */
export { TODAY_LANES, type TodayLane } from '@fss/contracts';
export type TodayCard = TodayCardDto;
/**
 * A task on an expanded card. The window asks for the card's second version (lane
 * g79), whose optional `callbackId`, `stepExecutionId`, `callLogId` and `pauseHoldId`
 * say what recording a call against the task completes, and which pause its Resume
 * releases. A card without them offers none of those controls.
 */
export type TodayTask = TodayTaskDto;
/**
 * One dialable route on an expanded card (9.1, 9.2). The version is the one
 * `authorizeDial` compares, so a stale card cannot dial a replaced number.
 */
export type TodayRoute = TodayRouteDto;
/**
 * One card, expanded. `callingIdentityId` is the acting salesperson's own verified
 * number, or null: 9.1 requires the identity to be theirs, so the window is told which
 * one rather than offered a choice, and null is a card with no Call button.
 */
export type TodayFirm = TodayFirmResponse;

/**
 * `POST /dial/check`'s answer for one of the card's numbers (wave 2, S4.5).
 *
 * The card says callable yes or no and, when no, every reason that applies — not the
 * first, so "outside the calling window, and the state is not on your list" is one
 * sentence rather than two presses. The URI stays in the main process: this is
 * everything the window is told, and there is no field on it a renderer could turn into
 * something to open.
 */
const dialAdviceViewSchema = z.strictObject({
  routeId: uuid,
  callable: z.boolean(),
  /**
   * Stable codes, never sentences composed here: `todayView.ts` is the one place each
   * becomes English. The wire values are checked against `@fss/contracts`' closed enum in
   * the main process, which is where a code the server gained should fail.
   */
  reasons: z.array(z.string().max(64)),
  e164: e164.nullable(),
  /** The firm's own clock at the moment of the advice, `HH:MM`, when the zone is known. */
  firmLocalTime: z.string().max(5).nullable(),
});
export type DialAdviceView = z.infer<typeof dialAdviceViewSchema>;

export const todayStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  snapshotDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  cards: z.array(todayCardDtoSchema),
  /** The card the person expanded, or null. Never cached: it names contacts. */
  expanded: todayFirmResponseSchema.nullable(),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** True when the cards on screen came from the 24-hour cache rather than the API. */
  stale: z.boolean(),
  /** When the shown list was fetched, or null when there is nothing to show. */
  asOf: instant.nullable(),
  /** Whether a mutating command may be attempted at all. */
  mayMutate: z.boolean(),
  /** The caller's role: an admin is shown every salesperson's list (8.2). */
  role: z.enum(['admin', 'salesperson']).nullable(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().max(80).nullable(),
  /** 9.2's last clause, so the window never has to compose it. */
  handoffNotice: z.string(),
  /** One entry per usable number on the expanded card; empty when no card is open. */
  dialAdvice: z.array(dialAdviceViewSchema),
  /**
   * The call the last Call button handed to the phone app, so the outcome form can say
   * which number it is recording (lane g79, C16). The ticket and the calling identity
   * that authorized it stay in the main process, which attaches them to the outcome.
   */
  lastCall: z
    .strictObject({ firmId: uuid, routeId: uuid, contactId: uuid.nullable(), e164: z.string().max(20) })
    .nullable()
    .optional(),
  /**
   * The approved templates a salesperson may promise on a call (migration 0025).
   *
   * "E-mail me an overview" permits *that* e-mail, so the permission carries the approved
   * bytes it was promised as and the call log records them — which means the form has to
   * offer a choice rather than a yes. Empty until a card is open, and empty when the
   * workspace has approved nothing.
   */
  followUpTemplates: z.array(z.strictObject({ id: uuid, name: z.string().min(1).max(200) })),
  /**
   * The published sequence versions a call may agree to (send-path v2, slice S3), by
   * the sequence's name and version. Read with the expansion, like the templates; empty
   * when the workspace has published nothing. Optional so a state written by an older
   * main process still parses.
   */
  followUpSequences: z
    .array(z.strictObject({ sequenceVersionId: uuid, name: z.string().min(1).max(220) }))
    .optional(),
  /**
   * What the chosen agreed sequence would send, and when — the server's answer to
   * `POST /calls/follow-up-preview`, for one firm, person and version. The card shows it
   * before the outcome is recorded. `refusal` is the server's code when it would not
   * preview (the same refusals enrolment would give); `steps` is then empty.
   */
  followUpPreview: z
    .strictObject({
      firmId: uuid,
      contactId: uuid,
      sequenceVersionId: uuid,
      sequenceName: z.string().max(200),
      firmTimeZone: z.string().max(64),
      /** The workspace holiday calendar version the instants were computed under. */
      holidayCalendarVersion: z.string().max(64),
      anchoredAt: instant.nullable(),
      steps: z.array(
        z.strictObject({
          ordinal: z.number().int().min(1),
          channel: z.enum(['email', 'call_task']),
          templateName: z.string().max(200).nullable(),
          subject: z.string().max(1000).nullable(),
          estimatedAt: instant,
        }),
      ),
      refusal: z.string().max(80).nullable(),
    })
    .nullable()
    .optional(),
  /**
   * What the last recorded call agreed to, so the notice can name it and say whether the
   * sequence started (send-path v2, slice S3). `started` is null for a single e-mail, and
   * `reason` is the server's refusal code when an agreed sequence did not start.
   */
  agreement: z
    .strictObject({
      scope: z.enum(['single_email', 'agreed_sequence']),
      name: z.string().max(220),
      granted: z.boolean(),
      started: z.boolean().nullable(),
      reason: z.string().max(80).nullable(),
    })
    .nullable()
    .optional(),
  /**
   * An agreed sequence the server did not grant because the schedule changed after the
   * preview (`stale_preview`; review of S3, round 2, P1-B). The call is recorded; the
   * card keeps the follow-up open for this call, shows a fresh preview and offers
   * "Record the agreed dates" (`POST /calls/follow-up`).
   */
  pendingAgreement: z
    .strictObject({
      firmId: uuid,
      callLogId: uuid,
      contactId: uuid,
      sequenceVersionId: uuid,
      name: z.string().max(220),
    })
    .nullable()
    .optional(),
  /**
   * The answer to the outcome command this state answers, by the command id the form sent
   * (kept-state rules K5/K6). Only on the answer to `today.recordOutcome` itself, never on a
   * later read: the form clears its draft on `recorded` and on nothing else, and an absent
   * answer is a lost one, which keeps the draft and the command for a retry under the same id.
   */
  outcomeAnswer: z
    .strictObject({ commandId: uuid, recorded: z.boolean(), reason: z.string().max(80).nullable() })
    .nullable()
    .optional(),
});
export type TodayState = z.infer<typeof todayStateSchema>;
export type PendingAgreementView = NonNullable<TodayState['pendingAgreement']>;

/** "Record the agreed dates": the pending agreement of this call, on the fresh preview. */
export interface RecordAgreedDatesRequest {
  readonly firmId: string;
  readonly callLogId: string;
}
export type FollowUpPreviewView = NonNullable<TodayState['followUpPreview']>;
export type AgreementView = NonNullable<TodayState['agreement']>;

/** The preview the person was read, as the command carries it: anchor, zone, calendar, each step's minute. */
export interface PreviewBasisView {
  readonly anchorAt: string;
  readonly timeZone: string;
  readonly calendarVersionId: string;
  readonly steps: { ordinal: number; sendAt: string }[];
}

/**
 * The basis a shown preview gives the command, or null when the preview cannot carry
 * one (a refusal, or no anchor). The displayed instant of each step is its `estimatedAt`.
 */
export function previewBasisOf(preview: FollowUpPreviewView): PreviewBasisView | null {
  if (preview.refusal !== null || preview.anchoredAt === null || preview.steps.length === 0) return null;
  return {
    anchorAt: preview.anchoredAt,
    timeZone: preview.firmTimeZone,
    calendarVersionId: preview.holidayCalendarVersion,
    steps: preview.steps.map(step => ({ ordinal: step.ordinal, sendAt: step.estimatedAt })),
  };
}

/** Ask for the preview of one agreed sequence, for one person at the open firm. */
export interface FollowUpPreviewRequest {
  readonly firmId: string;
  readonly contactId: string;
  readonly sequenceVersionId: string;
}

export interface SnoozeRequest {
  readonly itemId: string;
  readonly reason: string;
  /**
   * The explicit instant a manual task comes back; 8.2 requires one. Empty for an
   * automated task's pause, which is released by a person rather than by a clock.
   */
  readonly returnAt: string;
}

/** Give "Callback — needs a time" its time (lane g79, C13). Local fields, business zone. */
export interface ScheduleCallbackRequest {
  readonly callLogId: string;
  /** `YYYY-MM-DD`. */
  readonly localDate: string;
  /** `HH:MM`, or empty for a day with no hour. */
  readonly localTime: string;
}

/** The Resume control on a paused automated task (lane g79, C22). */
export interface ReleasePauseRequest {
  readonly holdId: string;
}

export interface DialRequest {
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeId: string;
}

export interface OutcomeRequest {
  readonly firmId: string;
  /**
   * The Today task the call was for (lane g79). The server applies the outcome to the
   * step or callback behind it; null records the call as history only.
   */
  readonly itemId: string | null;
  /**
   * The call this outcome is for, when the page names it (a Needs review item's Log). Sent
   * as it is; when absent the main process may use the last call it placed to this firm.
   */
  readonly callSessionId?: string | null;
  readonly contactId: string | null;
  readonly routeId: string | null;
  readonly outcome: (typeof CALL_OUTCOMES)[number];
  readonly note: string;
  readonly callback: {
    readonly localDate: string;
    readonly localTime: string;
    readonly dueAt: string;
    readonly sourceTimeZone: string;
  } | null;
  /** The 1.0.29 checkbox. A newer form sends `doNotCall` instead and leaves this false. */
  readonly doNotCallCoversAllContact: boolean;
  /** What a `do_not_call` stops (migration 0037, P1): the four-way choice. Wins over the checkbox. */
  readonly doNotCall?: { readonly scope: 'contact' | 'firm'; readonly channel: 'phone' | 'all' };
  /**
   * The command id the form minted (rules K5/K6). A retry after a lost answer sends the same
   * request under the same id, so the server answers it from its receipt rather than
   * recording the call twice. Absent, the main process mints one.
   */
  readonly commandId?: string;
  /**
   * The follow-up agreed on the call (migration 0025): one approved e-mail, or — since
   * send-path v2 (slice S3) — an agreed published sequence, which the server enrols in
   * the same command. `null` is "none", and it is the only value any outcome other than
   * `interested` may carry.
   */
  readonly followUpPermission:
    | { readonly scope: 'single_email'; readonly templateVersionId: string }
    | {
        readonly scope: 'agreed_sequence';
        readonly sequenceVersionId: string;
        /** The schedule the card showed: the server refuses to start on a changed one. */
        readonly previewBasis: PreviewBasisView;
      }
    | null;
}

/**
 * A read of the list. `quiet` is a read Home made by itself, on focus or at the
 * business day's rollover (lane g84, G05): it keeps the last notice on screen.
 */
export interface RefreshRequest {
  readonly quiet?: boolean;
}

