import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The parts of 13.4's dashboard whose tables are not on main yet.
 *
 * Section 13.4 asks for emails sent, skipped, held and unknown; reply and
 * positive-reply rates; provider deferrals and reputation warnings; results by
 * sequence, template version, segment, weekday and local send hour; LinkedIn
 * handoffs and recorded replies; and classifier cost and drift. Every one of those
 * read a table another lane was building when this interface was written — the
 * outbound fence and the sending ramp (G7-2), enrollments and step executions (G8),
 * and the model classification records (G7b).
 *
 * G7-2's migration 0010 has since landed, so `sending` is implemented against it in
 * `sendingSource.ts` and `liveDashboardSources()` is what the API supplies. The two
 * that remain declared-unavailable are the ones whose tables still do not exist.
 *
 * The choice made here is to build the aggregate against an interface with a
 * declared-unavailable default rather than to leave the figures out or to invent a
 * table for them. Three consequences, all of them wanted:
 *
 * * the DTO, the route and the Mac's rendering of these panels exist and are tested
 *   today, against a fake, so the lane that lands the table wires one function
 *   instead of designing a surface;
 * * a figure nobody can compute says so — `{ available: false, owner, expectedIn }`
 *   — rather than rendering as zero, which is the failure this shape exists to
 *   prevent. "No emails were skipped" and "nothing can tell you how many were
 *   skipped" are very different sentences to show an operator;
 * * the seam is named and greppable, so the follow-up is a scheduled piece of work.
 *
 * See `docs/decisions/g9-dashboard-sources.md`.
 */

export interface DashboardWindow {
  /** Inclusive lower bound, UTC. */
  readonly from: string;
  /** Exclusive upper bound, UTC. */
  readonly to: string;
}

/** Which firms the figures are computed over. See `docs/decisions/g9-dashboard-visibility.md`. */
export interface DashboardAudience {
  /** Null for an admin or the system: every firm in the workspace. */
  readonly onlyAssignedTo: string | null;
}

export interface Unavailable {
  readonly available: false;
  /** The lane that will supply it. */
  readonly owner: string;
  /** What is missing, in one phrase an operator can read. */
  readonly reason: string;
}

export interface Breakdown {
  readonly key: string;
  readonly sent: number;
  readonly replies: number;
  readonly positiveReplies: number;
}

/** The primary sending domain, as 12.7's checklist left it. */
export interface DomainPosture {
  readonly domain: string;
  readonly authenticationPasses: boolean;
  readonly automatedSendingEnabled: boolean;
  readonly personalGmailGuardPer24h: number;
}

/** One mailbox's ramp, as 12.7 computes it. `effectiveCap` is derived, never stored. */
export interface RampPosture {
  readonly mailboxId: string;
  readonly healthySendingDays: number;
  readonly effectiveCap: number;
  readonly adminDailyCap: number | null;
  readonly raisedDailyCap: number | null;
  readonly lastHealthFailure: string | null;
}

/**
 * What the sending machinery is currently allowed to do, as against what it did.
 *
 * Both halves respect the read matrix rather than the dashboard's own audience rule:
 * the domain checklist is admin configuration — every `/outbound/*` route is
 * admin-only with a redacted 403 — and a ramp is mailbox diagnostics, which
 * Appendix F row 3 gives to the mailbox's owner or an admin.
 */
export interface SendingPosture {
  /** Null for a salesperson: the checklist is not theirs to read. */
  readonly domain: DomainPosture | null;
  /** Every mailbox for an admin; the caller's own otherwise. */
  readonly ramps: readonly RampPosture[];
}

/** 13.4's sending half. Read from G7-2's outbound fence and ramp (migration 0010). */
export interface SendingFacts {
  readonly available: true;
  /** Fences that reached `sent` with their `sent_at` inside the window. */
  readonly sent: number;
  /** 12.5's admin resolution of an `unknown_terminal` fence as skipped. */
  readonly skipped: number;
  /** The other resolution, kept beside it so the four counts do not lose it. */
  readonly resolvedDelivered: number;
  /** Fences sitting in `held`, by the instant they were held. */
  readonly held: number;
  /** `unknown_terminal` fences nobody has resolved yet — the ones still in doubt. */
  readonly unknown: number;
  /** Provider errors counted against the send days in the window. */
  readonly providerDeferrals: number;
  /** Send days that closed unhealthy (12.7's bounce and opt-out rate floors). */
  readonly reputationWarnings: number;
  readonly posture: SendingPosture;
  /**
   * Keyed by `template_versions.id`, never by the template's name: this DTO carries
   * counts and opaque keys, and a name is the one kind of field a leak can hide in.
   */
  readonly byTemplateVersion: readonly Breakdown[];
  /** 1 = Monday … 7 = Sunday, in the fence's own `source_zone` (Appendix D). */
  readonly byWeekday: readonly Breakdown[];
  /** `00`–`23`, the local send hour in the fence's own `source_zone`. */
  readonly byLocalSendHour: readonly Breakdown[];
  /**
   * The fence carries `enrollment_id`, but the sequence it belongs to is G8's table,
   * and a breakdown keyed by an enrollment id is not the breakdown 13.4 asks for.
   */
  readonly bySequence: readonly Breakdown[] | Unavailable;
  /** Nothing in this build records a segment. G8's enrolment is where one will be. */
  readonly bySegment: readonly Breakdown[] | Unavailable;
}

/** 13.4's LinkedIn and enrollment half. Owned by G8. */
export interface EnrollmentFacts {
  readonly available: true;
  readonly activeEnrollments: number;
  readonly heldEnrollments: number;
  readonly linkedinHandoffs: number;
  readonly linkedinRecordedReplies: number;
}

/** 13.4's "classifier cost and drift". Owned by G7b. */
export interface ClassifierFacts {
  readonly available: true;
  readonly messagesClassified: number;
  readonly totalCostMicros: number;
  readonly modelVersion: string | null;
  readonly promptVersion: string | null;
  /**
   * How often the model's suggestion differed from the disposition a person
   * confirmed, as a fraction of confirmed messages. Null when nobody confirmed one.
   */
  readonly disagreementRate: number | null;
}

export interface DashboardSources {
  sending(
    context: RepositoryContext,
    window: DashboardWindow,
    audience: DashboardAudience,
  ): Promise<SendingFacts | Unavailable>;
  enrollments(
    context: RepositoryContext,
    window: DashboardWindow,
    audience: DashboardAudience,
  ): Promise<EnrollmentFacts | Unavailable>;
  classifier(
    context: RepositoryContext,
    window: DashboardWindow,
    audience: DashboardAudience,
  ): Promise<ClassifierFacts | Unavailable>;
}

/** What the API supplies until the lanes below land. */
export function unavailableDashboardSources(): DashboardSources {
  const absent = (owner: string, reason: string): Unavailable => ({ available: false, owner, reason });
  return {
    sending: async () =>
      await Promise.resolve(absent('G7-2', 'the outbound fence and sending ramp are not in this build')),
    enrollments: async () =>
      await Promise.resolve(absent('G8', 'sequences and enrollments are not in this build')),
    classifier: async () =>
      await Promise.resolve(absent('G7b', 'model classification records are not in this build')),
  };
}
