import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { holdReasonCodeSchema } from './reasonCodes.ts';
import { uuid } from './foundationRows.ts';
import { firmReadDtoSchema } from './crm.ts';

/**
 * The wire contract of the CRM surface: admin CSV import and Add firm (specification
 * 7.2, 14.1, Appendix F, Appendix G 38). Search and export had no caller and went in
 * wave 2, S6.
 *
 * One rule that explains the shapes: **these are POSTs, including the reads.**
 *
 * A search term is a prospect's name, their email address or their phone number, and
 * a query string is the one part of a request that is written to a load balancer
 * access log, kept in a proxy's history and quoted back in an error page. Section
 * 14.1 asks for redacted responses; putting the thing being searched for into the
 * URL would leak it on the way in, where no response shape can help. So the term
 * travels in a JSON body, like every other named field this API takes.
 */

// ---------------------------------------------------------------------------
// Admin CSV import (Appendix G 38) and Add firm (lane g84, audit item G02)
// ---------------------------------------------------------------------------

/**
 * The columns a file may have. The header row names them, in any order and any subset;
 * `firm_name` is the one every row needs. One row is one contact, with the firm's
 * columns repeated on each of that firm's rows (lane g84): the first row that names a
 * firm creates it, and the rows after it add their contacts to it.
 *
 * `time_zone` joined in lane g84, at the end, so a file written to the old list is
 * still a file this one reads. The header is read case-insensitively and a space or a
 * hyphen reads as an underscore, so `Firm name` is `firm_name`.
 */
export const IMPORT_COLUMNS = [
  'firm_name',
  'website',
  'address_line',
  'locality',
  'region_code',
  'postal_code',
  'external_id',
  'owner_user_id',
  'contact_name',
  'contact_title',
  'contact_email',
  'contact_phone',
  'time_zone',
] as const;
export const importColumnSchema = z.enum(IMPORT_COLUMNS);
export type ImportColumn = z.infer<typeof importColumnSchema>;

/**
 * What can be wrong with one row, by column.
 *
 * `duplicate_in_file` and `duplicate_in_workspace` are rows with nothing new in them:
 * the firm is already there and so is the contact (matched by email, or by name when
 * the row has no email), or the row names only a firm that is already there. A row
 * whose firm is already there and whose contact is not is not a duplicate: it adds the
 * contact (`attach`). `firm_ambiguous` is a row whose website or name matches two firms
 * here, which only a merge can settle; `time_zone_invalid` is a zone this runtime cannot
 * place on a clock; `too_long` is a cell longer than the column the database keeps it in.
 * The last three joined in lane g84.
 */
export const IMPORT_ISSUE_CODES = [
  'firm_name_missing',
  'website_invalid',
  'region_code_invalid',
  'postal_code_invalid',
  'email_invalid',
  'phone_invalid',
  'contact_name_missing',
  'owner_unknown',
  'duplicate_in_file',
  'duplicate_in_workspace',
  'time_zone_invalid',
  'firm_ambiguous',
  'too_long',
] as const;
export const importIssueCodeSchema = z.enum(IMPORT_ISSUE_CODES);
export type ImportIssueCode = z.infer<typeof importIssueCodeSchema>;

export const importIssueSchema = z.object({ column: importColumnSchema, code: importIssueCodeSchema });
export type ImportIssueDto = z.infer<typeof importIssueSchema>;

/**
 * Why a whole file was refused before any row was read, and where. `column` names the
 * header a `csv_column_unknown` or `csv_column_repeated` found; `rowNumber` names the
 * line a `csv_row_width` found, counted as a spreadsheet counts them, the header being 1.
 */
export const IMPORT_FILE_REFUSALS = [
  'csv_empty',
  'csv_column_unknown',
  'csv_column_repeated',
  'csv_row_width',
  'csv_too_many_rows',
] as const;
export const importFileRefusalSchema = z.enum(IMPORT_FILE_REFUSALS);

/** One mebibyte of body is the API's limit; a file is bounded well below it. */
export const importPreviewRequestSchema = z.strictObject({ csv: z.string().min(1).max(512 * 1024) });

/** `create` makes the firm; `attach` adds the row's contact to a firm that is here or made above. */
export const IMPORT_ROW_OUTCOMES = ['create', 'attach', 'duplicate', 'invalid'] as const;
export const importRowOutcomeSchema = z.enum(IMPORT_ROW_OUTCOMES);
export type ImportRowOutcomeDto = z.infer<typeof importRowOutcomeSchema>;

/**
 * Which firm a row belongs to when it is not a new one: a firm already in the workspace,
 * by its external id, its website's domain or its name, in that order; or the firm an
 * earlier row of the same file creates. Scoped like every other read, so a firm in the
 * workspace next door is never a match and never named.
 */
export const importFirmMatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    firmId: uuid,
    firmName: z.string(),
    matchedOn: z.enum(['external_id', 'domain', 'name']),
  }),
  z.object({ kind: z.literal('in_file'), rowNumber: z.number().int().min(2), matchedOn: z.enum(['domain', 'name']) }),
]);
export type ImportFirmMatchDto = z.infer<typeof importFirmMatchSchema>;

export const importPreviewRowSchema = z.object({
  rowNumber: z.number().int().min(2),
  outcome: importRowOutcomeSchema,
  issues: z.array(importIssueSchema),
  firm: z.object({
    name: z.string(),
    website: z.string().nullable(),
    addressLine: z.string().nullable(),
    locality: z.string().nullable(),
    regionCode: z.string().nullable(),
    postalCode: z.string().nullable(),
    externalId: z.string().nullable(),
    ownerUserId: z.string().nullable(),
    timeZone: z.string().nullable(),
  }),
  contact: z.object({ fullName: z.string(), title: z.string().nullable() }).nullable(),
  routes: z.array(z.object({ kind: z.enum(['email', 'phone']), value: z.string() })),
  /** Null for a new firm and for a row too broken to match. */
  match: importFirmMatchSchema.nullable(),
});
export type ImportPreviewRowDto = z.infer<typeof importPreviewRowSchema>;

export const importPreviewResponseSchema = z.object({
  rows: z.array(importPreviewRowSchema),
  counts: z.object({
    create: z.number().int().min(0),
    attach: z.number().int().min(0),
    duplicate: z.number().int().min(0),
    invalid: z.number().int().min(0),
  }),
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

/** A file refused whole, at the preview or the commit (lane g84). 409, like every refusal. */
export const importFileRefusalResponseSchema = z.object({
  status: z.literal('refused'),
  reason: z.string().min(1).max(80),
  column: z.string().max(200).nullable(),
  rowNumber: z.number().int().min(1).nullable(),
});
export type ImportFileRefusalResponse = z.infer<typeof importFileRefusalResponseSchema>;

/**
 * The commit.
 *
 * The *file* is sent again, not the preview: a preview is a value the client holds,
 * and a client that could post an edited one would be posting rows the server never
 * validated. The server re-previews the same bytes and commits the rows the caller
 * named, in row order, each under its own command id — so one row is one receipt, one
 * transaction and one atomic effect (Appendix G 38), and a retry of the whole file
 * commits the rows that did not land and replays the ones that did.
 */
export const importCommitRequestSchema = z.strictObject({
  clientVersion: semanticVersionSchema,
  csv: z.string().min(1).max(512 * 1024),
  rows: z
    .array(z.strictObject({ rowNumber: z.number().int().min(2), commandId: commandIdSchema }))
    .min(1)
    .max(2_000),
});

/**
 * One row's answer. A refusal names the row, its code and, where one field is at fault,
 * the column (lane g84): `{ rowNumber: 7, status: 'refused', reason: 'email_invalid',
 * column: 'contact_email' }`. `outcome` says whether an accepted row made its firm or
 * added a contact to one; a receipt written before lane g84 replays without it.
 */
export const importCommitResultSchema = z.object({
  rowNumber: z.number().int().min(2),
  status: z.enum(['accepted', 'refused']),
  replayed: z.boolean(),
  reason: z.string().nullable(),
  firmId: uuid.nullable(),
  column: importColumnSchema.nullable().optional(),
  outcome: z.enum(['created', 'attached']).nullable().optional(),
});
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;

export const importCommitResponseSchema = z.object({
  results: z.array(importCommitResultSchema),
  counts: z.object({
    accepted: z.number().int().min(0),
    refused: z.number().int().min(0),
  }),
});
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;

/**
 * `POST /crm/firms/add`: the Add firm form, which is one row of an import typed into a
 * form (lane g84). The same draft, the same validation, the same duplicate rules and
 * the same commit as a CSV row, under one receipt. Every value is a string as the person
 * typed it; the domain trims, canonicalizes and refuses, and a refusal names each field
 * by its import column so the form marks the one at fault.
 *
 * It is not admin-only: a salesperson may create a firm assigned to themselves (7.2).
 * A firm that is already here is refused as `duplicate_in_workspace` with its id, not
 * silently added to, because "Add firm" that quietly edits a different firm is not what
 * the button says.
 */
export const addFirmCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firm: z.strictObject({
    name: z.string().max(300),
    website: z.string().max(500).optional(),
    timeZone: z.string().max(64).optional(),
  }),
  contact: z
    .strictObject({
      fullName: z.string().max(200),
      title: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
});
export type AddFirmCommand = z.infer<typeof addFirmCommandSchema>;

export const addFirmResultSchema = z.object({
  firmId: uuid,
  contactId: uuid.nullable(),
  routeIds: z.array(uuid),
});
export type AddFirmResult = z.infer<typeof addFirmResultSchema>;

/** The accepted answer, in the envelope every command answers with (routeSupport). */
export const addFirmAcceptedSchema = z.object({
  status: z.literal('accepted'),
  replayed: z.boolean(),
  result: addFirmResultSchema,
});

/**
 * A refused Add firm. `issues` is every field at fault, so the form can mark them all at
 * once; `firmId` is the firm a `duplicate_in_workspace` matched, so the form can offer
 * to open it. Both are kept on the receipt, so a replay says the same.
 */
export const addFirmRefusalSchema = z.object({
  status: z.literal('refused'),
  replayed: z.boolean(),
  reason: z.string().min(1).max(80),
  issues: z.array(importIssueSchema).optional(),
  firmId: uuid.optional(),
});
export type AddFirmRefusal = z.infer<typeof addFirmRefusalSchema>;

// ---------------------------------------------------------------------------
// The Firm page read (7.2, 7.3, 8.1, 15)
// ---------------------------------------------------------------------------

/**
 * The Firm page read's second version (lane g90): each route carries its
 * `technicalValidation`. Without `pageVersion` the answer is the first version exactly,
 * which is what an installed 1.0.5 asks for and parses strictly; any other version is a
 * malformed request rather than a guess.
 */
export const FIRM_PAGE_VERSION = 2;

export const firmPageRequestSchema = z.strictObject({
  firmId: uuid,
  pageVersion: z.literal(FIRM_PAGE_VERSION).optional(),
});

export const stageEventDtoSchema = z.strictObject({
  id: uuid,
  occurredAt: z.iso.datetime(),
  fromStageKey: z.string().nullable(),
  toStageKey: z.string(),
  actorKind: z.enum(['user', 'admin', 'system', 'worker']),
  /** Section 8.1: "Lost changes require a reason". Null for every other change. */
  reason: z.string().nullable(),
});
export type StageEventDto = z.infer<typeof stageEventDtoSchema>;

export const firmHoldDtoSchema = z.strictObject({
  id: uuid,
  reasonCode: holdReasonCodeSchema,
  blockedActionKinds: z.array(z.string()),
  startedAt: z.iso.datetime(),
  recoveryAction: z.string().nullable(),
});
export type FirmHoldDto = z.infer<typeof firmHoldDtoSchema>;

export const opportunitySummaryDtoSchema = z.strictObject({
  id: uuid,
  status: z.enum(['open', 'won', 'lost']),
  stageKey: z.string(),
  controlMode: z.enum(['automated', 'manual']),
  controlModeReason: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  closeReason: z.string().nullable(),
});

/**
 * Two shapes, not one with optional fields. A colleague's Firm page has no
 * `stageHistory` key at all, rather than an empty array that would say there is
 * nothing to show instead of saying that this caller may not see it.
 */
export const firmPageResponseSchema = z.discriminatedUnion('visibility', [
  z.strictObject({ visibility: z.literal('any_active_member'), read: firmReadDtoSchema }),
  z.strictObject({
    visibility: z.literal('assigned_or_admin'),
    read: firmReadDtoSchema,
    opportunity: opportunitySummaryDtoSchema.nullable(),
    stageHistory: z.array(stageEventDtoSchema),
    holds: z.array(firmHoldDtoSchema),
  }),
]);
export type FirmPageResponse = z.infer<typeof firmPageResponseSchema>;
