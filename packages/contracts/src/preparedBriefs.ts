import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { businessDate, instant, uuid } from './foundationRows.ts';

/**
 * A firm's prepared brief and its sources (lane PB, migration 0038).
 *
 * Text somebody prepared about a firm outside Callie (the DFW research agent's call
 * briefs, 2 October 2026), with the links it rests on. It is shown beside Callie's own
 * research brief and labelled "Prepared research · observed <date> · not verified by
 * Callie": nothing in it was read or checked by Callie.
 *
 * The bounds are the table's CHECKs (`firm_prepared_briefs_*`), stated once here so the
 * API refuses a request before it reaches the database and the desktop can say which row
 * of an import file is out of bounds before anything is sent. JavaScript counts UTF-16
 * units where PostgreSQL counts characters, so these bounds are never looser than the
 * table's.
 */

export const PREPARED_BRIEF_LIMITS = Object.freeze({
  briefCharacters: 4000,
  sources: 30,
  urlCharacters: 500,
  labelCharacters: 200,
  preparedByCharacters: 200,
  importRows: 2000,
  /** Rows one `POST /firms/brief/import` command takes (design reset I1). */
  importCommandRows: 100,
});

const notBlank = (value: string): boolean => value.trim().length > 0;

/** An https URL, the shape `firm_links_url_shape` and `prepared_brief_sources_valid` use. */
export const preparedBriefUrlSchema = z
  .string()
  .max(PREPARED_BRIEF_LIMITS.urlCharacters)
  .regex(/^https:\/\/\S{3,}$/u);

export const preparedBriefSourceSchema = z.strictObject({
  url: preparedBriefUrlSchema,
  label: z.string().max(PREPARED_BRIEF_LIMITS.labelCharacters).refine(notBlank),
});
export type PreparedBriefSource = z.infer<typeof preparedBriefSourceSchema>;

export const preparedBriefTextSchema = z.string().max(PREPARED_BRIEF_LIMITS.briefCharacters).refine(notBlank);
export const preparedBriefSourcesSchema = z.array(preparedBriefSourceSchema).max(PREPARED_BRIEF_LIMITS.sources);
export const preparedByTextSchema = z.string().max(PREPARED_BRIEF_LIMITS.preparedByCharacters).refine(notBlank);

/**
 * The brief as a read returns it: on the firm page and the Today card, only when the
 * client negotiated `include: ['preparedBrief']`, and null when the firm has none.
 */
export const preparedBriefDtoSchema = z.object({
  brief: z.string().min(1).max(PREPARED_BRIEF_LIMITS.briefCharacters),
  sources: z.array(z.object({ url: z.string().min(1).max(PREPARED_BRIEF_LIMITS.urlCharacters), label: z.string().min(1).max(PREPARED_BRIEF_LIMITS.labelCharacters) })).max(PREPARED_BRIEF_LIMITS.sources),
  observedOn: businessDate,
  preparedBy: z.string().min(1).max(PREPARED_BRIEF_LIMITS.preparedByCharacters),
  updatedAt: instant,
});
export type PreparedBriefDto = z.infer<typeof preparedBriefDtoSchema>;

/**
 * `POST /firms/brief/set`: an upsert, admin or the firm's assignee, idempotent per
 * command id. Every field but the firm is optional so a save sends only what changed
 * (kept-state rule K2): on a firm that already has a brief an absent field keeps its
 * value; on a firm with none, `brief`, `observedOn` and `preparedBy` are required
 * (`invalid_input` otherwise) and `sources` defaults to none.
 */
export const setPreparedBriefCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
  brief: preparedBriefTextSchema.optional(),
  sources: preparedBriefSourcesSchema.optional(),
  observedOn: businessDate.optional(),
  preparedBy: preparedByTextSchema.optional(),
});
export type SetPreparedBriefCommand = z.infer<typeof setPreparedBriefCommandSchema>;

/**
 * What the set command's receipt keeps: never the text, so a receipt and an audit row say
 * that a brief was written, not what it says.
 */
export const preparedBriefSetReceiptSchema = z.object({
  firmId: uuid,
  created: z.boolean(),
  briefLength: z.number().int().min(1),
  sourceCount: z.number().int().min(0),
  updatedAt: instant,
});
export type PreparedBriefSetReceipt = z.infer<typeof preparedBriefSetReceiptSchema>;

/**
 * What the set command answers (design reset I2): the receipt's fields and the brief as it is
 * stored now, read after the command committed and never kept on the receipt. The desktop
 * patches that firm's cached data with it and reads nothing.
 */
export const preparedBriefSetResultSchema = preparedBriefSetReceiptSchema.extend({ brief: preparedBriefDtoSchema.nullable() });
export type PreparedBriefSetResult = z.infer<typeof preparedBriefSetResultSchema>;

/** `POST /firms/brief/clear`. Clearing a firm with no brief is accepted with `cleared: false`. */
export const clearPreparedBriefCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
});

export const preparedBriefClearReceiptSchema = z.object({ firmId: uuid, cleared: z.boolean() });
/** What clear answers (design reset I2): the stored brief afterwards, which is none. */
export const preparedBriefClearResultSchema = preparedBriefClearReceiptSchema.extend({ brief: z.null() });

/**
 * `POST /firms/brief/match`, admin only and read-only: which firm each row of a prepared
 * brief file names, by the CSV importer's own matcher (external id, then website domain,
 * then name). A row naming two firms is `ambiguous` and is not imported.
 */
export const preparedBriefMatchRequestSchema = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        externalId: z.string().trim().min(1).max(320).optional(),
        website: z.string().trim().min(1).max(500).optional(),
        firmName: z.string().trim().min(1).max(300).optional(),
      }),
    )
    .min(1)
    .max(PREPARED_BRIEF_LIMITS.importRows),
});
export type PreparedBriefMatchRequest = z.infer<typeof preparedBriefMatchRequestSchema>;

export const preparedBriefMatchSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('matched'),
    firmId: uuid,
    firmName: z.string().min(1).max(300),
    matchedOn: z.enum(['external_id', 'domain', 'name']),
  }),
  z.object({ status: z.literal('unmatched') }),
  z.object({ status: z.literal('ambiguous'), column: z.enum(['external_id', 'website', 'firm_name']) }),
]);
export type PreparedBriefMatch = z.infer<typeof preparedBriefMatchSchema>;

export const preparedBriefMatchResponseSchema = z.object({ rows: z.array(preparedBriefMatchSchema) });

/**
 * One row of a prepared-brief import file (Firms → Import → "Import prepared briefs
 * (JSON)…"). The file is a JSON array of these. At least one of `external_id`, `website`
 * and `firm_name` names the firm.
 */
export const preparedBriefImportRowSchema = z
  .strictObject({
    external_id: z.string().trim().min(1).max(320).optional(),
    website: z.string().trim().min(1).max(500).optional(),
    firm_name: z.string().trim().min(1).max(300).optional(),
    brief: preparedBriefTextSchema,
    sources: preparedBriefSourcesSchema,
    observed_on: businessDate,
    prepared_by: preparedByTextSchema,
  })
  .refine(row => row.external_id !== undefined || row.website !== undefined || row.firm_name !== undefined, {
    message: 'a row names its firm by external_id, website or firm_name',
  });
export type PreparedBriefImportRow = z.infer<typeof preparedBriefImportRowSchema>;

/** The file: an array, each element checked on its own so one bad row is one bad row. */
export const preparedBriefImportFileSchema = z.array(z.unknown()).min(1).max(PREPARED_BRIEF_LIMITS.importRows);

/**
 * `POST /firms/brief/import` (design reset I1): one atomic, idempotent command for a whole
 * prepared-brief file of at most 100 rows. Admin only. In one transaction every row is
 * matched with the CSV importer's matcher (as `/firms/brief/match` does) and every matched
 * row is written; unmatched and ambiguous rows are skipped with their reason. A database
 * failure on any row writes nothing; a replay of the command id answers the stored result.
 */
export const preparedBriefImportCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  rows: z.array(preparedBriefImportRowSchema).min(1).max(PREPARED_BRIEF_LIMITS.importCommandRows),
});
export type PreparedBriefImportCommand = z.infer<typeof preparedBriefImportCommandSchema>;

export const preparedBriefImportRowResultSchema = z.object({
  /** 1-based position in the command's `rows`. */
  index: z.number().int().min(1),
  status: z.enum(['saved', 'unchanged', 'unmatched', 'ambiguous']),
  firmId: uuid.optional(),
  /** For `ambiguous`: the key that named more than one firm. */
  column: z.enum(['external_id', 'website', 'firm_name']).optional(),
});
export type PreparedBriefImportRowResult = z.infer<typeof preparedBriefImportRowResultSchema>;

/** The command's answer and its receipt: ids, statuses and counts, never the text. */
export const preparedBriefImportResultSchema = z.object({
  rows: z.array(preparedBriefImportRowResultSchema),
  counts: z.object({
    saved: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    unmatched: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
  }),
});
export type PreparedBriefImportResult = z.infer<typeof preparedBriefImportResultSchema>;
