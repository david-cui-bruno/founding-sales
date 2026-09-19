import { z } from 'zod';
import { REPLY_TEMPLATE_IDS } from './replyTemplateContract';

/**
 * The one-off Mac export of the cutover (slice S6; FSS target design section 8, the cutover table's last row).
 *
 * Three kinds of record live only in the old app's encrypted database and nowhere on the worker, so they are the
 * only Mac-side step of the cutover: the callbacks David promised on the phone, the never-call marks he recorded,
 * and any template body he edited away from the seeded text. The phone setup status travels with them because the
 * new client needs to know whether this Mac was ever set up to hand a number to Phone.app.
 *
 * This file is the contract both sides read: `src/main/cutoverExport.ts` writes it on the Mac, and the worker's
 * `--cutover-import` validates it with exactly this schema before it reads a single record out of it. The schema
 * is strict all the way down, so an unknown key refuses the whole file rather than being quietly ignored.
 *
 * Nothing here is a secret. There is no token, no key, no envelope, no mailbox content, no excerpt and no path:
 * the export carries firm ids, dates, David's own notes, his own template text and one sha256 digest of the local
 * phone proof. David can read the file before the import uses it, which is the point of it being a file at all.
 */

const instant = z.iso.datetime({ precision: 3 });
const firmId = z.string().min(1).max(200);

export const CUTOVER_EXPORT_KIND = 'callie_cutover_export';
export const CUTOVER_EXPORT_VERSION = 1;
/** Bounds the file, and therefore the import, so neither can be handed an unbounded document. */
export const CUTOVER_EXPORT_MAX = Object.freeze({ callbacks: 5000, neverCall: 5000, templates: REPLY_TEMPLATE_IDS.length, bytes: 4_000_000 });

/** One callback David promised on a call, as `pm_account_callbacks` holds it. `dueOn` is a plain date, never an instant. */
export const cutoverCallbackSchema = z.strictObject({
  firmId,
  dueOn: z.iso.date(),
  note: z.string().max(10_000).nullable(),
  state: z.enum(['open', 'done', 'cancelled']),
  /** The human report that created it, so the imported record can name what promised it. */
  sourceCommandId: z.string().min(1).max(255),
  promisedAt: instant,
});
export type CutoverCallback = z.infer<typeof cutoverCallbackSchema>;

/** One never-call mark, as `pm_account_suppression_tombstones` holds it. */
export const cutoverNeverCallSchema = z.strictObject({
  firmId,
  observedAt: instant,
  /** The old app's own word for where the mark came from; carried as text, never re-interpreted as a new source. */
  source: z.string().min(1).max(80),
  evidenceRef: z.string().max(200),
});
export type CutoverNeverCall = z.infer<typeof cutoverNeverCallSchema>;

/** One template body David edited away from the seeded text. Only the edited ones travel; the rest come from the seeds. */
export const cutoverTemplateSchema = z.strictObject({
  templateId: z.enum(REPLY_TEMPLATE_IDS),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  editedAt: instant,
});
export type CutoverTemplate = z.infer<typeof cutoverTemplateSchema>;

/** Whether this Mac holds a confirmed Phone.app setup proof, and the digest of the proof it confirmed. Never the proof. */
export const cutoverPhoneSchema = z.strictObject({
  status: z.enum(['confirmed', 'cleared']),
  confirmedAt: instant.nullable(),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type CutoverPhone = z.infer<typeof cutoverPhoneSchema>;

export const cutoverExportSchema = z.strictObject({
  kind: z.literal(CUTOVER_EXPORT_KIND),
  version: z.literal(CUTOVER_EXPORT_VERSION),
  exportedAt: instant,
  /** The old app's schema version at the instant it was read, so the file says which shape it came from. */
  schemaVersion: z.number().int().positive().max(1000),
  callbacks: z.array(cutoverCallbackSchema).max(CUTOVER_EXPORT_MAX.callbacks),
  neverCall: z.array(cutoverNeverCallSchema).max(CUTOVER_EXPORT_MAX.neverCall),
  templates: z.array(cutoverTemplateSchema).max(CUTOVER_EXPORT_MAX.templates),
  phone: cutoverPhoneSchema,
  /** The counts the export printed, restated in the file so a truncated or hand-edited file does not read as complete. */
  counts: z.strictObject({ callbacks: z.number().int().nonnegative(), neverCall: z.number().int().nonnegative(),
    templates: z.number().int().nonnegative() }),
}).refine(file => file.counts.callbacks === file.callbacks.length && file.counts.neverCall === file.neverCall.length
  && file.counts.templates === file.templates.length, 'cutover_export_counts_mismatch')
  .refine(file => new Set(file.templates.map(entry => entry.templateId)).size === file.templates.length, 'cutover_export_template_duplicated');
export type CutoverExport = z.infer<typeof cutoverExportSchema>;

/** Why an export file was refused whole. Closed codes; the import never reports a zod message to a terminal. */
export const CUTOVER_EXPORT_REFUSALS = ['file_too_large', 'file_not_json', 'file_not_an_export'] as const;
export type CutoverExportRefusal = typeof CUTOVER_EXPORT_REFUSALS[number];

/**
 * The export file as a validated document, or the one closed reason it was refused. Pure: it reads a string and
 * decides, and a file that is one key wrong is refused whole rather than partly believed.
 */
export function parseCutoverExport(text: string): { ok: true; file: CutoverExport } | { ok: false; reason: CutoverExportRefusal } {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > CUTOVER_EXPORT_MAX.bytes) return { ok: false, reason: 'file_too_large' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'file_not_json' }; }
  const parsed = cutoverExportSchema.safeParse(raw);
  return parsed.success ? { ok: true, file: parsed.data } : { ok: false, reason: 'file_not_an_export' };
}
