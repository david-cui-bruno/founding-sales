import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { BUSINESS_EMAIL_SELECTIONS } from '../../../../../src/shared/contracts/accountContract';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../../src/shared/contracts/ownerCommandContract';
import { placesQueryGrid } from '../../../../../src/main/research/placesDiscoveryProvider';
import { REPLY_TEMPLATE_IDS, workerReplyTemplateStateSchema } from '../../../../../src/shared/contracts/replyTemplateContract';
import { senderCapPolicySchema } from '../../../../../src/shared/contracts/workerPolicyContract';
import type { DynamoStore } from '../dynamoStore';
import { guidedResearchMarkerKey } from '../researchSetup';
import { replyTemplateStateKey } from '../territoryPolicyRepository';
import { attemptCode, recordAttempt } from './attempts';
import { readPolicy } from './calls';
import { evidenceKey, evidenceRecordSchema, evidenceSummaryLine, type EvidenceRecord } from './evidence';
import { createAccountFirmSource, type FirmCard } from './firms';
import { firmKey, firmRecordSchema, listFirmRecords, zoneOfState, type FirmRecord, type FirmRouteLike } from './firmsWrite';
import { RESEARCH_DAILY_BUDGET_DEFAULT, RESEARCH_QUERIES_MAX, RESEARCH_SETTINGS_KEY, researchSettingsSchema } from './pool';
import { sequenceKey, sequenceRecordFromEnrollment, sequenceRecordSchema, startSequenceRecord, type SequenceRecord } from './sequence';
import { planSuppress, suppressionFirmKey, suppressionHandleKey } from './suppression';
import { seededTemplate, SENDING_CEILING, SENDING_SETTINGS_KEY, sendingSettingsSchema, templateKey, templateRecordSchema,
  type TemplateRecord } from './templates';

/**
 * The cutover copy (slice S6; FSS target design section 8, the cutover table). One pass over the records the old
 * worker keeps, written once under the new sort keys the rebuilt core reads, so the morning after the cutover
 * stands on `FIRM#`, `EVIDENCE#`, `TEMPLATE#`, `SETTINGS#`, `SUPPRESS#` and `SEQ#` alone.
 *
 * Three properties hold by construction.
 *
 *   It never deletes. Every write is a `Put` with `attribute_not_exists`, which is also what makes the copy
 *   re-runnable: a target key that already exists is reported as already-present and planned as nothing. The
 *   old keys stay exactly where they are; retiring them is S7, not this slice.
 *
 *   It never touches the grant, the event log, the pairings or the device tokens. `GOOGLE_GRANT#` is replaced
 *   by a fresh consent (design section 3), and the rest are retired at S7. None of them is read for a target
 *   here, and nothing here writes under their prefixes.
 *
 *   The dry run writes nothing at all. `planCutoverCopy` performs reads only and returns the whole table —
 *   source, target, count, would-write, already-present, refused — so David can read the plan before it runs.
 *   `readResearchSettings` is deliberately not used for that reason: it migrates the record into existence on
 *   its first read, which is a write, and a dry run must not have one.
 *
 * State and zone are S4's single derivation (`deriveStateAndZone`, reached through the firm read adapter), so a
 * firm's state can never be derived two different ways. An unknown state or zone is carried as a hold on the
 * record, exactly as the design says: "unknown state is a hold, not a refusal".
 */

/** The table's rows, in the order the dry run prints them. One `operator` attempt is recorded per row on execute. */
export const CUTOVER_ROWS = ['FIRM#', 'EVIDENCE#', 'TEMPLATE#', SENDING_SETTINGS_KEY, RESEARCH_SETTINGS_KEY, 'SUPPRESS#', 'SEQ#'] as const;
export type CutoverTarget = typeof CUTOVER_ROWS[number];

/** Why a source record produced no target write. Closed codes; never a provider message and never free text. */
export const CUTOVER_REFUSALS = ['evidence_unwritable', 'multiple_cap_policies', 'cap_policy_unreadable', 'no_call_policy',
  'sequence_unwritable', 'handle_invalid', 'write_refused', 'callback_unwritable', 'template_unknown', 'phone_unwritable'] as const;
export type CutoverRefusal = typeof CUTOVER_REFUSALS[number];

export type CutoverRow = {
  /** The old sort keys this row was read from, as one readable phrase. */
  source: string;
  /** The new sort key or prefix this row writes under. */
  target: string;
  /** Source records considered. */
  count: number;
  wouldWrite: number;
  alreadyPresent: number;
  refused: number;
  /** Each refusal's closed code and how many records it accounts for; the values sum to `refused`. */
  refusals: Partial<Record<CutoverRefusal, number>>;
};
/** One planned row: the counts David reads plus the transactions the execute commits, each one write group. */
export type PlannedCutoverRow = CutoverRow & { items: TransactWriteItem[][] };

const EVIDENCE_REF = 'cutover-copy';
const RECORDED_BY = 'cutover';
/** The word a `SEQ#` written by the copy carries, so nothing reads it as a firm standing on its first call. */
export const CARRIED_FROM_OLD_KEYS = 'carried_from_old_keys';

export function emptyRow(source: string, target: string): PlannedCutoverRow {
  return { source, target, count: 0, wouldWrite: 0, alreadyPresent: 0, refused: 0, refusals: {}, items: [] };
}
export function refuse(row: PlannedCutoverRow, reason: CutoverRefusal): void {
  row.refused++;
  row.refusals[reason] = (row.refusals[reason] ?? 0) + 1;
}

/** The status the copied `FIRM#` record carries: what the old records already say, never a guess about the future. */
function statusOf(card: FirmCard): FirmRecord['status'] {
  if (card.suppressed) return 'suppressed';
  if (!card.enrollment) return 'new';
  if (card.enrollment.state === 'stopped' || card.enrollment.state === 'completed') return 'done';
  return 'in_sequence';
}

/** The routes the new shape carries: business phone and email only, newest version of each id. Pure. */
function carriedRoutes(card: FirmCard, enteredAt: string): FirmRecord['routes'] {
  const routes: FirmRouteLike[] = card.routes.filter(route => route.purpose === 'business' && (route.channel === 'phone' || route.channel === 'email'));
  return routes.slice(0, 100).map(route => ({ id: route.id, channel: route.channel as 'phone' | 'email', value: route.value,
    purpose: 'business' as const, verification: route.verification, version: route.version, enteredAt }));
}

/** `ACCOUNT#` plus its derivation as one `FIRM#` record. Pure over the card the firm read adapter built. */
export function firmRecordFromCard(card: FirmCard, now: string): FirmRecord {
  const zone = card.state ? zoneOfState(card.state) : null;
  return firmRecordSchema.parse({
    version: 1, firmId: card.firmId, name: card.name, domain: card.website, city: card.city,
    state: card.state, timeZone: card.timeZone, derivedZoneFrom: card.timeZone && zone ? zone.from : null,
    status: statusOf(card), enteredBy: card.enteredBy,
    evidenceSummary: evidenceSummaryLine({ sources: card.sourceCount, businessEmail: card.businessEmail, facts: 0, researchedAt: card.researchedAt }),
    ...(card.sourceCount > 0 ? { researchRevision: card.researchRevision > 0 ? card.researchRevision : 1, researchedAt: card.researchedAt } : {}),
    routes: carriedRoutes(card, card.researchedAt), enteredAt: card.researchedAt, updatedAt: now,
  });
}

const accountSourceSchema = z.object({ id: z.string(), url: z.string(), fetchedAt: z.string(), sha256: z.string(), excerpt: z.string() });
const accountClaimSchema = z.object({ key: z.string(), value: z.string(), selection: z.string().optional(), evidenceIds: z.array(z.string()) });
const accountRecordLightSchema = z.object({ account: z.object({ id: z.string() }), sources: z.array(accountSourceSchema),
  claims: z.array(accountClaimSchema), researchRevision: z.number().int().positive().optional() });

/**
 * The research a firm already carries as one `EVIDENCE#` record: the fetched sources with their digests and
 * excerpts, and the business email the old discovery found, quoting the source it read it from. The extraction
 * is null: the old records keep admitted claims, not a model extraction with its own instant, and inventing one
 * would be a citation the record cannot produce.
 */
export function evidenceRecordFromAccount(raw: unknown, now: string): EvidenceRecord | null {
  const parsed = accountRecordLightSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sources.length === 0) return null;
  const email = parsed.data.claims.find(claim => claim.key === 'business_email');
  const selection = email && BUSINESS_EMAIL_SELECTIONS.some(value => value === email.selection) ? email.selection as typeof BUSINESS_EMAIL_SELECTIONS[number] : null;
  const candidate = {
    version: 1, firmId: parsed.data.account.id, sources: parsed.data.sources.map(source => ({ id: source.id, url: source.url,
      fetchedAt: source.fetchedAt, sha256: source.sha256, excerpt: source.excerpt })),
    extraction: null,
    businessEmailFinding: email ? { email: email.value, sourceId: email.evidenceIds[0] ?? null, selection,
      considered: [email.value], refused: { free_mail: 0, off_domain: 0, withheld_contact: 0, unparsable: 0 } } : null,
    revision: parsed.data.researchRevision ?? 1, updatedAt: now,
  };
  const checked = evidenceRecordSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

/** The five templates as the new core holds them: the seeded bodies, carrying the standing approval the worker held. */
export function templateRecordsFromWorkerState(raw: unknown, now: string): TemplateRecord[] {
  const state = workerReplyTemplateStateSchema.safeParse(raw);
  const approvals = new Map((state.success ? state.data.approvals : []).map(approval => [approval.templateId, approval]));
  return REPLY_TEMPLATE_IDS.map(templateId => {
    const seeded = seededTemplate(templateId, now);
    const approval = approvals.get(templateId);
    // The approval is kept only when it is an approval of exactly the seeded text; anything else is David's own
    // edit, which travels in the Mac export and lands unapproved so he re-approves it with the footer check.
    if (!approval || approval.subject !== seeded.subject || approval.body !== seeded.body) return seeded;
    return templateRecordSchema.parse({ ...seeded, approval: { state: 'approved', approvedRevision: seeded.revision,
      approvedAt: approval.approvedAt, contentHash: approval.contentHash,
      // No postal address exists at cutover, so the footer check has nothing to bind to: the send fence reads
      // this as `template_not_approved` until David sets the address and re-approves. That is the honest state.
      footerPostalAddress: null } });
  });
}

/** The sender cap policy the old worker enforced, narrowed to the ceiling fixed in code. Pure. */
export function sendingSettingsFromCapPolicy(raw: unknown, now: string): z.infer<typeof sendingSettingsSchema> | null {
  const policy = senderCapPolicySchema.safeParse(raw);
  if (!policy.success) return null;
  const ramp = policy.data.ramp;
  const candidate = {
    version: 1, dailyLimit: Math.min(policy.data.dailyLimit, SENDING_CEILING.dailyLimit),
    ramp: { startPerDay: Math.min(ramp?.startPerDay ?? SENDING_CEILING.startPerDay, SENDING_CEILING.startPerDay),
      stepPerDay: Math.min(ramp?.stepPerDay ?? SENDING_CEILING.stepPerDay, SENDING_CEILING.stepPerDay),
      maxPerDay: Math.min(ramp?.maxPerDay ?? SENDING_CEILING.maxPerDay, SENDING_CEILING.maxPerDay) },
    postalAddress: null, revision: 1, updatedAt: now,
  };
  const parsed = sendingSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The research configuration as S4's shape, read from the two records the old research path keeps and written
 * once. The descriptor is null: there is no durable record of the operator review's window, so David records it
 * through `set_research_config` rather than the copy inventing one.
 */
async function researchSettingsFromOldKeys(store: DynamoStore, now: string): Promise<{ record: z.infer<typeof researchSettingsSchema>; found: boolean }> {
  const [source, marker] = await Promise.all([store.get<unknown>(ownerResearchSourceKey()), store.get<unknown>(guidedResearchMarkerKey)]);
  let queries: string[] = [];
  const parsed = source ? ownerResearchSourceSchema.safeParse(source.data) : null;
  if (parsed?.success && parsed.data.research) {
    try { queries = placesQueryGrid(parsed.data.research.audience).slice(0, RESEARCH_QUERIES_MAX); } catch { queries = []; }
  }
  return { record: researchSettingsSchema.parse({ version: 1, queries, dailyBudget: RESEARCH_DAILY_BUDGET_DEFAULT,
    descriptor: null, revision: 1, updatedAt: now }), found: Boolean(source ?? marker) };
}

const retiredRouteSchema = z.object({ accountId: z.string(), routeId: z.string() });
const mailSuppressionSchema = z.object({ accountId: z.string() });

/**
 * The whole plan, reads only. Every row names where it read from, what it would write, what is already there and
 * what it refused. Calling this twice changes nothing, and calling it after an execute reports everything as
 * already-present.
 */
export async function planCutoverCopy(store: DynamoStore): Promise<PlannedCutoverRow[]> {
  const now = store.now();
  const cards = await createAccountFirmSource(store).listFirms();
  const existingFirms = await listFirmRecords(store);

  // --- FIRM# and EVIDENCE# -------------------------------------------------------------------------------
  const firms = emptyRow('ACCOUNT# (with the derived state and zone)', 'FIRM#');
  const evidence = emptyRow('ACCOUNT# sources, claims and research revision', 'EVIDENCE#');
  for (const card of cards) {
    firms.count++;
    if (existingFirms.has(card.firmId)) firms.alreadyPresent++;
    else { firms.items.push([store.put(firmKey(card.firmId), firmRecordFromCard(card, now), null)]); firms.wouldWrite++; }
  }
  const accountRows = await store.list<unknown>('ACCOUNT#');
  for (const row of accountRows) {
    const record = evidenceRecordFromAccount(row.stored.data, now);
    if (record === null) continue;
    evidence.count++;
    if (await store.get<unknown>(evidenceKey(record.firmId))) { evidence.alreadyPresent++; continue; }
    try { evidence.items.push([store.put(evidenceKey(record.firmId), record, null)]); evidence.wouldWrite++; }
    catch { refuse(evidence, 'evidence_unwritable'); }
  }

  // --- TEMPLATE# -----------------------------------------------------------------------------------------
  const templates = emptyRow('REPLY_TEMPLATE_STATE# and the seeded bodies', 'TEMPLATE#');
  const templateState = await store.get<unknown>(replyTemplateStateKey(store.options.workspaceId));
  for (const record of templateRecordsFromWorkerState(templateState?.data, now)) {
    templates.count++;
    if (await store.get<unknown>(templateKey(record.templateId))) { templates.alreadyPresent++; continue; }
    templates.items.push([store.put(templateKey(record.templateId), record, null)]); templates.wouldWrite++;
  }

  // --- SETTINGS#sending ----------------------------------------------------------------------------------
  const sending = emptyRow('DISPATCH_CAP_POLICY#', SENDING_SETTINGS_KEY);
  const policies = await store.list<unknown>('DISPATCH_CAP_POLICY#');
  if (policies.length > 0) {
    sending.count = 1;
    if (await store.get<unknown>(SENDING_SETTINGS_KEY)) sending.alreadyPresent++;
    else if (policies.length > 1) refuse(sending, 'multiple_cap_policies');
    else {
      const record = sendingSettingsFromCapPolicy(policies[0]!.stored.data, now);
      if (!record) refuse(sending, 'cap_policy_unreadable');
      else { sending.items.push([store.put(SENDING_SETTINGS_KEY, record, null)]); sending.wouldWrite++; }
    }
  }

  // --- SETTINGS#research ---------------------------------------------------------------------------------
  const research = emptyRow('OWNER_RESEARCH_SOURCE and GUIDED_RESEARCH_SETUP', RESEARCH_SETTINGS_KEY);
  const configured = await researchSettingsFromOldKeys(store, now);
  if (configured.found) {
    research.count = 1;
    if (await store.get<unknown>(RESEARCH_SETTINGS_KEY)) research.alreadyPresent++;
    else { research.items.push([store.put(RESEARCH_SETTINGS_KEY, configured.record, null)]); research.wouldWrite++; }
  }

  // --- SUPPRESS# -----------------------------------------------------------------------------------------
  // A firm the old mailbox stopped becomes a suppressed firm with every handle it is reachable on; a route the
  // old worker retired becomes a suppressed handle on its own, because a wrong number is not a stopped firm.
  const suppression = emptyRow('MAIL_SUPPRESSION# and TERRITORY_RETIRED_ROUTE#', 'SUPPRESS#');
  const byFirm = new Map(cards.map(card => [card.firmId, card]));
  for (const row of await store.list<unknown>('MAIL_SUPPRESSION#')) {
    const parsed = mailSuppressionSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    suppression.count++;
    if (await store.get<unknown>(suppressionFirmKey(parsed.data.accountId))) { suppression.alreadyPresent++; continue; }
    const plan = await planSuppress(store, { firmId: parsed.data.accountId, routes: byFirm.get(parsed.data.accountId)?.routes ?? [],
      reason: 'carried from the old mail suppression at cutover', source: 'reply', evidenceRef: EVIDENCE_REF, recordedBy: RECORDED_BY });
    if (plan.outcome === 'refused') { refuse(suppression, 'handle_invalid'); continue; }
    suppression.items.push(plan.items); suppression.wouldWrite++;
  }
  for (const row of await store.list<unknown>('TERRITORY_RETIRED_ROUTE#')) {
    const parsed = retiredRouteSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    const card = byFirm.get(parsed.data.accountId);
    const route = card?.routes.find(candidate => candidate.id === parsed.data.routeId);
    if (!route) continue;
    suppression.count++;
    const plan = await planSuppress(store, { handle: route.value, reason: 'route retired by the old worker before the cutover',
      source: 'call', evidenceRef: EVIDENCE_REF, recordedBy: RECORDED_BY });
    if (plan.outcome === 'refused') { refuse(suppression, 'handle_invalid'); continue; }
    if (plan.outcome === 'already') { suppression.alreadyPresent++; continue; }
    suppression.items.push(plan.items); suppression.wouldWrite++;
  }

  // --- SEQ# ----------------------------------------------------------------------------------------------
  // A firm the old keys already worked: a sequence past its first call, or a logged old-key outcome. Both land
  // as one `SEQ#` carrying `carried_from_old_keys`, which is what keeps the firm out of the new lane.
  const sequences = emptyRow('CAMPAIGN_ENROLLMENT#, TERRITORY_ENROLLMENT# and CAMPAIGN_EVIDENCE#', 'SEQ#');
  const policy = await readPolicy(store);
  for (const card of cards) {
    if (!worked(card)) continue;
    sequences.count++;
    if (await store.get<unknown>(sequenceKey(card.firmId))) { sequences.alreadyPresent++; continue; }
    if (!policy) { refuse(sequences, 'no_call_policy'); continue; }
    let record: SequenceRecord | null = null;
    try {
      const base = card.enrollment ? sequenceRecordFromEnrollment({ policy, firm: card, now })
        : startSequenceRecord({ policy, firmId: card.firmId, startedAt: card.lastCall?.at ?? card.researchedAt, routeId: card.phone?.routeId ?? null });
      record = base ? sequenceRecordSchema.parse({ ...base, lastAdvance: CARRIED_FROM_OLD_KEYS, updatedAt: now }) : null;
    } catch { record = null; }
    if (!record) { refuse(sequences, 'sequence_unwritable'); continue; }
    sequences.items.push([store.put(sequenceKey(card.firmId), record, null)]); sequences.wouldWrite++;
  }

  return [firms, evidence, templates, sending, research, suppression, sequences];
}

/** Whether the old keys already worked this firm: a logged outcome, or a sequence past its first call. Pure. */
function worked(card: FirmCard): boolean {
  if (card.calls > 0) return true;
  const enrollment = card.enrollment;
  if (!enrollment) return false;
  return enrollment.state !== 'active' || (enrollment.currentStepIndex ?? 0) > 0;
}

export type CutoverReport = { executed: boolean; rows: CutoverRow[] };

/**
 * The copy. `execute: false` is the dry run: the plan, the table, and not one write. `execute: true` commits each
 * planned group on its own, so one refused group (a target another writer created between the plan and the write)
 * never stops the rest, and records one `operator` attempt per table row with what that row actually wrote.
 */
export async function runCutoverCopy(store: DynamoStore, options: { execute: boolean }): Promise<CutoverReport> {
  const planned = await planCutoverCopy(store);
  if (!options.execute) return { executed: false, rows: planned.map(stripItems) };
  for (const row of planned) {
    const started = Date.now();
    let written = 0;
    for (const group of row.items) {
      if (group.length === 0) continue;
      try { await store.transact(group); written++; }
      catch { row.wouldWrite--; refuse(row, 'write_refused'); }
    }
    await recordAttempt(store, { kind: 'operator', outcome: row.refused > 0 ? 'failed' : 'ok',
      reason: row.refused > 0 ? firstRefusal(row) : null,
      detail: { code: attemptCode(row.target), count: written }, durationMs: Date.now() - started, ref: row.target.slice(0, 80) });
  }
  return { executed: true, rows: planned.map(stripItems) };
}

export const firstRefusal = (row: CutoverRow): CutoverRefusal => CUTOVER_REFUSALS.find(code => (row.refusals[code] ?? 0) > 0) ?? 'write_refused';
export const stripItems = (row: PlannedCutoverRow): CutoverRow => ({ source: row.source, target: row.target, count: row.count,
  wouldWrite: row.wouldWrite, alreadyPresent: row.alreadyPresent, refused: row.refused, refusals: row.refusals });

/** The dry run's table, as the operator tool prints it: one line per row, counts only, never a record's contents. */
export function cutoverTable(rows: readonly CutoverRow[]): string {
  const header = ['source', 'target', 'count', 'would-write', 'already-present', 'refused'];
  const body = rows.map(row => [row.source, row.target, String(row.count), String(row.wouldWrite), String(row.alreadyPresent),
    row.refused === 0 ? '0' : `${row.refused} (${Object.entries(row.refusals).map(([code, count]) => `${code}:${count}`).join(' ')})`]);
  const widths = header.map((name, column) => Math.max(name.length, ...body.map(line => line[column]!.length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(header), line(widths.map(width => '-'.repeat(width))), ...body.map(line)].join('\n');
}

/** Re-exported so a caller that reports on the copy names the same keys the copy wrote. */
export { suppressionFirmKey, suppressionHandleKey };
