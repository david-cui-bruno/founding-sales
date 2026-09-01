/**
 * Pure scoring functions: Fit (static signals) and Timing (decayed trigger
 * mass). No I/O, no clock reads — `now` is always a parameter so every rule
 * is unit-testable at boundaries.
 */
import {
  TRIGGER_TYPES,
  type CloudSourceEvent,
  type TriggerType,
} from "@callie-sourcing/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fit: static signal weights
// ---------------------------------------------------------------------------

/**
 * Fit weight table (agreed design spec). `prior_tool_adoption` has no signal
 * source yet: it is kept in the table but never observable, so it neither
 * earns points nor enters the normalization denominator.
 */
export const FIT_WEIGHTS = {
  portfolio_in_band: 15,
  live_vacancy: 15,
  recent_acquisition: 15,
  open_compliance_deadline: 12,
  self_managed_at_distance: 10,
  pre_1940_stock: 8,
  reachable_direct_contact: 8,
  llc_owner_no_pm: 7,
  prior_tool_adoption: 5,
  active_permit_recent: 5,
} as const;

export type FitSignal = keyof typeof FIT_WEIGHTS;

export interface ScoreReason {
  signal: string;
  contribution: number;
}

/** One trigger occurrence, extracted from an event. */
export interface TriggerInstance {
  type: TriggerType;
  weight: number;
  half_life_days: number | null;
  window: { opens_at: string; peaks_at: string; closes_at: string } | null;
  /** When the underlying fact was observed (event.observed_at). */
  observed_at: string;
}

/**
 * Entity-level context assembled by the handler: triggers from the entity's
 * recent events (including the scored event's own trigger) plus resolved
 * attributes from the entities table when available.
 */
export interface EntityContext {
  recentTriggers?: TriggerInstance[];
  /** From the entities table; null = known-unknown, undefined = no data. */
  ownerKind?: "individual" | "llc" | "trust" | "other" | null;
  /** Doors count from the entities table; overrides portfolio_hint. */
  portfolioDoors?: number | null;
  now?: Date;
}

interface SignalObservation {
  observable: boolean;
  earned: number;
}

function ageDays(observedAt: string, now: Date): number {
  return (now.getTime() - new Date(observedAt).getTime()) / DAY_MS;
}

function triggersOfType(context: EntityContext, type: TriggerType): TriggerInstance[] {
  return (context.recentTriggers ?? []).filter((t) => t.type === type);
}

function isWindowActive(
  window: { opens_at: string; peaks_at: string; closes_at: string } | null,
  now: Date,
): boolean {
  if (!window) return false;
  const t = now.getTime();
  return t >= new Date(window.opens_at).getTime() && t <= new Date(window.closes_at).getTime();
}

/**
 * Per-signal observation. Observability rule: null/absent data means the
 * signal is UNOBSERVABLE (excluded from the denominator); observed-false
 * earns 0 but stays in the denominator.
 */
function observeFitSignals(
  event: CloudSourceEvent,
  context: EntityContext,
  now: Date,
): Record<FitSignal, SignalObservation> {
  const flags = event.signal_flags;
  const property = event.entity.property;
  const person = event.entity.person;
  const payload = event.payload as Record<string, unknown>;

  // portfolio 5-30 doors: 10-19 = full 15, 5-9 or 20-30 = 10, else 0.
  const doors = context.portfolioDoors ?? flags.portfolio_hint;
  const portfolio: SignalObservation =
    typeof doors === "number"
      ? {
          observable: true,
          earned:
            doors >= 10 && doors <= 19
              ? FIT_WEIGHTS.portfolio_in_band
              : (doors >= 5 && doors <= 9) || (doors >= 20 && doors <= 30)
                ? 10
                : 0,
        }
      : { observable: false, earned: 0 };

  // live vacancy: an frbo listing IS an observed vacancy.
  const vacancyObservable = flags.vacancy !== null || event.channel === "frbo";
  const vacancy: SignalObservation = {
    observable: vacancyObservable,
    earned:
      flags.vacancy === true || event.channel === "frbo" ? FIT_WEIGHTS.live_vacancy : 0,
  };

  // recent acquisition: needs a deed_transfer trigger to observe at all.
  const deeds = triggersOfType(context, "deed_transfer");
  const acquisition: SignalObservation =
    deeds.length > 0
      ? {
          observable: true,
          earned: deeds.some((t) => ageDays(t.observed_at, now) < 365)
            ? FIT_WEIGHTS.recent_acquisition
            : 0,
        }
      : { observable: false, earned: 0 };

  // open compliance deadline: violation_opened present, or lead_cert_window
  // currently active.
  const violations = triggersOfType(context, "violation_opened");
  const leadCerts = triggersOfType(context, "lead_cert_window");
  const compliance: SignalObservation =
    violations.length > 0 || leadCerts.length > 0
      ? {
          observable: true,
          earned:
            violations.length > 0 || leadCerts.some((t) => isWindowActive(t.window, now))
              ? FIT_WEIGHTS.open_compliance_deadline
              : 0,
        }
      : { observable: false, earned: 0 };

  // self-managing at distance: both halves must be known.
  const absentee = payload["absentee"];
  const selfManagedAtDistance: SignalObservation =
    flags.self_managed !== null && typeof absentee === "boolean"
      ? {
          observable: true,
          earned:
            flags.self_managed && absentee ? FIT_WEIGHTS.self_managed_at_distance : 0,
        }
      : { observable: false, earned: 0 };

  const pre1940: SignalObservation =
    property && property.year_built !== null
      ? {
          observable: true,
          earned: property.year_built < 1940 ? FIT_WEIGHTS.pre_1940_stock : 0,
        }
      : { observable: false, earned: 0 };

  // reachable direct contact: a person record makes reachability observable;
  // empty phones+emails = observed absent.
  const reachable: SignalObservation = person
    ? {
        observable: true,
        earned:
          person.phones.length > 0 || person.emails.length > 0
            ? FIT_WEIGHTS.reachable_direct_contact
            : 0,
      }
    : { observable: false, earned: 0 };

  const llc: SignalObservation =
    context.ownerKind !== undefined && context.ownerKind !== null
      ? {
          observable: true,
          earned:
            context.ownerKind === "llc" || context.ownerKind === "trust"
              ? FIT_WEIGHTS.llc_owner_no_pm
              : 0,
        }
      : { observable: false, earned: 0 };

  // No signal source yet: kept in the table, never observable.
  const priorTool: SignalObservation = { observable: false, earned: 0 };

  const permits = triggersOfType(context, "permit_filed");
  const activePermit: SignalObservation =
    permits.length > 0
      ? {
          observable: true,
          earned: permits.some((t) => ageDays(t.observed_at, now) < 180)
            ? FIT_WEIGHTS.active_permit_recent
            : 0,
        }
      : { observable: false, earned: 0 };

  return {
    portfolio_in_band: portfolio,
    live_vacancy: vacancy,
    recent_acquisition: acquisition,
    open_compliance_deadline: compliance,
    self_managed_at_distance: selfManagedAtDistance,
    pre_1940_stock: pre1940,
    reachable_direct_contact: reachable,
    llc_owner_no_pm: llc,
    prior_tool_adoption: priorTool,
    active_permit_recent: activePermit,
  };
}

export interface FitResult {
  fit: number;
  reasons: ScoreReason[];
}

/**
 * Fit 0-100, normalized per event: earned points over the max achievable
 * given which signals are observable for this channel/state, rescaled.
 */
export function fitScore(event: CloudSourceEvent, context: EntityContext = {}): FitResult {
  const now = context.now ?? new Date();
  const observations = observeFitSignals(event, context, now);

  let earned = 0;
  let maxObservable = 0;
  const reasons: ScoreReason[] = [];

  for (const [signal, obs] of Object.entries(observations) as Array<
    [FitSignal, SignalObservation]
  >) {
    if (!obs.observable) continue;
    maxObservable += FIT_WEIGHTS[signal];
    earned += obs.earned;
    if (obs.earned > 0) reasons.push({ signal, contribution: obs.earned });
  }

  reasons.sort((a, b) => b.contribution - a.contribution);
  const fit =
    maxObservable === 0 ? 0 : Math.min(100, Math.round((100 * earned) / maxObservable));
  return { fit, reasons };
}

// ---------------------------------------------------------------------------
// Timing: decayed trigger mass
// ---------------------------------------------------------------------------

/** Fixed mass added by an in-window seasonal trigger. */
export const SEASONAL_WEIGHT = 0.15;

/** UTC calendar windows for seasonal triggers (month/day, inclusive). */
export const SEASONAL_WINDOWS: Partial<
  Record<TriggerType, { start: [number, number]; end: [number, number] }>
> = {
  heating_season: { start: [10, 1], end: [3, 31] }, // spans year boundary
  student_turnover: { start: [8, 1], end: [9, 30] },
  tax_season: { start: [3, 1], end: [4, 15] },
};

export function isInSeason(type: TriggerType, now: Date): boolean {
  const window = SEASONAL_WINDOWS[type];
  if (!window) return false;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const start = window.start[0] * 100 + window.start[1];
  const end = window.end[0] * 100 + window.end[1];
  // Same-year window vs one spanning the year boundary.
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}

/** Linear 0->1 ramp opens_at..peaks_at, then 1 until closes_at, else 0. */
export function windowRamp(
  window: { opens_at: string; peaks_at: string; closes_at: string },
  now: Date,
): number {
  const t = now.getTime();
  const opens = new Date(window.opens_at).getTime();
  const peaks = new Date(window.peaks_at).getTime();
  const closes = new Date(window.closes_at).getTime();
  if (t < opens || t > closes) return 0;
  if (t >= peaks) return 1;
  if (peaks === opens) return 1;
  return (t - opens) / (peaks - opens);
}

/** Mass contributed by one trigger at `now`. */
export function triggerMass(trigger: TriggerInstance, now: Date): number {
  const kind = TRIGGER_TYPES[trigger.type]?.kind;
  if (kind === "seasonal") {
    return isInSeason(trigger.type, now) ? SEASONAL_WEIGHT : 0;
  }
  if (kind === "informational") return 0; // registry_delta: no decay, no mass
  if (trigger.window) {
    return trigger.weight * windowRamp(trigger.window, now);
  }
  const halfLife = trigger.half_life_days ?? TRIGGER_TYPES[trigger.type]?.half_life_days;
  if (!halfLife || halfLife <= 0) return 0;
  const age = Math.max(0, ageDays(trigger.observed_at, now));
  return trigger.weight * Math.pow(2, -age / halfLife);
}

const COMPOUND_BONUS = 1.5;
const COMPOUND_RECENT_DAYS = 30;
const VACANCYISH: ReadonlySet<TriggerType> = new Set(["frbo_listing"]);
const COMPLIANCE: ReadonlySet<TriggerType> = new Set([
  "violation_opened",
  "lead_cert_window",
]);

function isRecent(trigger: TriggerInstance, now: Date): boolean {
  const age = ageDays(trigger.observed_at, now);
  if (age >= 0 && age <= COMPOUND_RECENT_DAYS) return true;
  // A lead-cert window that is live right now counts as current pressure.
  return trigger.type === "lead_cert_window" && isWindowActive(trigger.window, now);
}

export interface TimingResult {
  timing: number;
  mass: number;
  reasons: ScoreReason[]; // contributions in timing points (each trigger's share)
}

/**
 * Timing 0-100 from decayed trigger mass:
 *   mass  = sum of per-trigger contributions (x1.5 compound bonus when both a
 *           vacancy-ish and a compliance trigger are recent)
 *   timing = 100 x (1 - 2^(-mass))
 * A single fresh weight-1 decay trigger gives mass 1 -> timing 50; mass
 * saturates smoothly toward 100.
 */
export function timingScore(triggers: TriggerInstance[], now: Date): TimingResult {
  const contributions: Array<{ signal: string; mass: number }> = [];
  let mass = 0;

  for (const trigger of triggers) {
    const m = triggerMass(trigger, now);
    if (m <= 0) continue;
    mass += m;
    const kind = TRIGGER_TYPES[trigger.type]?.kind;
    const label =
      kind === "seasonal"
        ? trigger.type
        : trigger.window
          ? `${trigger.type}_window`
          : `${trigger.type}_recent`;
    const existing = contributions.find((c) => c.signal === label);
    if (existing) existing.mass += m;
    else contributions.push({ signal: label, mass: m });
  }

  const hasVacancyish = triggers.some((t) => VACANCYISH.has(t.type) && isRecent(t, now));
  const hasCompliance = triggers.some((t) => COMPLIANCE.has(t.type) && isRecent(t, now));
  if (hasVacancyish && hasCompliance) mass *= COMPOUND_BONUS;

  const timing = mass <= 0 ? 0 : Math.min(100, 100 * (1 - Math.pow(2, -mass)));

  // Express each trigger's contribution as its share of the timing points.
  const totalRaw = contributions.reduce((sum, c) => sum + c.mass, 0);
  const reasons: ScoreReason[] =
    totalRaw <= 0
      ? []
      : contributions
          .map((c) => ({ signal: c.signal, contribution: (c.mass / totalRaw) * timing }))
          .sort((a, b) => b.contribution - a.contribution);

  return { timing: Math.round(timing * 100) / 100, mass, reasons };
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

export interface EventScores {
  fit: number;
  timing: number;
  reasons: ScoreReason[]; // top 1..3 by contribution, integers
}

/**
 * Score one event: fit + timing + merged reasons (top 1..3 by contribution).
 * Always returns at least one reason (schema requires 1..3): a zero-signal
 * event carries {signal: "no_signals", contribution: 0}.
 */
export function scoreEvent(
  event: CloudSourceEvent,
  context: EntityContext,
  now: Date,
): EventScores {
  const fit = fitScore(event, { ...context, now });
  const timing = timingScore(context.recentTriggers ?? [], now);

  const merged = [...fit.reasons, ...timing.reasons]
    .map((r) => ({ signal: r.signal, contribution: Math.round(r.contribution) }))
    .filter((r) => r.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  return {
    fit: fit.fit,
    timing: Math.round(timing.timing),
    reasons: merged.length > 0 ? merged : [{ signal: "no_signals", contribution: 0 }],
  };
}
