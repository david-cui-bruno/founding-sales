import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import {
  CUSTOM_TRIGGER_SLUG_PATTERN,
  type PrioritizationRuleDocument,
  type TriggerRuleEntry,
} from './builtinPrioritizationRules';
import { parseCanonicalUtcMillis } from './qualificationEngine';
import type {
  BuiltinStoredTriggerKey,
  PrioritizationReason,
  StoredTriggerKey,
  TriggerEvent,
  TriggerReasonCode,
} from './prioritizationTypes';

const DAY_MILLIS = 86_400_000;

export const BUILTIN_TRIGGER_KEYS: readonly BuiltinStoredTriggerKey[] = [
  'live_vacancy',
  'recent_acquisition',
  'compliance_deadline',
  'recent_permit_maintenance',
  'heating_season',
  'student_turnover',
  'post_storm',
  'tax_season',
  'inbound_demo',
  'direct_referral',
  'rireig_connection',
  'recent_lead_engagement',
  'nurture_resurrection',
];

export function isBuiltinTriggerKey(key: string): key is BuiltinStoredTriggerKey {
  return (BUILTIN_TRIGGER_KEYS as readonly string[]).includes(key);
}

/**
 * Classifies a stored trigger key. A syntactically valid `custom:<slug>` key
 * is legal even when unconfigured; a malformed key or an unknown
 * built-in-like key is corruption.
 */
export function classifyStoredTriggerKey(
  key: string,
): { kind: 'builtin'; key: BuiltinStoredTriggerKey } | { kind: 'custom'; key: `custom:${string}` } {
  if (isBuiltinTriggerKey(key)) return { kind: 'builtin', key };
  if (key.startsWith('custom:')) {
    const slug = key.slice('custom:'.length);
    if (CUSTOM_TRIGGER_SLUG_PATTERN.test(slug)) {
      return { kind: 'custom', key: key as `custom:${string}` };
    }
    throw new PrioritizationInputCorruptionError(`Custom trigger slug is malformed: ${key}`);
  }
  throw new PrioritizationInputCorruptionError(`Unknown stored trigger key: ${key}`);
}

export type TriggerEventContribution = Readonly<{
  eventId: string;
  triggerKey: StoredTriggerKey;
  code: TriggerReasonCode;
  active: boolean;
  contributionMilliPoints: number;
  /** min(recomputed rule threshold, source hard stop), exclusive; null when unbounded. */
  recomputedExpiresAt: string | null;
  effectiveAtMillis: number;
}>;

export type TriggerEvaluation = Readonly<{
  timingMilliPoints: number;
  uncappedMilliPoints: number;
  timingBand: 'cold' | 'warm' | 'hot';
  earliestTriggerExpiresAt: string | null;
  selectedKeys: readonly StoredTriggerKey[];
  reasons: readonly Extract<PrioritizationReason, { kind: 'trigger' }>[];
}>;

function toCanonical(millis: number): string {
  return new Date(millis).toISOString();
}

function assertStrengthMultiplier(event: TriggerEvent): void {
  if (!Number.isFinite(event.strengthMultiplier)
    || event.strengthMultiplier < 0 || event.strengthMultiplier > 2) {
    throw new PrioritizationInputCorruptionError('Trigger strength multiplier must be within 0-2.');
  }
}

type EvaluatedEvent = Readonly<{
  event: TriggerEvent;
  contribution: TriggerEventContribution;
}>;

function ruleEntryFor(
  rule: PrioritizationRuleDocument,
  key: StoredTriggerKey,
): TriggerRuleEntry | null {
  const classified = classifyStoredTriggerKey(key);
  const entry = rule.timing.triggers[key];
  if (entry === undefined) {
    if (classified.kind === 'custom') return null;
    throw new PrioritizationInputCorruptionError(
      `Built-in trigger key is missing from the evaluation rule: ${key}`,
    );
  }
  if (classified.kind === 'custom') {
    if (entry.base < rule.timing.customBaseRange[0]
      || entry.base > rule.timing.customBaseRange[1]) {
      throw new PrioritizationInputCorruptionError('Custom trigger base escapes the rule range.');
    }
    if (entry.rule.function === 'decay'
      && (entry.rule.halfLifeSeconds < rule.timing.customHalfLifeSecondsRange[0]
        || entry.rule.halfLifeSeconds > rule.timing.customHalfLifeSecondsRange[1])) {
      throw new PrioritizationInputCorruptionError('Custom trigger half-life escapes the rule range.');
    }
  }
  return entry;
}

function assertEvidenceMatchesRule(event: TriggerEvent, entry: TriggerRuleEntry): void {
  const evidenceFunction = event.evidence.function;
  const expected = entry.rule.function === 'decay'
    ? 'decaying'
    : entry.rule.function === 'approaching' ? 'approaching' : 'windowed';
  if (evidenceFunction !== expected) {
    throw new PrioritizationInputCorruptionError(
      `Trigger evidence function ${evidenceFunction} does not match the rule function for ${event.triggerType}.`,
    );
  }
  if (event.evidence.triggerType !== event.triggerType) {
    throw new PrioritizationInputCorruptionError('Trigger evidence key must match the stored key.');
  }
}

function evaluateEvent(input: {
  event: TriggerEvent;
  entry: TriggerRuleEntry | null;
  evaluatedAtMillis: number;
  rule: PrioritizationRuleDocument;
}): TriggerEventContribution {
  const { event, entry, evaluatedAtMillis, rule } = input;
  assertStrengthMultiplier(event);
  const effectiveAtMillis = parseCanonicalUtcMillis(event.effectiveAt, 'Trigger effective_at');
  const hardStopMillis = event.expiresAt === null
    ? null
    : parseCanonicalUtcMillis(event.expiresAt, 'Trigger expires_at');
  if (hardStopMillis !== null && hardStopMillis <= effectiveAtMillis) {
    throw new PrioritizationInputCorruptionError(
      'Trigger source hard stop must be later than its effective instant.',
    );
  }
  const inactive = (code: TriggerReasonCode): TriggerEventContribution => Object.freeze({
    eventId: event.id,
    triggerKey: event.triggerType,
    code,
    active: false,
    contributionMilliPoints: 0,
    recomputedExpiresAt: null,
    effectiveAtMillis,
  });

  if (entry === null) return inactive('custom_not_configured');
  assertEvidenceMatchesRule(event, entry);

  const verifiedMultiplier = event.verificationState === 'verified'
    ? 1
    : rule.timing.unverifiedMultiplier;
  const multiplier = event.strengthMultiplier * verifiedMultiplier;

  if (evaluatedAtMillis < effectiveAtMillis) return inactive('not_yet_effective');
  if (hardStopMillis !== null && evaluatedAtMillis >= hardStopMillis) return inactive('expired');

  let unroundedEffective: number;
  let ruleExpirationMillis: number | null;

  if (entry.rule.function === 'decay') {
    const halfLifeMillis = entry.rule.halfLifeSeconds * 1_000;
    const ageMillis = evaluatedAtMillis - effectiveAtMillis;
    unroundedEffective = entry.base * (2 ** (-ageMillis / halfLifeMillis)) * multiplier;
    const startValue = entry.base * multiplier;
    if (startValue < 1) {
      ruleExpirationMillis = effectiveAtMillis;
    } else {
      const thresholdInstant = effectiveAtMillis + halfLifeMillis * Math.log2(startValue);
      ruleExpirationMillis = Math.floor(thresholdInstant) + 1;
    }
  } else if (entry.rule.function === 'window') {
    if (event.evidence.function !== 'windowed') {
      throw new PrioritizationInputCorruptionError('Window rule requires windowed evidence.');
    }
    const startsAtMillis = parseCanonicalUtcMillis(event.evidence.startsAt, 'Window startsAt');
    const endsAtMillis = parseCanonicalUtcMillis(event.evidence.endsAt, 'Window endsAt');
    if (startsAtMillis >= endsAtMillis) {
      throw new PrioritizationInputCorruptionError('Window startsAt must precede endsAt.');
    }
    if (effectiveAtMillis >= endsAtMillis) {
      throw new PrioritizationInputCorruptionError('Window effective_at must precede endsAt.');
    }
    const activeFromMillis = Math.max(effectiveAtMillis, startsAtMillis);
    if (evaluatedAtMillis < activeFromMillis || evaluatedAtMillis >= endsAtMillis) {
      return inactive(evaluatedAtMillis >= endsAtMillis ? 'expired' : 'window_inactive');
    }
    unroundedEffective = entry.base * multiplier;
    ruleExpirationMillis = endsAtMillis;
  } else {
    if (event.evidence.function !== 'approaching') {
      throw new PrioritizationInputCorruptionError('Approaching rule requires approaching evidence.');
    }
    const deadlineMillis = parseCanonicalUtcMillis(event.evidence.deadlineAt, 'Approaching deadlineAt');
    const holdEndMillis = deadlineMillis + entry.rule.holdAfterDeadlineDays * DAY_MILLIS;
    if (evaluatedAtMillis >= holdEndMillis) return inactive('expired');
    const controlPoints = entry.rule.controlPoints;
    if (controlPoints.length === 0) {
      throw new PrioritizationInputCorruptionError('Approaching rule requires control points.');
    }
    for (const [days, fraction] of controlPoints) {
      if (!Number.isFinite(days) || days < 0 || !Number.isFinite(fraction)
        || fraction < 0 || fraction > 1) {
        throw new PrioritizationInputCorruptionError('Approaching control points must be 0-1 factors.');
      }
    }
    for (let index = 1; index < controlPoints.length; index += 1) {
      if (controlPoints[index]![0] >= controlPoints[index - 1]![0]) {
        throw new PrioritizationInputCorruptionError(
          'Approaching control points must be sorted by decreasing days-before-deadline.',
        );
      }
    }
    const daysBefore = (deadlineMillis - evaluatedAtMillis) / DAY_MILLIS;
    const firstPoint = controlPoints[0]!;
    const lastPoint = controlPoints[controlPoints.length - 1]!;
    let fraction: number;
    if (daysBefore > firstPoint[0]) {
      fraction = 0;
    } else if (daysBefore <= lastPoint[0]) {
      fraction = lastPoint[1];
    } else {
      fraction = firstPoint[1];
      for (let index = 1; index < controlPoints.length; index += 1) {
        const previous = controlPoints[index - 1]!;
        const next = controlPoints[index]!;
        if (daysBefore <= previous[0] && daysBefore > next[0]) {
          const span = previous[0] - next[0];
          const progress = (previous[0] - daysBefore) / span;
          fraction = previous[1] + (next[1] - previous[1]) * progress;
          break;
        }
      }
    }
    unroundedEffective = entry.base * fraction * multiplier;
    ruleExpirationMillis = holdEndMillis;
  }

  if (unroundedEffective < 1) return inactive('below_threshold');

  const expirationMillis = hardStopMillis === null
    ? ruleExpirationMillis
    : ruleExpirationMillis === null
      ? hardStopMillis
      : Math.min(ruleExpirationMillis, hardStopMillis);

  return Object.freeze({
    eventId: event.id,
    triggerKey: event.triggerType,
    code: 'active',
    active: true,
    contributionMilliPoints: Math.round(unroundedEffective * 1_000),
    recomputedExpiresAt: expirationMillis === null ? null : toCanonical(expirationMillis),
    effectiveAtMillis,
  });
}

function compareForSelection(
  left: TriggerEventContribution,
  right: TriggerEventContribution,
): number {
  if (left.contributionMilliPoints !== right.contributionMilliPoints) {
    return right.contributionMilliPoints - left.contributionMilliPoints;
  }
  const leftExpiration = left.recomputedExpiresAt;
  const rightExpiration = right.recomputedExpiresAt;
  if ((leftExpiration === null) !== (rightExpiration === null)) {
    return leftExpiration === null ? 1 : -1;
  }
  if (leftExpiration !== null && rightExpiration !== null && leftExpiration !== rightExpiration) {
    return leftExpiration < rightExpiration ? -1 : 1;
  }
  if (left.effectiveAtMillis !== right.effectiveAtMillis) {
    return left.effectiveAtMillis - right.effectiveAtMillis;
  }
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

/**
 * Pure trigger evaluation: integer milliseconds/thousandths at every
 * comparison boundary, strongest active event per full stored key, capped sum,
 * earliest recomputed expiration among selected contributors, and stable
 * full explanations.
 */
export function evaluateTriggers(input: {
  events: readonly TriggerEvent[];
  rule: PrioritizationRuleDocument;
  evaluatedAt: string;
}): TriggerEvaluation {
  const evaluatedAtMillis = parseCanonicalUtcMillis(input.evaluatedAt, 'evaluatedAt');
  const byId = new Map<string, TriggerEvent>();
  for (const event of input.events) {
    const existing = byId.get(event.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new PrioritizationInputCorruptionError(
          'Trigger input contains duplicate IDs with different facts.',
        );
      }
      continue;
    }
    byId.set(event.id, event);
  }
  const events = [...byId.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));

  const evaluated: EvaluatedEvent[] = events.map((event) => ({
    event,
    contribution: evaluateEvent({
      event,
      entry: ruleEntryFor(input.rule, event.triggerType),
      evaluatedAtMillis,
      rule: input.rule,
    }),
  }));

  const byKey = new Map<StoredTriggerKey, TriggerEventContribution[]>();
  for (const { contribution } of evaluated) {
    const bucket = byKey.get(contribution.triggerKey) ?? [];
    bucket.push(contribution);
    byKey.set(contribution.triggerKey, bucket);
  }

  const winners = new Map<StoredTriggerKey, TriggerEventContribution>();
  for (const [key, contributions] of byKey) {
    const active = contributions.filter((contribution) => contribution.active);
    if (active.length === 0) continue;
    active.sort(compareForSelection);
    winners.set(key, active[0]!);
  }

  const selected = [...winners.values()];
  const uncappedMilliPoints = selected.reduce(
    (sum, winner) => sum + winner.contributionMilliPoints,
    0,
  );
  const timingMilliPoints = Math.min(uncappedMilliPoints, input.rule.timing.capMilliPoints);
  const timingBand = timingMilliPoints <= input.rule.timing.bands.coldMaxMilliPoints
    ? 'cold' as const
    : timingMilliPoints <= input.rule.timing.bands.warmMaxMilliPoints
      ? 'warm' as const
      : 'hot' as const;

  let earliestTriggerExpiresAt: string | null = null;
  for (const winner of selected) {
    if (winner.contributionMilliPoints <= 0 || winner.recomputedExpiresAt === null) continue;
    if (earliestTriggerExpiresAt === null
      || winner.recomputedExpiresAt < earliestTriggerExpiresAt) {
      earliestTriggerExpiresAt = winner.recomputedExpiresAt;
    }
  }

  const reasons = evaluated.map(({ contribution }) => {
    const winner = winners.get(contribution.triggerKey) ?? null;
    const isSelected = winner !== null && winner.eventId === contribution.eventId;
    return Object.freeze({
      kind: 'trigger' as const,
      triggerKey: contribution.triggerKey,
      eventId: contribution.eventId,
      code: contribution.active && !isSelected ? 'suppressed' as const : contribution.code,
      selected: isSelected,
      contributed: isSelected && contribution.contributionMilliPoints > 0,
      contributionMilliPoints: contribution.contributionMilliPoints,
      winningEventId: winner === null ? null : winner.eventId,
      recomputedExpiresAt: contribution.recomputedExpiresAt,
    });
  });
  reasons.sort((left, right) => {
    if (left.triggerKey !== right.triggerKey) {
      return left.triggerKey < right.triggerKey ? -1 : 1;
    }
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
  });

  const selectedKeys = [...winners.keys()].sort();

  return Object.freeze({
    timingMilliPoints,
    uncappedMilliPoints,
    timingBand,
    earliestTriggerExpiresAt,
    selectedKeys: Object.freeze(selectedKeys),
    reasons: Object.freeze(reasons),
  });
}
