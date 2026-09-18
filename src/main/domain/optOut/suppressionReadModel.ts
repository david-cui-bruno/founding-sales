import type { AppDatabase } from '../../db/database';
import { SUPPRESSION_READ_LIMIT, suppressionListSchema, type SuppressionEntry, type SuppressionList } from '../../../shared/contracts/replyFirstDraftContract';

/**
 * Settings → Suppressed (lane 32, D9 item 5): every reason this application will not contact
 * someone, in one read-only list, so a hold on Today is explainable.
 *
 * A suppression is permanent by design: this module has no write, no delete and no undo, and
 * every row it reads sits behind an append-only table or an immutable route version. The
 * wording of `why` is founder-facing copy, never a provider or error string.
 */
const WHY = Object.freeze({
  manual_never_call: 'Never call this firm: you marked it, and that is permanent.',
  manual_owner_report: 'You recorded an opt-out as the outcome of a call.',
  gmail_reply: 'Someone at this firm asked to stop, in a reply to one of these emails.',
  identity_propagation: 'A person who opted out was matched to this contact.',
});
const sourceWhy = (source: string): string => WHY[source as keyof typeof WHY] ?? `Suppressed by ${source}.`;

type Row = Record<string, unknown>;
const text = (value: unknown, fallback: string): string => typeof value === 'string' && value.length ? value : fallback;

export function readSuppression(input: { database: AppDatabase; clock: { now(): string } }): SuppressionList {
  const raw = input.database.raw;
  // One row more than the cap on every query, so truncation is observed rather than assumed.
  const cap = SUPPRESSION_READ_LIMIT + 1;
  const entries: SuppressionEntry[] = [];
  for (const row of raw.prepare(`SELECT t.account_id AS accountId, t.observed_at AS observedAt, t.source AS source, t.evidence_ref AS evidenceRef,
      a.name AS name FROM pm_account_suppression_tombstones t LEFT JOIN pm_accounts a ON a.id=t.account_id ORDER BY t.observed_at DESC, t.id DESC LIMIT ?`).all(cap) as Row[]) {
    entries.push({ kind: row.source === 'manual_never_call' ? 'never_call' : 'account_opt_out',
      subject: text(row.name, String(row.accountId)), accountId: String(row.accountId), observedAt: String(row.observedAt),
      why: sourceWhy(String(row.source)), evidenceRef: typeof row.evidenceRef === 'string' ? row.evidenceRef : null });
  }
  for (const row of raw.prepare(`SELECT kind, normalized_value AS value, observed_at AS observedAt, source, evidence_ref AS evidenceRef
      FROM pm_handle_suppression_tombstones ORDER BY observed_at DESC, id DESC LIMIT ?`).all(cap) as Row[]) {
    entries.push({ kind: 'handle_opt_out', subject: String(row.value), accountId: null, observedAt: String(row.observedAt),
      why: `${row.kind === 'phone' ? 'This number' : 'This address'} is suppressed. ${sourceWhy(String(row.source))}`,
      evidenceRef: typeof row.evidenceRef === 'string' ? row.evidenceRef : null });
  }
  for (const row of raw.prepare(`SELECT t.person_id AS personId, t.requested_at AS requestedAt, t.observed_channel AS channel, t.evidence_ref AS evidenceRef,
      p.display_name AS name FROM opt_out_tombstones t LEFT JOIN persons p ON p.id=t.person_id ORDER BY t.requested_at DESC, t.id DESC LIMIT ?`).all(cap) as Row[]) {
    entries.push({ kind: 'person_opt_out', subject: text(row.name, String(row.personId)), accountId: null, observedAt: String(row.requestedAt),
      why: `This person opted out, observed on ${String(row.channel)}.`, evidenceRef: typeof row.evidenceRef === 'string' ? row.evidenceRef : null });
  }
  // A route is never edited: a correction lands as a new version, which retires the old value.
  // The retirement date is the replacement's own admitted_at, the only recorded "when".
  for (const row of raw.prepare(`SELECT old.account_id AS accountId, old.value AS value, old.version AS version, old.channel AS channel,
      current.version AS currentVersion, current.admitted_at AS retiredAt FROM pm_account_routes old
      JOIN pm_account_routes current ON current.id=old.id AND current.account_id=old.account_id
      WHERE current.version=(SELECT max(v.version) FROM pm_account_routes v WHERE v.id=old.id AND v.account_id=old.account_id)
        AND old.version<current.version ORDER BY current.admitted_at DESC, old.id DESC, old.version DESC LIMIT ?`).all(cap) as Row[]) {
    entries.push({ kind: 'retired_route', subject: String(row.value), accountId: String(row.accountId), observedAt: String(row.retiredAt),
      why: `Retired ${String(row.channel)} route: version ${String(row.currentVersion)} replaced this one, and the old value is never dialled or written again.`,
      evidenceRef: null });
  }
  entries.sort((left, right) => left.observedAt < right.observedAt ? 1 : left.observedAt > right.observedAt ? -1 : left.subject < right.subject ? -1 : 1);
  return suppressionListSchema.parse({ entries: entries.slice(0, SUPPRESSION_READ_LIMIT),
    truncated: entries.length > SUPPRESSION_READ_LIMIT, generatedAt: input.clock.now() });
}
