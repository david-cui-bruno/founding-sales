import type { BridgeIdentity } from './identityReset.ts';
import {
  CALL_CADENCE,
  TODAY_CARD_VERSION,
  callHistoryResponseSchema,
  completeCallTaskResultSchema,
  callRecordingResponseSchema,
  callTranscriptResponseSchema,
  callSessionCreatedSchema,
  callbackInstant,
  callingStatusResponseSchema,
  firstNameOf,
  renderVoicemailScript,
  voiceAccessTokenResponseSchema,
  callFollowUpResultSchema,
  callsPlacedTodayResponseSchema,
  dialCheckResponseSchema,
  followUpPreviewResponseSchema,
  loggedCallResultSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
  todayFirmResponseSchema,
  todayPauseReleaseResultSchema,
  todaySnoozeResultSchema,
  type CallsPlacedTodayResponse,
  type LoggedCallResult,
} from '@fss/contracts';
import {
  previewBasisOf,
  todayStateSchema,
  type AgreementView,
  type DialAdviceView,
  type FollowUpPreviewRequest,
  type FollowUpPreviewView,
  type PendingAgreementView,
  type DialRequest,
  type OutcomeRequest,
  type RecordAgreedDatesRequest,
  type RefreshRequest,
  type ReleasePauseRequest,
  type ScheduleCallbackRequest,
  type SnoozeRequest,
  type TodayCard,
  type TodayFirm,
  type TodayState,
} from '../renderer/todayContract.ts';
import { REACHED_OUTCOMES } from '../renderer/outcomeForm.ts';
import type { AuthedClient } from './authedClient.ts';
import type { CallActivity } from './callActivity.ts';
import type { CallStart, CallingView } from '../shared/operations.ts';
import { HANDOFF_LIMITATION_NOTICE, type DialHandoff } from './dialHandoff.ts';
import type { ApiOutcome } from './apiClient.ts';
import type { z } from 'zod';

/**
 * The Today window's half of the bridge, in the main process (specification 8.2,
 * 9.2, 14.2).
 *
 * The window sees a `TodayState` and nothing else: no `tel:` URI, no access token, no
 * command id. That is 14.2's "Electron owns presentation ... it contains no
 * authoritative sequence, suppression, policy, eligibility, or send logic" made
 * structural — the renderer cannot dial without the main process, and the main process
 * will not open anything the server has not just advised it to open.
 *
 * Two decisions are worth naming.
 *
 * **The cards come from G2's cache and the expansion does not.** `refresh` delegates
 * to the session manager, which is the one thing that knows about the encrypted
 * 24-hour cache, the stale rule and the revocation wipe (5.3, 4.2). The expansion is a
 * separate read that is never written to disk, because it names contacts.
 *
 * **A local `datetime-local` becomes a UTC instant here.** The window has no zone but
 * the workspace's business zone, and resolving a wall-clock time against a zone is
 * arithmetic a renderer should not be doing. The domain's own calendar clock does it
 * (`callbackInstant` from `@fss/contracts`), in the main process, beside the zone the
 * API reported — and the server checks the answer against its own (lane g79, C18).
 *
 * Lane g79 added three more (audit items C04, C15, C16, C17):
 *
 * **A call is recorded against its task and its number.** A successful Call keeps the
 * number it was placed to, here and nowhere else; the next outcome recorded for the same
 * firm names it, the contact and the Today task, so the server can apply the outcome to
 * the step or callback behind the task. There is no ticket to name since 1.0.12:
 * `POST /dial/check` advises and `POST /calls/log` records, and neither needs one.
 *
 * **"Just now" is the server's clock.** The outcome carries no `occurredAt`: a Mac a
 * few seconds fast used to fail the database's `recorded_at >= occurred_at`.
 *
 * **What a recorded call still needs is shown, not refused.** The answer's
 * `followUps` become the notice — a callback that needs a time, a number that was not
 * named — and "Callback — needs a time" on the card is where the time is set.
 */

/*
 * There are no channels of this view's own since 1.0.12: the nine that stood here are
 * nine operations of `shared/operations.ts`, answered on `callie:op:read` and
 * `callie:op:command`, and dialling is `callie:dial:call`. What is left in this file is
 * the transformations those operations name.
 */

/*
 * `/today/firm` and the snooze result are parsed with `@fss/contracts`' schemas (lane
 * g78). The list itself is read by the session manager, through `apiClient.today`, into
 * the cache; the second copy of its schema that stood here was used by nothing.
 */

/** What the bridge needs from the rest of the process. All of it injectable. */
export interface TodayBridgeDeps {
  readonly api: AuthedClient;
  readonly handoff: DialHandoff;
  /** G2's session manager: the cache, the stale rule, the version gate, the wipe. */
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly stale: boolean;
      readonly asOf: string | null;
      readonly mayMutate: boolean;
      /** `deviceId` names whose expansions the in-memory cache holds (wave 1). */
      readonly device: { readonly role: 'admin' | 'salesperson'; readonly deviceId?: string } | null;
      readonly today: { readonly snapshotDate: string; readonly businessTimeZone: string; readonly cards: readonly TodayCard[] } | null;
    }>;
    refreshToday(): Promise<unknown>;
  };
  /** The live-call flag the updater waits on (slice C1). Absent: nothing is told. */
  readonly callActivity?: CallActivity;
}

export interface TodayBridgeHost {
  /** Drop the snapshot on an identity transition (1.0.13, P0-A). */
  forget(): Promise<TodayState>;
  /**
   * The bridge's identity generation (send-path v2, S3, round 6, P0), for `guardIdentity`:
   * a late method never clears a newer generation's state.
   */
  readonly identity: BridgeIdentity;
  state(): Promise<TodayState>;
  refresh(input?: RefreshRequest): Promise<TodayState>;
  expand(input: { readonly firmId: string }): Promise<TodayState>;
  collapse(): Promise<TodayState>;
  /**
   * How many calls were placed on the workspace's own business date (29 September 2026).
   *
   * Not part of `TodayState`: the state is the cached list and what the window is doing
   * with it, and this is a live count that moves every time somebody rings off. A read
   * that did not answer is null, so the figure says nothing rather than zero — "no calls
   * yet this morning" and "Callie could not ask" are different facts.
   */
  callsPlaced(): Promise<CallsPlacedTodayResponse | null>;
  snooze(input: SnoozeRequest): Promise<TodayState>;
  /**
   * What an agreed sequence would send and when, for one person at the open firm
   * (send-path v2, slice S3): `POST /calls/follow-up-preview`, kept on the state for the
   * outcome form to show before the call is recorded.
   */
  previewFollowUp(input: FollowUpPreviewRequest): Promise<TodayState>;
  /**
   * "Record the agreed dates" after a stale preview (review of S3, round 2, P1-B):
   * `POST /calls/follow-up` for the pending agreement of that call, on the fresh preview.
   */
  recordAgreedDates(input: RecordAgreedDatesRequest): Promise<TodayState>;
  dial(input: DialRequest): Promise<TodayState>;
  recordOutcome(input: OutcomeRequest): Promise<TodayState>;
  scheduleCallback(input: ScheduleCallbackRequest): Promise<TodayState>;
  completeTask(input: { readonly taskId: string }): Promise<TodayState>;
  releasePause(input: ReleasePauseRequest): Promise<TodayState>;

  // ---- Calling from Callie (slice C1): the dial path when `calling_provider = twilio` ----
  /** `tel` only on the server's calling-off answer; `unavailable` when it could not say. */
  callingStatus(input: { readonly firmId: string }): Promise<CallingView>;
  /**
   * Place a call from Callie: the cadence, then `POST /calls/session`, then
   * `POST /calls/access-token`. The page gets the session id and the Voice token, never
   * the number; the session is kept here for the outcome recorded next.
   */
  startCall(input: {
    readonly firmId: string;
    readonly contactId: string | null;
    readonly routeId: string;
    readonly requestId: string;
  }): Promise<CallStart>;
  /** The page cancelled the current start before its call connected: nothing of it is bound. */
  cancelCall(input: { readonly requestId: string }): Promise<{ readonly cancelled: boolean }>;
  /** The page says a call started or ended; ending one lets a deferred update install. */
  setCallActive(input: { readonly active: boolean }): Promise<{ readonly active: boolean }>;
  /** "Resume calling" on a parked firm, then its cadence again. */
  resumeCalling(input: { readonly firmId: string }): Promise<CallingView>;
  callHistory(input: { readonly firmId: string }): Promise<{ readonly calls: CallHistoryCalls | null }>;
  callRecording(input: { readonly sessionId: string }): Promise<{
    readonly recording: z.infer<typeof callRecordingResponseSchema> | null;
    readonly reason: string | null;
  }>;
  /** Slice C2: one call's transcript; both null when it has none. */
  callTranscript(input: { readonly callSessionId: string }): Promise<{
    readonly transcript: z.infer<typeof callTranscriptResponseSchema> | null;
    readonly reason: string | null;
  }>;
}

type CallHistoryCalls = z.infer<typeof callHistoryResponseSchema>['calls'];

/** The call placed from Callie that the next outcome for its firm records (slice C1). */
interface LastSession {
  readonly firmId: string;
  readonly routeId: string;
  readonly sessionId: string;
}

const TEL: CallingView = Object.freeze({ provider: 'tel', cadence: null });
const UNAVAILABLE: CallingView = Object.freeze({ provider: 'unavailable', cadence: null });

/** The last handed-off call, so the outcome recorded next can name the number. */
interface LastCall {
  readonly firmId: string;
  readonly routeId: string;
  readonly contactId: string | null;
  readonly e164: string;
}

/**
 * The notice a recorded call answers with: plain "recorded", or recorded with the one
 * thing it still needs from the person, most pressing first.
 */
export function outcomeNotice(result: LoggedCallResult | null): string {
  const kinds = new Set((result?.followUps ?? []).map(entry => entry.kind));
  if (kinds.has('effects_not_applied')) return 'outcome_recorded_effects_not_applied';
  if (kinds.has('callback_time_needed')) return 'outcome_recorded_callback_time_needed';
  // Send-path v2 (slice S3): the agreed sequence was granted but did not start. Above
  // "not granted" only because the two cannot both be present — a refused grant never
  // reaches the enrolment.
  if (kinds.has('follow_up_not_enrolled')) return 'outcome_recorded_sequence_not_started';
  // Above `route_not_named`, because it is the more surprising of the two: the person
  // chose an e-mail to promise and Callie did not get permission to send it, which is a
  // thing they said out loud on the call (migration 0025).
  if (kinds.has('follow_up_not_granted')) return 'outcome_recorded_follow_up_not_granted';
  if (kinds.has('route_not_named')) return 'outcome_recorded_route_not_named';
  if (kinds.has('agreed_sequence_enrolled')) return 'outcome_recorded_sequence_started';
  return 'outcome_recorded';
}

/**
 * What a recorded call agreed to, for the notice: the name the person chose from, whether
 * the permission was granted and — for an agreed sequence — whether it started, or the
 * server's refusal code when it did not (send-path v2, slice S3). Null when nothing was
 * agreed, or when the server's answer did not come back readable.
 */
export function agreementOf(
  sent: OutcomeRequest['followUpPermission'],
  result: LoggedCallResult | null,
  names: {
    readonly templates: readonly { readonly id: string; readonly name: string }[];
    readonly sequences: readonly { readonly sequenceVersionId: string; readonly name: string }[];
  },
): AgreementView | null {
  if (sent === null || result === null) return null;
  const followUps = result.followUps;
  const notGranted = followUps.find(entry => entry.kind === 'follow_up_not_granted');
  if (sent.scope === 'single_email') {
    return {
      scope: 'single_email',
      name: names.templates.find(entry => entry.id === sent.templateVersionId)?.name ?? 'the e-mail you chose',
      granted: notGranted === undefined,
      started: null,
      reason: notGranted?.reason ?? null,
    };
  }
  const notEnrolled = followUps.find(entry => entry.kind === 'follow_up_not_enrolled');
  const enrolled = followUps.some(entry => entry.kind === 'agreed_sequence_enrolled');
  return {
    scope: 'agreed_sequence',
    name:
      names.sequences.find(entry => entry.sequenceVersionId === sent.sequenceVersionId)?.name ?? 'the sequence you chose',
    granted: notGranted === undefined,
    started: enrolled,
    reason: notGranted?.reason ?? notEnrolled?.reason ?? null,
  };
}

/** How many sequences the card reads the versions of: more than a founder publishes. */
const FOLLOW_UP_SEQUENCE_LIMIT = 50;

/**
 * `YYYY-MM-DDTHH:MM` in `zone`, as a UTC instant.
 *
 * One implementation, and it is the domain's: `localInstant` from `@fss/contracts`,
 * which is what `packages/domain/src/rules/localClock.ts` re-exports and what the
 * server checks a callback's `dueAt` against (lane g79, audit item C18). Until then
 * this was a second, local two-step `Intl` correction that put New York's 02:30 on
 * 8 March 2026 at 01:30 EST, an hour *before* the wall clock the person typed, where
 * the domain resolves a DST gap forward to 03:30 EDT
 * (docs/decisions/g0-dst-gap-resolution.md). The reply bridge imports this function
 * too, so both of the Mac's callback forms resolve the way the server does.
 */
export function localToInstant(local: string, zone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/u.exec(local.trim());
  if (match === null) return null;
  return callbackInstant(match[1] ?? '', match[2] ?? '', zone);
}

/** How many firms' expansions the in-memory cache keeps: more than a day's list. */
const EXPANSION_CACHE_LIMIT = 200;

export function createTodayBridge(deps: TodayBridgeDeps): TodayBridgeHost {
  /**
   * The identity generation (send-path v2, S3, round 6, P0). `forget` advances it; every
   * method takes a copy when it starts, and every write that follows an `await` asks
   * `stale(mine)` first. A `/calls/log` from the last person that answers after the
   * clear must not put their pending agreement, preview, last call or opened firm back
   * into the fields the next person is reading, and it must not clear the next person's
   * own (see `identity` below).
   */
  let generation = 0;
  const stale = (mine: number): boolean => mine !== generation;
  let expanded: TodayFirm | null = null;
  let notice: string | null = null;
  let lastCall: LastCall | null = null;
  /** The last call placed from Callie, for `callSessionId` on its outcome (slice C1). */
  let lastSession: LastSession | null = null;
  /**
   * Which Call press is current (review of C1, fold 2, finding 2). Each `startCall` takes
   * the next number; a cancel and an identity change move it on. A start whose session or
   * token answers after that binds nothing: a cancelled start's session is never what the
   * next outcome records.
   */
  let startRequest = 0;
  /**
   * The page's id for the current start (review of C1, fold 3). A cancel names the press
   * it gives up; one naming any other is late, about a start already superseded, and
   * changes nothing.
   */
  let currentRequestId: string | null = null;
  /** The start that bound `lastSession`, so a cancel of that start can unbind it. */
  let lastSessionRequest: number | null = null;
  /** `POST /dial/check`'s answer for each of the expanded card's usable numbers. */
  let dialAdvice: readonly DialAdviceView[] = [];
  /**
   * The approved templates an outcome may promise (migration 0025). Read with the
   * expansion, because that is when the form that offers them appears, and left alone
   * when the read fails: an empty list means "nothing to promise", which is the safe
   * answer and not a silent one — the form says so.
   */
  let followUpTemplates: readonly { readonly id: string; readonly name: string }[] = [];
  /**
   * The published sequence versions a call may agree to (send-path v2, slice S3), read
   * with the expansion like the templates, and the preview of the one chosen. The preview
   * belongs to one firm, person and version; the form shows it only when all three match.
   */
  let followUpSequences: readonly { readonly sequenceVersionId: string; readonly name: string }[] = [];
  let followUpPreview: FollowUpPreviewView | null = null;
  /** Which preview request is the newest; an older answer is dropped when it lands. */
  let previewRequest = 0;
  /** The firm whose card the last successful expansion read. */
  let openedFirmId: string | null = null;
  /**
   * An agreed sequence the server did not grant because the schedule changed after the
   * preview (`stale_preview`; review of S3, round 2, P1-B). The call is recorded; the card
   * keeps the follow-up open, reads a fresh preview, and offers "Record the agreed dates".
   */
  let pendingAgreement: PendingAgreementView | null = null;
  /** What the last recorded call agreed to, for the notice. Cleared with the notice. */
  let agreement: AgreementView | null = null;
  /**
   * The URI each advised number would open, by route. It never crosses the bridge: a
   * renderer that cannot name a `tel:` string cannot ask for one to be opened, however
   * the page is edited later.
   */
  const telUris = new Map<string, string | null>();
  /**
   * The last expansion read for each firm, in memory only (wave 1). Until then a card
   * opened while the Mac was offline read the network, failed, and closed: the list was
   * on screen from the cache and nothing on it could be opened. It is never written to
   * disk — the offline cache holds the list and nothing more (5.3) — and it belongs to
   * one device: another sign-in starts it empty.
   */
  const expansions = new Map<string, TodayFirm>();
  let expansionsOwner: string | null = null;

  const remember = (page: TodayFirm): void => {
    expansions.delete(page.firmId);
    expansions.set(page.firmId, page);
    if (expansions.size > EXPANSION_CACHE_LIMIT) {
      const oldest = expansions.keys().next().value;
      if (oldest !== undefined) expansions.delete(oldest);
    }
  };

  /** The card as the cached list has it, opened with nothing that needs the server. */
  const fromList = (
    today: Awaited<ReturnType<TodayBridgeDeps['session']['state']>>['today'],
    firmId: string,
  ): TodayFirm | null => {
    const card = today?.cards.find(entry => entry.firmId === firmId);
    if (today === null || card === undefined) return null;
    return {
      firmId: card.firmId,
      firmName: card.firmName,
      snapshotDate: today.snapshotDate,
      lane: card.lane,
      counts: card.counts,
      tasks: [],
      routes: [],
      callingIdentityId: null,
    };
  };

  const snapshot = async (options: { readonly generation?: number } = {}): Promise<TodayState> => {
    const session = await deps.session.state();
    // The empty state a late method answers with when a newer generation owns the
    // fields: the session's facts, and nothing this bridge holds. Decided after the
    // session read, not before it: a `forget` that runs while that read is on the wire
    // would otherwise let the fields of the newer generation through (round 7, P2).
    if (options.generation !== undefined && stale(options.generation)) {
      return todayStateSchema.parse({
        snapshotDate: session.today?.snapshotDate ?? null,
        businessTimeZone: session.today?.businessTimeZone ?? null,
        cards: session.today?.cards ?? [],
        expanded: null,
        online: session.online,
        stale: session.stale,
        asOf: session.asOf,
        mayMutate: session.mayMutate,
        role: session.device?.role ?? null,
        notice: null,
        handoffNotice: HANDOFF_LIMITATION_NOTICE,
        dialAdvice: [],
        followUpTemplates: [],
        followUpSequences: [],
        followUpPreview: null,
        agreement: null,
        pendingAgreement: null,
        lastCall: null,
      });
    }
    return todayStateSchema.parse({
      snapshotDate: session.today?.snapshotDate ?? null,
      businessTimeZone: session.today?.businessTimeZone ?? null,
      cards: session.today?.cards ?? [],
      expanded,
      online: session.online,
      stale: session.stale,
      asOf: session.asOf,
      mayMutate: session.mayMutate,
      role: session.device?.role ?? null,
      notice,
      handoffNotice: HANDOFF_LIMITATION_NOTICE,
      dialAdvice,
      followUpTemplates,
      followUpSequences,
      followUpPreview,
      agreement,
      pendingAgreement,
      lastCall:
        lastCall === null
          ? null
          : { firmId: lastCall.firmId, routeId: lastCall.routeId, contactId: lastCall.contactId, e164: lastCall.e164 },
    });
  };

  /** A method's answer: the empty state when a newer generation owns the fields. */
  const answerFor = async (mine: number): Promise<TodayState> => await snapshot({ generation: mine });

  /** Record what a call answered, and forget any expansion it invalidated. */
  const note = (outcome: ApiOutcome<unknown>, accepted: string | null): boolean => {
    if (outcome.ok) {
      notice = accepted;
      return true;
    }
    notice = outcome.reason;
    return false;
  };

  const loadExpansion = async (firmId: string, mine: number): Promise<void> => {
    if (stale(mine)) return;
    // Another firm's card: a preview in flight for the last one must not land here. At
    // the start, before the read — a read that fails or is refused returns early, and
    // the old request must be dead on those paths too (review of S3, round 3, P2-a).
    // Only the request: a pending agreement and its fresh preview belong to their own
    // card and survive a refused or offline read of another one (round 4, P1-I).
    if (openedFirmId !== firmId) previewRequest += 1;
    openedFirmId = firmId;
    const session = await deps.session.state();
    if (stale(mine)) return;
    const owner = session.device?.deviceId ?? null;
    if (owner !== expansionsOwner) {
      expansions.clear();
      expansionsOwner = owner;
    }
    // One read: the tasks, the routes with the versions `authorizeDial` will compare,
    // and the actor's own calling identity, all at one instant (9.2 step 3).
    // `cardVersion: 2` asks for each task's callback, step, needs-a-time call and pause
    // (lane g79). The API answers G6's shape to a client that does not ask.
    const page = await deps.api.read('/today/firm', value => todayFirmResponseSchema.parse(value), {
      firmId,
      cardVersion: TODAY_CARD_VERSION,
      // Slice 3a: the firm's open call tasks, as tasks of kind `task`.
      include: ['tasks'],
    });
    if (stale(mine)) return;
    if (!page.ok) {
      dialAdvice = [];
      note(page, null);
      // A read that did not get an answer — the network, or a server that failed —
      // keeps what this Mac last read for the firm, or the list's own card, with the
      // notice saying why it could not read again (wave 1). A refusal is an answer:
      // `not_found` is a firm that left today's list and `not_assigned` one that is no
      // longer this person's, so its card closes and its cached page goes.
      const unanswered = page.offline || page.reason === 'unreadable_answer' || /^http_5\d\d$/u.test(page.reason);
      if (!unanswered) {
        expansions.delete(firmId);
        expanded = null;
        return;
      }
      expanded = expansions.get(firmId) ?? fromList(session.today, firmId);
      return;
    }
    expanded = page.value;
    remember(page.value);
    notice = null;
    agreement = null;
    if (followUpPreview !== null && followUpPreview.firmId !== firmId) followUpPreview = null;
    // A pending agreement is given up only when the person has actually moved on to
    // another firm's card (round 4, P1-I); back on its own card, it gets its fresh
    // preview again if it has none.
    if (pendingAgreement !== null && pendingAgreement.firmId !== firmId) pendingAgreement = null;

    const advice = await adviseRoutes(page.value, mine);
    if (stale(mine)) return;
    dialAdvice = advice;
    const templates = await approvedTemplates();
    if (stale(mine)) return;
    followUpTemplates = templates;
    const sequences = await publishedSequences();
    if (stale(mine)) return;
    followUpSequences = sequences;
    const pending = pendingAgreement;
    if (
      pending !== null &&
      (followUpPreview === null ||
        followUpPreview.contactId !== pending.contactId ||
        followUpPreview.sequenceVersionId !== pending.sequenceVersionId)
    ) {
      await loadPreview(pending, mine);
    }
  };

  /**
   * The published, enrollable sequence versions, as "Name v2", for the agreed-sequence
   * choice (send-path v2, slice S3). The Firm page's read (`crmBridge.loadSequences`):
   * `/sequences`, then each unarchived sequence's `/sequences/versions` — a founder has a
   * handful. A read that fails leaves the list empty, which the form says plainly; it
   * never offers a version it could not read.
   */
  const publishedSequences = async (): Promise<readonly { readonly sequenceVersionId: string; readonly name: string }[]> => {
    const list = await deps.api.read('/sequences', value => sequencesResponseSchema.parse(value));
    if (!list.ok) return [];
    const published: { sequenceVersionId: string; name: string }[] = [];
    for (const sequence of list.value.sequences.slice(0, FOLLOW_UP_SEQUENCE_LIMIT)) {
      if (sequence.archivedAt !== null) continue;
      const versions = await deps.api.read('/sequences/versions', value => sequenceVersionsResponseSchema.parse(value), {
        sequenceId: sequence.id,
      });
      if (!versions.ok) return [];
      for (const version of versions.value.versions) {
        // A version with a removed LinkedIn step is not enrollable (`step_unknown`).
        if (version.state !== 'published' || version.steps.some(step => step.channel === 'removed')) continue;
        published.push({ sequenceVersionId: version.id, name: `${sequence.name} v${String(version.version)}` });
      }
    }
    return published;
  };

  /**
   * The approved, unretired template versions, newest first, as names a person reads.
   *
   * One read, with the expansion. A salesperson promising "an overview" on a call is
   * promising *approved bytes*: the call log records which, the permission is bound to
   * it, and the claim refuses a fence carrying anything else (P0-2). So the form needs
   * the list, and this is the smallest read that answers it.
   */
  const approvedTemplates = async (): Promise<readonly { readonly id: string; readonly name: string }[]> => {
    const answer = await deps.api.read('/templates', value => templateVersionsResponseSchema.parse(value), {});
    if (!answer.ok) return [];
    return answer.value.templates
      .filter(template => template.approvedAt !== null && template.retiredAt === null)
      .map(template => ({ id: template.id, name: template.name }));
  };

  /**
   * "Can I call this number now?", for each of the card's usable numbers (wave 2, S4.5).
   *
   * A read per number rather than one for the firm, because the advice's reasons and its
   * URI are about a number: a firm may have one line inside its calling window and
   * another suppressed, and a card that said "callable" for the firm would be offering a
   * button the server then refuses. The reads run together — the expansion has one or two
   * numbers, not a page of them — and a read that fails leaves that number without advice
   * rather than claiming it is callable.
   *
   * The URI stays in this process. The window is told callable yes or no and why; the
   * string that reaches macOS is re-read at the moment of the press and never crosses the
   * bridge at all.
   */
  const adviseRoutes = async (page: TodayFirm, mine: number): Promise<readonly DialAdviceView[]> => {
    const usable = page.routes.filter(route => route.eligibility === 'usable');
    const answers: (DialAdviceView | null)[] = await Promise.all(
      usable.map(async route => await adviseRoute(page.firmId, route.routeId, mine)),
    );
    return answers.filter((answer): answer is DialAdviceView => answer !== null);
  };

  const adviseRoute = async (firmId: string, routeId: string, mine: number): Promise<DialAdviceView | null> => {
    const answer = await deps.api.read('/dial/check', value => dialCheckResponseSchema.parse(value), { firmId, routeId });
    if (!answer.ok || stale(mine)) return null;
    const advice = answer.value.advice;
    telUris.set(routeId, advice.telUri);
    return {
      routeId,
      callable: advice.callable,
      reasons: advice.reasons,
      e164: advice.e164,
      firmLocalTime: advice.firmLocalTime,
    };
  };

  const loadPreview = async (input: FollowUpPreviewRequest, mine: number): Promise<void> => {
    // A continuation of the last person's must not even advance the counter: that would
    // kill the next person's own preview in flight (round 6, P0).
    if (stale(mine)) return;
    // Only the newest request may land (review of S3, P2-b): a person who changes the
    // sequence while an older preview is in flight must not see the older answer.
    previewRequest += 1;
    const request = previewRequest;
    const answer = await deps.api.read(
      '/calls/follow-up-preview',
      value => followUpPreviewResponseSchema.parse(value),
      { firmId: input.firmId, contactId: input.contactId, sequenceVersionId: input.sequenceVersionId },
    );
    if (stale(mine) || request !== previewRequest) return;
    if (answer.ok) {
      followUpPreview = {
        firmId: input.firmId,
        contactId: input.contactId,
        sequenceVersionId: answer.value.sequenceVersionId,
        sequenceName: answer.value.sequenceName,
        firmTimeZone: answer.value.firmTimeZone,
        holidayCalendarVersion: answer.value.holidayCalendarVersion,
        anchoredAt: answer.value.anchoredAt,
        steps: answer.value.steps.map(step => ({
          ordinal: step.ordinal,
          channel: step.channel,
          templateName: step.templateName,
          subject: step.subject,
          estimatedAt: step.estimatedAt,
        })),
        refusal: null,
      };
    } else if (answer.offline || answer.reason === 'unreadable_answer' || /^http_5\d\d$/u.test(answer.reason)) {
      followUpPreview = null;
      notice = answer.reason;
    } else {
      followUpPreview = {
        firmId: input.firmId,
        contactId: input.contactId,
        sequenceVersionId: input.sequenceVersionId,
        sequenceName: '',
        firmTimeZone: '',
        holidayCalendarVersion: '',
        anchoredAt: null,
        steps: [],
        refusal: answer.reason.slice(0, 80),
      };
    }
  };

  /**
   * Re-read after a mutation, keeping the mutation's notice. The re-read's own success
   * would clear it, and a firm whose last task the mutation finished has left today's
   * list — its card closes, and "not found" is not what the person should read.
   */
  const reloadAfterMutation = async (options: { readonly refreshList: boolean }, mine: number): Promise<void> => {
    if (stale(mine)) return;
    if (options.refreshList) await deps.session.refreshToday();
    if (stale(mine) || expanded === null) return;
    const kept = notice;
    const keptAgreement = agreement;
    await loadExpansion(expanded.firmId, mine);
    if (stale(mine)) return;
    if (expanded !== null || notice === 'not_found') {
      notice = kept;
      agreement = keptAgreement;
    }
  };

  const host: TodayBridgeHost = {
    /**
     * Forget everything this bridge is holding (1.0.13, P0-A).
     *
     * Called on every identity transition, from `registerWindows`. Nothing here is the
     * next person's to read, and a snapshot kept across a sign-out is the last person's
     * work shown to somebody else.
     */
    async forget() {
      generation += 1;
      previewRequest += 1;
      // An identity change: nothing of the last person's stays — not their pending
      // agreement's call, contact and sequence ids either (review of S3, round 5, P0).
      pendingAgreement = null;
      openedFirmId = null;
      expanded = null;
      notice = null;
      agreement = null;
      followUpPreview = null;
      followUpSequences = [];
      followUpTemplates = [];
      lastCall = null;
      lastSession = null;
      lastSessionRequest = null;
      startRequest += 1;
      currentRequestId = null;
      dialAdvice = [];
      expansionsOwner = null;
      return await snapshot();
    },

    /**
     * For `guardIdentity` (round 6, P0). A method that outlived its session clears the
     * bridge only while the bridge is still on the generation that method began under;
     * once `forget` has run since, the fields are the next person's and are left alone.
     */
    identity: {
      current: () => generation,
      async forgetIfCurrent(since: number): Promise<TodayState> {
        if (!stale(since)) return await host.forget();
        return await snapshot({ generation: since });
      },
    },

    state: async () => await snapshot(),

    async refresh(input = {}) {
      const mine = generation;
      // A read Home made by itself — on focus, at the rollover (lane g84, G05) — keeps
      // the last notice, exactly as the re-read after a mutation does: "Call recorded."
      // should not vanish because the person came back to the window. Refresh pressed
      // is a fresh look and clears it, as it always has.
      if (input.quiet === true) {
        await reloadAfterMutation({ refreshList: true }, mine);
        return await answerFor(mine);
      }
      await deps.session.refreshToday();
      if (!stale(mine) && expanded !== null) await loadExpansion(expanded.firmId, mine);
      return await answerFor(mine);
    },

    async expand(input) {
      const mine = generation;
      await loadExpansion(input.firmId, mine);
      return await answerFor(mine);
    },

    async callsPlaced() {
      const answer = await deps.api.read('/today/calls-placed', value => callsPlacedTodayResponseSchema.parse(value));
      // A refusal or an unreadable answer is null. It is not this read's business to put
      // a notice on the day's list: the figure alone goes quiet.
      return answer.ok ? answer.value : null;
    },

    async collapse() {
      // A preview still on the wire belongs to the card being closed (review of S3,
      // round 2, P2): advancing the counter makes its answer land on nothing.
      previewRequest += 1;
      // Closing the card is not giving up the call's agreement (round 4, P1-I; round 5,
      // P0): a pending agreement stays, and reopening the card reads its dates again.
      expanded = null;
      notice = null;
      agreement = null;
      followUpPreview = null;
      dialAdvice = [];
      telUris.clear();
      return await snapshot();
    },

    async snooze(input) {
      const mine = generation;
      const session = await deps.session.state();
      if (stale(mine)) return await answerFor(mine);
      const zone = session.today?.businessTimeZone ?? null;
      // The window sends what a `datetime-local` gives it, or nothing for an automated
      // task's pause. A zone-less instant is not something the server may be asked to
      // guess at.
      const wanted = input.returnAt.trim();
      const returnAt =
        wanted === ''
          ? undefined
          : wanted.includes('Z')
            ? wanted
            : zone === null
              ? null
              : localToInstant(wanted, zone);
      if (returnAt === null) {
        notice = 'snooze_return_not_future';
        return await answerFor(mine);
      }
      const answer = await deps.api.command(
        '/today/snooze',
        { itemId: input.itemId, reason: input.reason, ...(returnAt === undefined ? {} : { returnAt }) },
        value => todaySnoozeResultSchema.parse(value),
      );
      if (stale(mine)) return await answerFor(mine);
      if (note(answer, null) && answer.ok) notice = answer.value.outcome;
      await reloadAfterMutation({ refreshList: false }, mine);
      return await answerFor(mine);
    },

    /**
     * The server's preview of an agreed sequence (send-path v2, slice S3).
     *
     * Every instant is the server's — `resolveStepDue` and `placeEmailSend`, the firm's
     * zone, the workspace calendar — so the Mac computes no schedule of its own. A refusal
     * is kept as its code, with no steps, so the form can say why it cannot start that
     * plan; an answer that did not arrive clears the preview rather than showing an old
     * one.
     */
    async previewFollowUp(input) {
      const mine = generation;
      await loadPreview(input, mine);
      return await answerFor(mine);
    },

    /**
     * Call this number (9.2; wave 2's S4.5 shape).
     *
     * The advice on the card may be a minute old, so it is read again here — the calling
     * window closes at a wall-clock time and a suppression can be recorded while a card
     * is open — and the URI that reaches macOS is the one that read answered with, not
     * the one on screen. A number the server will not advise now is a refusal with its
     * own reason and nothing opened.
     */
    async dial(input) {
      const mine = generation;
      const setup = await deps.handoff.checkSetup();
      if (stale(mine)) return await answerFor(mine);
      if (!setup.ready) {
        notice = setup.reason;
        return await answerFor(mine);
      }
      const fresh = await adviseRoute(input.firmId, input.routeId, mine);
      if (stale(mine)) return await answerFor(mine);
      if (fresh === null) {
        notice = 'dial_advice_unavailable';
        return await answerFor(mine);
      }
      // The card is told what the fresh read found, whether or not the call goes ahead.
      dialAdvice = dialAdvice.map(entry => (entry.routeId === fresh.routeId ? fresh : entry));
      const telUri = telUris.get(input.routeId) ?? null;
      if (!fresh.callable || telUri === null) {
        notice = fresh.reasons[0] ?? 'not_callable';
        return await answerFor(mine);
      }
      const outcome = await deps.handoff.open({ telUri, e164: fresh.e164 ?? '' });
      // The number was handed to macOS either way; what the window shows is only the
      // current person's to be told.
      if (stale(mine)) return await answerFor(mine);
      notice =
        outcome.status === 'opened'
          ? 'dial_opened'
          : outcome.status === 'opened_unknown'
            ? 'dial_opened_unknown'
            : outcome.reason;
      if (outcome.status === 'opened' || outcome.status === 'opened_unknown') {
        // The call may have been placed either way, so the outcome form is told which
        // number it is recording (C16).
        const route = expanded?.routes.find(entry => entry.routeId === input.routeId);
        lastCall = {
          firmId: input.firmId,
          routeId: input.routeId,
          contactId: route?.contactId ?? input.contactId,
          e164: fresh.e164 ?? route?.e164 ?? '',
        };
      }
      return await answerFor(mine);
    },

    async recordOutcome(input) {
      const mine = generation;
      const session = await deps.session.state();
      if (stale(mine)) return await answerFor(mine);
      const zone = session.today?.businessTimeZone ?? null;
      let callback: Record<string, string> | undefined;
      if (input.callback !== null && input.callback.localDate !== '') {
        const sourceTimeZone = input.callback.sourceTimeZone === '' ? zone : input.callback.sourceTimeZone;
        // The domain's clock, so the instant sent is the instant the server will
        // resolve the same fields to; it refuses a disagreement (C18).
        const dueAt =
          sourceTimeZone === null ? null : callbackInstant(input.callback.localDate, input.callback.localTime, sourceTimeZone);
        if (sourceTimeZone !== null) {
          callback = {
            localDate: input.callback.localDate,
            ...(input.callback.localTime === '' ? {} : { localTime: input.callback.localTime }),
            sourceTimeZone,
            ...(dueAt === null ? {} : { dueAt }),
          };
        }
      }
      // When the page names the call (a Needs review item's Log), nothing is borrowed from the
      // last call: not its route and not its person. The server derives the route from that
      // session's ticket, and a route from another call would be refused as a mismatch.
      const named = input.callSessionId ?? null;
      // The last handed-off call belongs to this outcome when it was to this firm and,
      // if the window named a number, to that number (C16).
      const call =
        named === null &&
        lastCall !== null &&
        lastCall.firmId === input.firmId &&
        (input.routeId === null || input.routeId === lastCall.routeId)
          ? lastCall
          : null;
      const routeId = input.routeId ?? call?.routeId ?? null;
      const contactId = input.contactId ?? call?.contactId ?? null;
      // A call placed from Callie to this firm and number: the outcome names its session,
      // so the server links the log to the recorded call (slice C1). Never guessed across
      // firms or numbers, exactly like the last call above.
      // When the page names the call (a Needs review item's Log), that session is sent as it
      // is and `lastSession` is never consulted: it may be another call, or none after a restart.
      const placed =
        named !== null
          ? null
          : lastSession !== null && lastSession.firmId === input.firmId && (routeId === null || routeId === lastSession.routeId)
            ? lastSession
            : null;
      const answer = await deps.api.command(
        '/calls/log',
        {
          firmId: input.firmId,
          ...(contactId === null ? {} : { contactId }),
          ...(routeId === null ? {} : { routeId }),
          ...(input.itemId === null ? {} : { itemId: input.itemId }),
          ...(named !== null ? { callSessionId: named } : placed === null ? {} : { callSessionId: placed.sessionId }),
          outcome: input.outcome,
          // No `occurredAt`: "just now" is the server's clock (C15).
          ...(input.note === '' ? {} : { note: input.note }),
          ...(callback === undefined ? {} : { callback }),
          // What a "Do not call" stops (migration 0037): the four-way choice when the form
          // sent one, else the 1.0.29 checkbox, which keeps its meaning on the server.
          ...(input.outcome === 'do_not_call'
            ? input.doNotCall !== undefined
              ? { doNotCall: input.doNotCall }
              : { doNotCallCoversAllContact: input.doNotCallCoversAllContact }
            : {}),
          // The agreed follow-up (migration 0025). Sent for the outcomes the consent rule
          // allows one on (a conversation that reached somebody, never `do_not_call`): any
          // other outcome would be refused, and refusing a whole call log because of a
          // stale field in the form would lose the outcome itself.
          // …and only when the call names a person. A permission is granted to somebody,
          // and the server refuses an agreement with no contact — which would take the
          // whole call log with it, losing the outcome (the third review of PR 332).
          ...(input.followUpPermission !== null && REACHED_OUTCOMES.includes(input.outcome) && contactId !== null
            ? { followUpPermission: input.followUpPermission }
            : {}),
        },
        value => {
          const parsed = loggedCallResultSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
        // The form's id (rules K5/K6): its retry after a lost answer is this same command.
        input.commandId === undefined ? {} : { commandId: input.commandId },
      );
      // The person who recorded this call has left this Mac while it was on the wire:
      // nothing of theirs — the pending agreement's call, contact and sequence ids, the
      // last call — goes into the fields the next person reads (round 6, P0).
      if (stale(mine)) return await answerFor(mine);
      // What was actually sent, for the notice: the same condition as the body above.
      const agreed =
        input.followUpPermission !== null && REACHED_OUTCOMES.includes(input.outcome) && contactId !== null
          ? input.followUpPermission
          : null;
      agreement = null;
      pendingAgreement = null;
      if (note(answer, null) && answer.ok) {
        notice = outcomeNotice(answer.value);
        agreement = agreementOf(agreed, answer.value, { templates: followUpTemplates, sequences: followUpSequences });
        followUpPreview = null;
        if (call !== null) lastCall = null;
        if (placed !== null) lastSession = null;
        // The dates changed between the preview and the recording, and nothing was
        // granted (P1-B). The card keeps this call's agreement open and reads the dates
        // as they are now, for the person to hear before "Record the agreed dates".
        const result = answer.value;
        const stale =
          result?.followUps.some(entry => entry.kind === 'follow_up_not_granted' && entry.reason === 'stale_preview') ===
          true;
        if (result !== null && stale && agreed?.scope === 'agreed_sequence' && contactId !== null) {
          pendingAgreement = {
            firmId: input.firmId,
            callLogId: result.callLogId,
            contactId,
            sequenceVersionId: agreed.sequenceVersionId,
            name: agreement?.name ?? '',
          };
        }
      }
      // The outcome may have created a callback, stopped a sequence or suppressed a
      // number. Re-read rather than patching the page: the server decided, not us.
      await reloadAfterMutation({ refreshList: true }, mine);
      if (!stale(mine) && pendingAgreement !== null) await loadPreview(pendingAgreement, mine);
      const state = await answerFor(mine);
      // The form's own answer, on this state only (rules K5/K6): it clears its draft on
      // `recorded` and keeps it on anything else. A state for a newer generation carries none.
      if (input.commandId === undefined || stale(mine)) return state;
      return todayStateSchema.parse({
        ...state,
        outcomeAnswer: { commandId: input.commandId, recorded: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) },
      });
    },

    async recordAgreedDates(input) {
      const mine = generation;
      const pending = pendingAgreement;
      const preview = followUpPreview;
      const basis =
        pending !== null &&
        preview !== null &&
        pending.callLogId === input.callLogId &&
        preview.firmId === pending.firmId &&
        preview.contactId === pending.contactId &&
        preview.sequenceVersionId === pending.sequenceVersionId
          ? previewBasisOf(preview)
          : null;
      if (pending === null || basis === null) {
        notice = 'agreed_dates_need_preview';
        return await answerFor(mine);
      }
      const answer = await deps.api.command(
        '/calls/follow-up',
        {
          callLogId: pending.callLogId,
          followUpPermission: { scope: 'agreed_sequence', sequenceVersionId: pending.sequenceVersionId, previewBasis: basis },
        },
        value => {
          const parsed = callFollowUpResultSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      );
      if (stale(mine)) return await answerFor(mine);
      const recorded = answer.ok ? answer.value : null;
      if (note(answer, null) && recorded !== null) {
        const followUps = recorded.followUps;
        const stillStale = followUps.some(entry => entry.reason === 'stale_preview');
        agreement = {
          scope: 'agreed_sequence',
          name: pending.name,
          granted: !followUps.some(entry => entry.kind === 'follow_up_not_granted'),
          started: followUps.some(entry => entry.kind === 'agreed_sequence_enrolled'),
          reason: followUps.find(entry => entry.kind !== 'agreed_sequence_enrolled')?.reason ?? null,
        };
        notice = agreement.started === true ? 'outcome_recorded_sequence_started' : 'outcome_recorded_sequence_not_started';
        if (stillStale) {
          // The dates moved again while the person listened: read them again.
          await loadPreview(pending, mine);
        } else {
          pendingAgreement = null;
          followUpPreview = null;
        }
      } else if (!answer.ok && answer.reason === 'agreement_exists') {
        pendingAgreement = null;
      }
      await reloadAfterMutation({ refreshList: true }, mine);
      return await answerFor(mine);
    },

    async scheduleCallback(input) {
      const mine = generation;
      const session = await deps.session.state();
      if (stale(mine)) return await answerFor(mine);
      const zone = session.today?.businessTimeZone ?? null;
      const dueAt = zone === null ? null : callbackInstant(input.localDate, input.localTime, zone);
      if (zone === null || dueAt === null) {
        notice = 'callback_time_invalid';
        return await answerFor(mine);
      }
      const answer = await deps.api.command(
        '/callbacks/schedule',
        {
          callLogId: input.callLogId,
          localDate: input.localDate,
          ...(input.localTime === '' ? {} : { localTime: input.localTime }),
          sourceTimeZone: zone,
          dueAt,
        },
        () => null,
      );
      if (stale(mine)) return await answerFor(mine);
      note(answer, 'callback_scheduled');
      await reloadAfterMutation({ refreshList: true }, mine);
      return await answerFor(mine);
    },

    async completeTask(input) {
      const mine = generation;
      const answer = await deps.api.command('/today/tasks/complete', { taskId: input.taskId }, value => completeCallTaskResultSchema.parse(value));
      if (stale(mine)) return await answerFor(mine);
      note(answer, 'task_completed');
      await reloadAfterMutation({ refreshList: true }, mine);
      return await answerFor(mine);
    },

    async releasePause(input) {
      const mine = generation;
      const answer = await deps.api.command('/today/pause/release', { holdId: input.holdId }, value =>
        todayPauseReleaseResultSchema.parse(value),
      );
      if (stale(mine)) return await answerFor(mine);
      note(answer, 'pause_released');
      await reloadAfterMutation({ refreshList: true }, mine);
      return await answerFor(mine);
    },

    async callingStatus(input) {
      // Only the server's calling-off answer selects the phone app; anything it could not
      // say is `unavailable`, and the Call button waits (review of C1, fold 1, finding 1).
      const status = await readCallingStatus(input.firmId);
      if (status === null) return TEL;
      if ('reason' in status) return UNAVAILABLE;
      return { provider: 'twilio', cadence: status.cadence };
    },

    async startCall(input) {
      const mine = generation;
      startRequest += 1;
      const request = startRequest;
      currentRequestId = input.requestId;
      /** Cancelled, superseded by another start, or another person signed in. */
      const gone = (): boolean => stale(mine) || request !== startRequest;
      const refused = (reason: string): CallStart => ({ ok: false, reason: reason.slice(0, 80) });
      // 1. The cadence and the voicemail values. Not twilio (404) is a refusal here: the
      //    page only asks this after `callingStatus` said twilio, and it goes back to it.
      const status = await readCallingStatus(input.firmId);
      if (gone()) return refused('call_cancelled');
      if (status === null) return refused('calling_off');
      if ('reason' in status) return refused(status.reason);

      // The card the Call button is on: its route at the version shown, and the person's
      // own verified identity. A card that is not open is not a call to place.
      const page = expanded;
      const route = page?.firmId === input.firmId ? page.routes.find(entry => entry.routeId === input.routeId) : undefined;
      if (page === null || route === undefined) return refused('route_missing');
      if (page.callingIdentityId === null) return refused('identity_missing');

      // 2. The session: the server resolves the number and takes the whole decision.
      const contactId = route.contactId ?? input.contactId;
      const created = await deps.api.command(
        '/calls/session',
        {
          firmId: input.firmId,
          ...(contactId === null ? {} : { contactId }),
          routeId: route.routeId,
          routeVersion: route.version,
          callingIdentityId: page.callingIdentityId,
        },
        value => callSessionCreatedSchema.parse(value),
      );
      if (gone()) return refused('call_cancelled');
      if (!created.ok) return refused(created.reason);

      // 3. The token the Device connects with.
      const token = await deps.api.read('/calls/access-token', value => voiceAccessTokenResponseSchema.parse(value), {});
      if (gone()) return refused('call_cancelled');
      if (!token.ok) return refused(token.reason);

      // The outcome form records this call: the number (already on the card) and the session.
      lastCall = { firmId: input.firmId, routeId: route.routeId, contactId, e164: route.e164 };
      lastSession = { firmId: input.firmId, routeId: route.routeId, sessionId: created.value.sessionId };
      lastSessionRequest = request;
      const attempt = status.cadence.nextAttempt;
      const contactName = page.tasks.find(task => task.contactId !== null && task.contactId === contactId)?.contactName ?? null;
      return {
        ok: true,
        sessionId: created.value.sessionId,
        token: token.value.token,
        attempt,
        voicemailScript:
          attempt !== null && CALL_CADENCE.voicemailAttempts.includes(attempt)
            ? renderVoicemailScript(status.voicemailTemplate, {
                contactFirstName: firstNameOf(contactName),
                firmName: page.firmName,
                callerName: status.callerName,
                callbackNumber: status.callbackNumber,
              })
            : null,
      };
    },

    async cancelCall(input) {
      // A cancel for a press that is no longer the current one (a newer start took over):
      // that start is already superseded, and the newer one is not this cancel's to undo.
      if (currentRequestId === null || input.requestId !== currentRequestId) {
        return await Promise.resolve({ cancelled: false });
      }
      // The page gave up on the current start before its call connected. A session it
      // bound is unbound, with the number the outcome form would have named; a start
      // still on the wire binds nothing when it answers.
      if (lastSessionRequest !== null && lastSessionRequest === startRequest && lastSession !== null) {
        const cancelled = lastSession;
        lastSession = null;
        lastSessionRequest = null;
        if (lastCall !== null && lastCall.firmId === cancelled.firmId && lastCall.routeId === cancelled.routeId) lastCall = null;
      }
      startRequest += 1;
      currentRequestId = null;
      return await Promise.resolve({ cancelled: true });
    },

    async setCallActive(input) {
      deps.callActivity?.set(input.active);
      return await Promise.resolve({ active: deps.callActivity?.active() ?? input.active });
    },

    async resumeCalling(input) {
      const mine = generation;
      await deps.api.command('/calls/cadence/resume', { firmId: input.firmId }, () => null);
      const status = await host.callingStatus(input);
      // The parking hold made `/dial/check` answer "not callable": the open card's advice
      // is read again, or Call would stay disabled after Resume (review of C1, fold 1, P2).
      const page = expanded;
      if (!stale(mine) && page !== null && page.firmId === input.firmId) {
        const advice = await adviseRoutes(page, mine);
        if (!stale(mine)) dialAdvice = advice;
      }
      return status;
    },

    async callHistory(input) {
      const answer = await deps.api.read(
        // Slice C3b: with each call's summary and suggested next steps, when it has one.
        `/calls/history?firmId=${encodeURIComponent(input.firmId)}&include=summary,outcome`,
        value => callHistoryResponseSchema.parse(value),
      );
      return { calls: answer.ok ? answer.value.calls : null };
    },

    async callRecording(input) {
      const answer = await deps.api.read(
        `/calls/recording?sessionId=${encodeURIComponent(input.sessionId)}`,
        value => callRecordingResponseSchema.parse(value),
      );
      return answer.ok ? { recording: answer.value, reason: null } : { recording: null, reason: answer.reason.slice(0, 80) };
    },

    async callTranscript(input) {
      const answer = await deps.api.read(
        `/calls/transcript?callSessionId=${encodeURIComponent(input.callSessionId)}`,
        value => callTranscriptResponseSchema.parse(value),
      );
      if (answer.ok) return { transcript: answer.value, reason: null };
      // No transcript is not a failure: the call simply has none, and the page shows nothing.
      return { transcript: null, reason: answer.reason === 'not_found' ? null : answer.reason.slice(0, 80) };
    },
  };

  /**
   * `GET /calls/calling` for one firm: the status, null for the server's calling-off
   * answer (`not_found`), or the reason it could not say.
   */
  async function readCallingStatus(
    firmId: string,
  ): Promise<z.infer<typeof callingStatusResponseSchema> | { readonly reason: string } | null> {
    const answer = await deps.api.read(`/calls/calling?firmId=${encodeURIComponent(firmId)}`, value =>
      callingStatusResponseSchema.parse(value),
    );
    if (answer.ok) return answer.value;
    if (answer.reason === 'not_found') return null;
    return { reason: answer.reason };
  }
  return host;
}
