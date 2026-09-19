import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../../src/shared/contracts/ownerCommandContract';
import { placesQueryGrid } from '../../../../../src/main/research/placesDiscoveryProvider';
import type { SetResearchConfigCommand, StatePostureRecord } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { guidedResearchMarkerKey } from '../researchSetup';
import type { FirmCard } from './firms';
import { EASTERN, localParts } from './localClock';
import { stateClearance } from './postures';

/**
 * The research counters and the research configuration (FSS target design section 2; slice S4).
 *
 *   COUNTER#pool             researched, unlisted and posture-cleared firms, so the scheduler can ask "is there
 *                            enough for the next morning?" with one read instead of scanning every firm.
 *   COUNTER#<date>#research  what today's research has already spent against its budget, TTL three days. The
 *                            dates are America/New_York, like every other date in this system.
 *   SETTINGS#research        the query grid, the daily budget and the operator descriptor's window.
 *
 * The pool counter is maintained from two places and from nowhere else: `research.firm` adds the firm it just
 * researched, and `day.build` recounts exactly from the firms it already read for the list. The incremental
 * side can drift (a firm suppressed between two builds, a posture recorded); the morning recount is what makes
 * it true again, which is why the number the scheduler gates on is refreshed every day before it matters.
 *
 * The budget is a count of provider calls, not of dollars: one Places page or one firm's research is one unit.
 * Spending is recorded before the call, so a call whose response is lost still costs what it reserved and is
 * never silently re-issued. `budget_exhausted` is one of the design's thirteen hold reasons, and it is what a
 * scheduler tick says when it stops enqueueing rather than quietly doing nothing.
 *
 * The configuration migrates itself out of the records the old research path already keeps (`OWNER_RESEARCH_SOURCE`
 * and `GUIDED_RESEARCH_SETUP`) the first time it is read, and never deletes them: the old tick keeps running
 * until the legacy research switch takes its phases away, and S6 is what retires those items.
 */

const instant = accountInstantSchema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------------------------------------
// COUNTER#pool
// ---------------------------------------------------------------------------------------------------------

export const POOL_COUNTER_KEY = 'COUNTER#pool';
export const poolCounterKey = (): string => POOL_COUNTER_KEY;
export const poolCounterSchema = z.strictObject({
  version: z.literal(1),
  /** Firms with research evidence behind them that are not suppressed. */
  researched: count,
  /** Of those, the ones no morning list has ever carried. */
  unlisted: count,
  /** Of those, the ones the next list build could actually offer: state and zone known, posture calling, a phone. */
  postureCleared: count,
  updatedAt: instant,
});
export type PoolCounter = z.infer<typeof poolCounterSchema>;
export type PoolCounts = Pick<PoolCounter, 'researched' | 'unlisted' | 'postureCleared'>;

/** The counts as they stand, or three zeros when nothing has been counted yet. Never throws on a malformed row. */
export async function readPoolCounter(store: DynamoStore): Promise<PoolCounts & { updatedAt: string | null }> {
  const row = await store.get<unknown>(POOL_COUNTER_KEY);
  const parsed = row ? poolCounterSchema.safeParse(row.data) : null;
  if (!parsed?.success) return { researched: 0, unlisted: 0, postureCleared: 0, updatedAt: null };
  const { researched, unlisted, postureCleared, updatedAt } = parsed.data;
  return { researched, unlisted, postureCleared, updatedAt };
}

/** One `COUNTER#pool` write, compare-and-set on what was read. For the caller's own transaction. */
export async function planPoolCounter(store: DynamoStore, counts: PoolCounts): Promise<TransactWriteItem[]> {
  const row = await store.get<unknown>(POOL_COUNTER_KEY);
  return [store.put(POOL_COUNTER_KEY, poolCounterSchema.parse({ version: 1, ...counts, updatedAt: store.now() }), row?.rev ?? null)];
}

export async function writePoolCounter(store: DynamoStore, counts: PoolCounts): Promise<void> {
  await store.transact(await planPoolCounter(store, counts));
}

/**
 * The counts from the firms the caller already has. Pure, and deliberately the same conditions the list build
 * applies, so the number the scheduler gates on and the number the morning offers cannot mean different things.
 */
export function poolCountsOf(input: { firms: readonly FirmCard[]; postures: ReadonlyMap<string, StatePostureRecord>; listedBefore: ReadonlySet<string>; now: string }): PoolCounts {
  let researched = 0, unlisted = 0, postureCleared = 0;
  for (const firm of input.firms) {
    if (firm.suppressed) continue;
    // Evidence behind the firm, in either shape: fetched sources on the old record, or a research revision on the new one.
    if (firm.sourceCount === 0 && firm.researchRevision === 0) continue;
    researched++;
    if (input.listedBefore.has(firm.firmId) || firm.calls > 0) continue;
    unlisted++;
    if (!firm.state || !firm.timeZone || !firm.phone) continue;
    if (!stateClearance(input.postures, firm.state, input.now).cleared) continue;
    postureCleared++;
  }
  return { researched, unlisted, postureCleared };
}

// ---------------------------------------------------------------------------------------------------------
// COUNTER#<easternDate>#research
// ---------------------------------------------------------------------------------------------------------

export const researchCounterKey = (easternDate: string): string => `COUNTER#${z.iso.date().parse(easternDate)}#research`;
/** Design section 2: the send and research counters keep three days. */
export const RESEARCH_COUNTER_TTL_SECONDS = 3 * 24 * 3600;
export const researchCounterSchema = z.strictObject({
  version: z.literal(1), date: z.iso.date(), spent: count, budget: count, updatedAt: instant,
});
export type ResearchCounter = z.infer<typeof researchCounterSchema>;

export async function readResearchCounter(store: DynamoStore, easternDate: string): Promise<ResearchCounter | null> {
  const row = await store.get<unknown>(researchCounterKey(easternDate));
  const parsed = row ? researchCounterSchema.safeParse(row.data) : null;
  return parsed?.success ? parsed.data : null;
}

/** What is left to spend today, without spending any of it. */
export async function remainingResearchToday(store: DynamoStore, now?: string): Promise<{ date: string; spent: number; budget: number; remaining: number }> {
  const at = now ?? store.now();
  const date = localParts(at, EASTERN).date;
  const [counter, settings] = await Promise.all([readResearchCounter(store, date), readResearchSettings(store)]);
  const budget = counter?.budget ?? settings.record.dailyBudget;
  const spent = counter?.spent ?? 0;
  return { date, spent, budget, remaining: Math.max(0, budget - spent) };
}

/** `charged` is the only thing a caller should branch on: false means nothing was spent and nothing may be fetched. */
export type ResearchSpend = { charged: boolean; spent: number; budget: number; exhausted: boolean; reason: 'budget_exhausted' | null };

/**
 * Records `units` of research spend against today's counter, before the work they pay for. A counter that is
 * already at or past its budget refuses rather than going further: the refusal is `budget_exhausted`, the hold
 * reason the design names, and the counter is left exactly as it was.
 */
export async function spendResearch(store: DynamoStore, input: { units: number; now?: string }): Promise<ResearchSpend> {
  const units = z.number().int().positive().max(1000).parse(input.units);
  const at = input.now ?? store.now();
  const date = localParts(at, EASTERN).date;
  const key = researchCounterKey(date);
  const row = await store.get<unknown>(key);
  const held = row ? researchCounterSchema.safeParse(row.data) : null;
  const budget = held?.success ? held.data.budget : (await readResearchSettings(store)).record.dailyBudget;
  const spent = held?.success ? held.data.spent : 0;
  if (spent >= budget) return { charged: false, spent, budget, exhausted: true, reason: 'budget_exhausted' };
  const next = researchCounterSchema.parse({ version: 1, date, spent: spent + units, budget, updatedAt: store.now() });
  const ttl = Math.floor(Date.parse(at) / 1000) + RESEARCH_COUNTER_TTL_SECONDS;
  try { await store.transact([store.put(key, next, row?.rev ?? null, { ttl })]); }
  catch {
    // Another job spent first. Re-read rather than overwrite: nobody's spend is ever lost to a race.
    const now = await readResearchCounter(store, date);
    const settled = now ?? next;
    return { charged: settled !== null, spent: settled.spent, budget: settled.budget, exhausted: settled.spent >= settled.budget,
      reason: settled.spent >= settled.budget ? 'budget_exhausted' : null };
  }
  return { charged: true, spent: next.spent, budget, exhausted: next.spent >= budget, reason: next.spent >= budget ? 'budget_exhausted' : null };
}

// ---------------------------------------------------------------------------------------------------------
// SETTINGS#research
// ---------------------------------------------------------------------------------------------------------

export const RESEARCH_SETTINGS_KEY = 'SETTINGS#research';
/** The ceiling is fixed in code and the command may only narrow below it, exactly as the sending limit is. */
export const RESEARCH_DAILY_BUDGET_CEILING = 200;
/** Enough for a morning's thirty firms and the pages that find them, well under the ceiling. */
export const RESEARCH_DAILY_BUDGET_DEFAULT = 60;
export const RESEARCH_QUERIES_MAX = 400;

export const researchDescriptorSchema = z.strictObject({
  reviewedAt: instant,
  expiresAt: instant,
  /** Computed on every read from the two instants; stored so a view that only reads the record still agrees. */
  status: z.enum(['reviewed', 'expired']),
});
export type ResearchDescriptor = z.infer<typeof researchDescriptorSchema>;

export const researchSettingsSchema = z.strictObject({
  version: z.literal(1),
  /** The Places text queries, already expanded from terms and regions. Replaced whole by the command. */
  queries: z.array(z.string().trim().min(1).max(500)).max(RESEARCH_QUERIES_MAX),
  dailyBudget: z.number().int().nonnegative().max(RESEARCH_DAILY_BUDGET_CEILING),
  descriptor: researchDescriptorSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: instant,
});
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;

/** The descriptor's status at this instant. A window that has not opened yet is as unusable as one that closed. */
export function descriptorStatusAt(descriptor: Pick<ResearchDescriptor, 'reviewedAt' | 'expiresAt'> | null, now: string): 'reviewed' | 'expired' | null {
  if (!descriptor) return null;
  const at = Date.parse(now);
  return Date.parse(descriptor.reviewedAt) <= at && at < Date.parse(descriptor.expiresAt) ? 'reviewed' : 'expired';
}

/**
 * `SETTINGS#research`, migrating it into existence on the first read. The queries come from the audience the old
 * research configuration already carries, expanded through exactly the carried grid function, so the new path
 * sweeps the same territory the old one did. There is no durable record of the operator descriptor's window —
 * it arrives as an environment-supplied reviewed capability — so the migrated descriptor is null, and David
 * records it through `set_research_config`. Neither old item is read destructively or removed.
 */
export async function readResearchSettings(store: DynamoStore, now?: string): Promise<{ record: ResearchSettings; rev: number }> {
  const at = now ?? store.now();
  const row = await store.get<unknown>(RESEARCH_SETTINGS_KEY);
  const parsed = row ? researchSettingsSchema.safeParse(row.data) : null;
  if (parsed?.success) return { record: withDescriptorStatus(parsed.data, at), rev: row!.rev };
  const migrated = researchSettingsSchema.parse({ version: 1, queries: await migratedQueries(store),
    dailyBudget: RESEARCH_DAILY_BUDGET_DEFAULT, descriptor: null, revision: 1, updatedAt: store.now() });
  try { await store.transact([store.put(RESEARCH_SETTINGS_KEY, migrated, row?.rev ?? null)]); }
  catch {
    // Another reader migrated first, or a malformed row stands in the way. Read once more; theirs wins.
    const again = await store.get<unknown>(RESEARCH_SETTINGS_KEY);
    const settled = again ? researchSettingsSchema.safeParse(again.data) : null;
    if (settled?.success) return { record: withDescriptorStatus(settled.data, at), rev: again!.rev };
    return { record: withDescriptorStatus(migrated, at), rev: row?.rev ?? 0 };
  }
  return { record: withDescriptorStatus(migrated, at), rev: (row?.rev ?? 0) + 1 };
}

function withDescriptorStatus(record: ResearchSettings, now: string): ResearchSettings {
  const status = descriptorStatusAt(record.descriptor, now);
  return record.descriptor === null || status === null || status === record.descriptor.status
    ? record : { ...record, descriptor: { ...record.descriptor, status } };
}

/** The old configuration's audience, expanded through the carried grid. An absent or unreadable row is no queries. */
async function migratedQueries(store: DynamoStore): Promise<string[]> {
  const [source, marker] = await Promise.all([store.get<unknown>(ownerResearchSourceKey()), store.get<unknown>(guidedResearchMarkerKey)]);
  // The guided marker is read only so the migration is recorded against a configuration the old path actually set up.
  if (!source && !marker) return [];
  const parsed = source ? ownerResearchSourceSchema.safeParse(source.data) : null;
  if (!parsed?.success || !parsed.data.research) return [];
  try { return placesQueryGrid(parsed.data.research.audience).slice(0, RESEARCH_QUERIES_MAX); } catch { return []; }
}

export type ResearchConfigRefusal = 'revision_stale' | 'budget_above_ceiling' | 'no_change';
export type ResearchConfigPlan = { outcome: 'planned'; items: TransactWriteItem[]; record: ResearchSettings } | { outcome: 'refused'; reason: ResearchConfigRefusal };

/**
 * The writes of one `set_research_config`. The queries are replaced whole (the command carries the list David
 * wants swept, not a patch); the daily budget may only be set below the ceiling fixed in code, so a command can
 * narrow the day's research but never widen it past what the code allows. Fenced on the revision David read, so
 * a stale Settings screen cannot overwrite a newer decision. Nothing here enqueues or spends anything.
 */
export async function planSetResearchConfig(store: DynamoStore, command: SetResearchConfigCommand): Promise<ResearchConfigPlan> {
  const held = await readResearchSettings(store);
  if (command.expectedRevision !== held.record.revision) return { outcome: 'refused', reason: 'revision_stale' };
  if (command.dailyBudget !== undefined && command.dailyBudget > RESEARCH_DAILY_BUDGET_CEILING) return { outcome: 'refused', reason: 'budget_above_ceiling' };
  const now = store.now();
  const descriptor = command.descriptor === undefined ? held.record.descriptor
    : { reviewedAt: command.descriptor.reviewedAt, expiresAt: command.descriptor.expiresAt,
      status: descriptorStatusAt(command.descriptor, now) ?? 'expired' };
  const next = researchSettingsSchema.parse({ version: 1,
    queries: command.queries === undefined ? held.record.queries : [...command.queries].slice(0, RESEARCH_QUERIES_MAX),
    dailyBudget: command.dailyBudget ?? held.record.dailyBudget,
    descriptor, revision: held.record.revision + 1, updatedAt: now });
  const unchanged = JSON.stringify({ ...next, revision: 0, updatedAt: '' }) === JSON.stringify({ ...held.record, revision: 0, updatedAt: '' });
  if (unchanged) return { outcome: 'refused', reason: 'no_change' };
  return { outcome: 'planned', items: [store.put(RESEARCH_SETTINGS_KEY, next, held.rev)], record: next };
}
