import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The parts of 13.4's dashboard whose tables are not on main yet.
 *
 * Section 13.4 asks for emails sent, skipped, held and unknown; reply and
 * positive-reply rates; provider deferrals and reputation warnings; results by
 * sequence, template version, segment, weekday and local send hour; LinkedIn
 * handoffs and recorded replies; and classifier cost and drift. Every one of those
 * reads a table another lane is building right now — the outbound fence and the
 * sending ramp (G7-2), enrollments and step executions (G8), and the model
 * classification records (G7b).
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

/** 13.4's sending half. Owned by G7-2's outbound fence and ramp. */
export interface SendingFacts {
  readonly available: true;
  readonly sent: number;
  readonly skipped: number;
  readonly held: number;
  readonly unknown: number;
  readonly providerDeferrals: number;
  readonly reputationWarnings: number;
  readonly bySequence: readonly Breakdown[];
  readonly byTemplateVersion: readonly Breakdown[];
  readonly bySegment: readonly Breakdown[];
  /** 1 = Monday … 7 = Sunday, in the firm's actual zone (Appendix D). */
  readonly byWeekday: readonly Breakdown[];
  /** `00`–`23`, the local send hour in the firm's actual zone. */
  readonly byLocalSendHour: readonly Breakdown[];
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
