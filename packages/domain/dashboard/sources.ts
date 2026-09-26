import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The parts of 13.4's dashboard whose tables other lanes own.
 *
 * Section 13.4 asks for emails sent, skipped, held and unknown; reply and
 * positive-reply rates; provider deferrals and reputation warnings; results by
 * sequence, template version, segment, weekday and local send hour; and classifier
 * cost and drift. (Its LinkedIn handoffs and recorded replies went with LinkedIn on 25
 * September 2026.) Those read the outbound fence and the sending ramp (G7-2, migration
 * 0010), enrollments and step executions (G8, 0012), and the model classification
 * records (G7b, 0011).
 *
 * All three are live. `liveDashboardSources()` (in `sendingSource.ts`) combines
 * `sendingFacts`, `enrollmentFacts` and `classifierFacts`, and it is what the API
 * supplies (`apps/api/src/routes/dashboard.ts`).
 *
 * The interface keeps its declared-unavailable shape, because a figure nobody can
 * compute must say so — `{ available: false, owner, reason }` — rather than render as
 * zero. "No emails were skipped" and "nothing can tell you how many were skipped" are
 * very different sentences to show an operator. `unavailableDashboardSources()` is
 * that shape for all three at once: what `readDashboard` uses when a caller wires no
 * source, which today is the domain tests and nothing else.
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

/** A count against a key from a closed set or an opaque identifier. Never a name. */
export interface KeyedCount {
  readonly key: string;
  readonly count: number;
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
  /** Nothing records a segment yet, so this is always the unavailable shape. */
  readonly bySegment: readonly Breakdown[] | Unavailable;
}

/** 13.4's enrollment half. Read from G8's tables (migration 0012). */
export interface EnrollmentFacts {
  readonly available: true;
  /** Enrollments that started inside the window. */
  readonly started: number;
  /** Live now, not inside the window: a state is a fact about this instant. */
  readonly active: number;
  readonly reviewRequired: number;
  /** Ended inside the window, by `end_reason`. */
  readonly ended: readonly KeyedCount[];
  /** Step executions completed inside the window, by channel. */
  readonly stepsCompleted: readonly KeyedCount[];
  /** Held now, by hold reason code — the vocabulary `hold_reason_codes` fixes. */
  readonly heldSteps: readonly KeyedCount[];
}

/**
 * 13.4's "classifier cost and drift". Read from G7b's tables (migration 0011).
 *
 * **There is no money figure, on purpose.** `mail_classification_calls` records
 * tokens and latency; nothing in this build records a price, and a dashboard that
 * multiplied tokens by a rate hard-coded here would be quoting a number that goes
 * stale silently the next time a price list changes. Tokens are what was measured,
 * so tokens are what is reported.
 */
export interface ClassifierFacts {
  readonly available: true;
  readonly enabled: boolean;
  readonly modelName: string;
  readonly effort: string;
  readonly dailyCallCap: number;
  /** Every prompt version seen in the window, so a change of prompt is visible. */
  readonly promptVersions: readonly string[];
  /** Every attempt, including the ones that deliberately sent nothing. */
  readonly callsAttempted: number;
  readonly callsSent: number;
  /** `accepted`, `refusal`, `malformed`, `disabled`, `capped`, `not_applicable`, … */
  readonly byOutcome: readonly KeyedCount[];
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalLatencyMs: number;
  /** Drift: a person confirmed a reply, and whether they changed the suggestion. */
  readonly confirmations: number;
  readonly accepted: number;
  readonly corrected: number;
  /** `corrected / confirmations`. Null when nobody confirmed one in the window. */
  readonly correctionRate: number | null;
  /** Corrections by who suggested: `deterministic`, `model` or `none`. */
  readonly correctedBySuggester: readonly KeyedCount[];
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

/**
 * Every figure declared unavailable: what `readDashboard` reads when its caller wires
 * no source. The API never does that — it passes `liveDashboardSources()` — so the
 * reasons say "not wired" rather than "not built": every table exists.
 */
export function unavailableDashboardSources(): DashboardSources {
  const absent = (owner: string, reason: string): Unavailable => ({ available: false, owner, reason });
  return {
    sending: async () => await Promise.resolve(absent('G7-2', 'no sending source was wired for this read')),
    enrollments: async () => await Promise.resolve(absent('G8', 'no enrollment source was wired for this read')),
    classifier: async () => await Promise.resolve(absent('G7b', 'no classifier source was wired for this read')),
  };
}
