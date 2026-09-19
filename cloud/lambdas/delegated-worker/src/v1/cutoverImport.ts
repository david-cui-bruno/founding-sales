import { parseCutoverExport, type CutoverExport, type CutoverExportRefusal } from '../../../../../src/shared/contracts/cutoverExportContract';
import type { DynamoStore } from '../dynamoStore';
import { attemptCode, recordAttempt } from './attempts';
import { callbackKey, callbackRecordSchema } from './calls';
import { createAccountFirmSource, type FirmCard } from './firms';
import { PHONE_SETUP_KEY, phoneSetupRecordSchema } from './phoneSetup';
import { planSuppress, suppressionFirmKey } from './suppression';
import { readTemplate, templateKey, templateRecordSchema } from './templates';
import { cutoverTable, emptyRow, firstRefusal, refuse, stripItems, type CutoverRow, type PlannedCutoverRow } from './cutover';

/**
 * The import of the Mac export (slice S6, build item 3). The three record kinds that live only in the old app's
 * database, plus the phone setup status, read from one file David can read first and written under the new keys.
 *
 * The file is validated whole before a single record of it is used: `cutoverExportSchema` is strict all the way
 * down, so one unknown key refuses the file rather than letting an unknown field travel unnoticed. A refused file
 * writes nothing and is reported by its closed code.
 *
 * What lands where:
 *
 *   callbacks   `CALLBACK#<dueOn>#<firmId>`, keeping the state the old app recorded. An open callback is pending
 *               and leads its day's callbacks lane; a done or cancelled one is history, and neither is invented.
 *   never-call  the `SUPPRESS#` set with source `manual` and evidenceRef `cutover-export`, written through the
 *               same `planSuppress` every other suppression goes through, so the firm and every handle it is
 *               reachable on stop together. Permanent, like every other suppression: there is no unsuppress.
 *   templates   `TEMPLATE#`, with the approval re-set to unapproved. An edited body is text the worker has never
 *               seen approved and that has never passed the footer check, so David re-approves it on the new
 *               Settings page with that check in front of him. Importing is never approving.
 *   phone       `SETTINGS#phone`: the status and the digest of the proof, never the proof and never a path.
 *
 * Every record it creates is an `attribute_not_exists` put, so the import is re-runnable and never overwrites. The
 * one exception is a template the copy already wrote from the seeds: there the edited body is written with a
 * revision fence on exactly the record that was read, and a body already equal to the export's is left alone, so a
 * second run bumps nothing.
 */

export const CUTOVER_IMPORT_ROWS = ['CALLBACK#', 'SUPPRESS#', 'TEMPLATE#', PHONE_SETUP_KEY] as const;
const EVIDENCE_REF = 'cutover-export';
const RECORDED_BY = 'cutover';
/** The state the new record carries for each state the old app recorded. */
const CALLBACK_STATE = { open: 'pending', done: 'made', cancelled: 'suppressed' } as const;

export type CutoverImportPlan =
  | { outcome: 'refused'; reason: CutoverExportRefusal }
  | { outcome: 'planned'; file: CutoverExport; rows: PlannedCutoverRow[] };

/** The whole plan, reads only. A refused file never reaches a read of the table. */
export async function planCutoverImport(store: DynamoStore, text: string): Promise<CutoverImportPlan> {
  const parsed = parseCutoverExport(text);
  if (!parsed.ok) return { outcome: 'refused', reason: parsed.reason };
  const file = parsed.file;
  const now = store.now();
  const cards = new Map((await createAccountFirmSource(store).listFirms()).map(card => [card.firmId, card] as const));

  // --- CALLBACK# ------------------------------------------------------------------------------------------
  const callbacks = emptyRow('the old app\'s pm_account_callbacks', 'CALLBACK#');
  for (const entry of file.callbacks) {
    callbacks.count++;
    const key = callbackKey(entry.dueOn, entry.firmId);
    if (await store.get<unknown>(key)) { callbacks.alreadyPresent++; continue; }
    const record = callbackRecordSchema.safeParse({ version: 1, firmId: entry.firmId, dueOn: entry.dueOn,
      promisedAt: entry.promisedAt, promisedBy: `${EVIDENCE_REF}:${entry.sourceCommandId}`,
      state: CALLBACK_STATE[entry.state], resolvedAt: null });
    if (!record.success) { refuse(callbacks, 'callback_unwritable'); continue; }
    callbacks.items.push([store.put(key, record.data, null)]); callbacks.wouldWrite++;
  }

  // --- SUPPRESS# ------------------------------------------------------------------------------------------
  const suppression = emptyRow('the old app\'s pm_account_suppression_tombstones', 'SUPPRESS#');
  for (const entry of file.neverCall) {
    suppression.count++;
    if (await store.get<unknown>(suppressionFirmKey(entry.firmId))) { suppression.alreadyPresent++; continue; }
    const routes = routesOf(cards.get(entry.firmId));
    const plan = await planSuppress(store, { firmId: entry.firmId, routes,
      reason: `never call, recorded on the old app ${entry.observedAt}`, source: 'manual', evidenceRef: EVIDENCE_REF, recordedBy: RECORDED_BY });
    if (plan.outcome === 'refused') { refuse(suppression, 'handle_invalid'); continue; }
    if (plan.outcome === 'already') { suppression.alreadyPresent++; continue; }
    suppression.items.push(plan.items); suppression.wouldWrite++;
  }

  // --- TEMPLATE# ------------------------------------------------------------------------------------------
  const templates = emptyRow('the old app\'s email_templates, where the body differs from the seed', 'TEMPLATE#');
  for (const entry of file.templates) {
    templates.count++;
    const held = await readTemplate(store, entry.templateId);
    // The body is already what the export carries: nothing to write, whichever run wrote it.
    if (held.rev !== null && held.record.subject === entry.subject && held.record.body === entry.body) { templates.alreadyPresent++; continue; }
    const record = templateRecordSchema.safeParse({ ...held.record, subject: entry.subject, body: entry.body,
      revision: held.rev === null ? held.record.revision : held.record.revision + 1,
      // Unapproved on purpose: an edited body has never passed the footer check, and importing is never approving.
      approval: { state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null, footerPostalAddress: null },
      updatedAt: now });
    if (!record.success) { refuse(templates, 'template_unknown'); continue; }
    templates.items.push([store.put(templateKey(entry.templateId), record.data, held.rev)]); templates.wouldWrite++;
  }

  // --- SETTINGS#phone -------------------------------------------------------------------------------------
  const phone = emptyRow('the old app\'s phone-route.json setup proof', PHONE_SETUP_KEY);
  phone.count = 1;
  if (await store.get<unknown>(PHONE_SETUP_KEY)) phone.alreadyPresent++;
  else {
    const record = phoneSetupRecordSchema.safeParse({ version: 1, status: file.phone.status, confirmedAt: file.phone.confirmedAt,
      proofDigest: file.phone.proofDigest, confirmedBy: RECORDED_BY, revision: 1, updatedAt: now });
    if (!record.success) refuse(phone, 'phone_unwritable');
    else { phone.items.push([store.put(PHONE_SETUP_KEY, record.data, null)]); phone.wouldWrite++; }
  }

  return { outcome: 'planned', file, rows: [callbacks, suppression, templates, phone] };
}

/** The handles a firm is reachable on, as `planSuppress` reads them; none at all for a firm the worker never saw. */
const routesOf = (card: FirmCard | undefined): { channel: string; value: string }[] =>
  (card?.routes ?? []).map(route => ({ channel: route.channel, value: route.value }));

export type CutoverImportReport =
  | { outcome: 'refused'; reason: CutoverExportRefusal }
  | { outcome: 'ok'; executed: boolean; rows: CutoverRow[]; exportedAt: string };

/** The import. `execute: false` is the dry run: the plan, the table and not one write. */
export async function runCutoverImport(store: DynamoStore, text: string, options: { execute: boolean }): Promise<CutoverImportReport> {
  const planned = await planCutoverImport(store, text);
  if (planned.outcome === 'refused') return planned;
  if (!options.execute) return { outcome: 'ok', executed: false, rows: planned.rows.map(stripItems), exportedAt: planned.file.exportedAt };
  for (const row of planned.rows) {
    const started = Date.now();
    let written = 0;
    for (const group of row.items) {
      if (group.length === 0) continue;
      try { await store.transact(group); written++; }
      catch { row.wouldWrite--; refuse(row, 'write_refused'); }
    }
    await recordAttempt(store, { kind: 'operator', outcome: row.refused > 0 ? 'failed' : 'ok',
      reason: row.refused > 0 ? firstRefusal(row) : null,
      detail: { code: attemptCode(`import_${row.target}`), count: written }, durationMs: Date.now() - started, ref: row.target.slice(0, 80) });
  }
  return { outcome: 'ok', executed: true, rows: planned.rows.map(stripItems), exportedAt: planned.file.exportedAt };
}

/** The same table the copy prints, so both halves of the cutover read alike. */
export { cutoverTable };
