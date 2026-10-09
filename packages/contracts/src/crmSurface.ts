import { meetingDeadlineSchema } from './meetingOutcomes.ts';
import { z } from 'zod';
import { followUpPermissionDtoSchema } from './followUps.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { holdEnrollmentDtoSchema, holdReasonCodeSchema } from './reasonCodes.ts';
import { uuid } from './foundationRows.ts';
import { firmReadDtoSchema } from './crm.ts';
import { suppressionChannelSchema } from './dial.ts';
import { preparedBriefDtoSchema } from './preparedBriefs.ts';

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
// Admin CSV import (Appendix G 38) and Add firm (audit item G02)
// ---------------------------------------------------------------------------

/**
 * The columns a file may have. The header row names them, in any order and any subset;
 * `firm_name` is the one every row needs. One row is one contact, with the firm's
 * columns repeated on each of that firm's rows: the first row that names a
 * firm creates it, and the rows after it add their contacts to it.
 *
 * `time_zone` is last, so a file written to the twelve-column list is still a file
 * this one reads. The header is read case-insensitively and a space or a
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
const importColumnSchema = z.enum(IMPORT_COLUMNS);
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
const importIssueCodeSchema = z.enum(IMPORT_ISSUE_CODES);
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
export type ImportFileRefusal = (typeof IMPORT_FILE_REFUSALS)[number];

/** One mebibyte of body is the API's limit; a file is bounded well below it. */
export const importPreviewRequestSchema = z.strictObject({
  csv: z
    .string()
    .min(1)
    .max(512 * 1024),
});

/** `create` makes the firm; `attach` adds the row's contact to a firm that is here or made above. */
const IMPORT_ROW_OUTCOMES = ['create', 'attach', 'duplicate', 'invalid'] as const;
const importRowOutcomeSchema = z.enum(IMPORT_ROW_OUTCOMES);
export type ImportRowOutcomeDto = z.infer<typeof importRowOutcomeSchema>;

/**
 * Which firm a row belongs to when it is not a new one: a firm already in the workspace,
 * by its external id, its website's domain or its name, in that order; or the firm an
 * earlier row of the same file creates. Scoped like every other read, so a firm in the
 * workspace next door is never a match and never named.
 */
const importFirmMatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    firmId: uuid,
    firmName: z.string(),
    matchedOn: z.enum(['external_id', 'domain', 'name']),
  }),
  z.object({ kind: z.literal('in_file'), rowNumber: z.number().int().min(2), matchedOn: z.enum(['domain', 'name']) }),
]);

const importPreviewRowSchema = z.object({
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

/** A file refused whole, at the preview or the commit. 409, like every refusal. */
export const importFileRefusalResponseSchema = z.object({
  status: z.literal('refused'),
  reason: z.string().min(1).max(80),
  column: z.string().max(200).nullable(),
  rowNumber: z.number().int().min(1).nullable(),
});

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
  csv: z
    .string()
    .min(1)
    .max(512 * 1024),
  rows: z
    .array(z.strictObject({ rowNumber: z.number().int().min(2), commandId: commandIdSchema }))
    .min(1)
    .max(2_000),
});

/**
 * One row's answer. A refusal names the row, its code and, where one field is at fault,
 * the column: `{ rowNumber: 7, status: 'refused', reason: 'email_invalid',
 * column: 'contact_email' }`. `outcome` says whether an accepted row made its firm or
 * added a contact to one; an older receipt replays without it.
 */
const importCommitResultSchema = z.object({
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
 * form. The same draft, the same validation, the same duplicate rules and
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

export const addFirmResultSchema = z.object({
  firmId: uuid,
  contactId: uuid.nullable(),
  routeIds: z.array(uuid),
});

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

// ---------------------------------------------------------------------------
// A firm's calling basics (slice S2)
// ---------------------------------------------------------------------------

/**
 * `POST /crm/firms/basics`: a firm's number, state, locality and time zone, edited from
 * Today or the firm page (slice S2). A new endpoint, so nothing an installed desktop sends
 * or reads changes. Every value is as typed; the domain canonicalizes and refuses, naming
 * each field at fault. Absent leaves a field alone; `null` clears the locality or state.
 */
export const FIRM_BASICS_FIELDS = ['phone', 'locality', 'regionCode', 'timeZone'] as const;
export const FIRM_BASICS_ISSUE_CODES = ['phone_invalid', 'region_code_invalid', 'time_zone_invalid', 'too_long'] as const;

export const firmBasicsCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
  phone: z.strictObject({ number: z.string().min(1).max(40), replacesRouteId: uuid.optional() }).optional(),
  locality: z.string().max(200).nullable().optional(),
  regionCode: z.string().max(10).nullable().optional(),
  timeZone: z.string().min(1).max(64).optional(),
});
export type FirmBasicsCommand = z.infer<typeof firmBasicsCommandSchema>;

export const firmBasicsIssueSchema = z.object({ field: z.enum(FIRM_BASICS_FIELDS), code: z.enum(FIRM_BASICS_ISSUE_CODES) });
export type FirmBasicsIssueDto = z.infer<typeof firmBasicsIssueSchema>;

export const firmBasicsResultSchema = z.object({
  firmId: uuid,
  /** The number the edit recorded, or null when no number was given. */
  routeId: uuid.nullable(),
  locality: z.string().nullable(),
  regionCode: z.string().nullable(),
  timeZone: z.string().nullable(),
  /** What still stands between the firm and a call (`TODAY_CARD_BLOCKERS`). */
  blockers: z.array(z.enum(['no_phone', 'no_location'])),
});

export const firmBasicsAcceptedSchema = z.object({
  status: z.literal('accepted'),
  replayed: z.boolean(),
  result: firmBasicsResultSchema,
});

export const firmBasicsRefusalSchema = z.object({
  status: z.literal('refused'),
  replayed: z.boolean(),
  reason: z.string().min(1).max(80),
  issues: z.array(firmBasicsIssueSchema).optional(),
});

// ---------------------------------------------------------------------------
// The Firm page read (7.2, 7.3, 8.1, 15)
// ---------------------------------------------------------------------------

/**
 * The Firm page read's second version: each route carries its
 * `technicalValidation`. Without `pageVersion` the answer is the first version exactly,
 * which is what an installed 1.0.5 asks for and parses strictly; any other version is a
 * malformed request rather than a guess.
 */
export const FIRM_PAGE_VERSION = 2;

export const firmPageRequestSchema = z.strictObject({
  firmId: uuid,
  pageVersion: z.literal(FIRM_PAGE_VERSION).optional(),
  /**
   * Migration 0037 (DESIGN-S3X §2.5, P2): `['stops']` adds `stops`, the channels the firm's
   * and its contacts' stops cover. Negotiated, so the installed 1.0.29, which parses the
   * answer strictly and never asks, never meets the key.
   *
   * Lane PB (migration 0038): `['preparedBrief']` adds `preparedBrief`, the firm's prepared
   * brief or null. Negotiated for the same reason.
   */
  include: z
    .array(z.enum(['stops', 'preparedBrief', 'tasks', 'timeline', 'meeting_tasks']))
    .max(5)
    .optional(),
  /**
   * S4F: with `include: ['timeline']`, the page of the activity timeline older than this
   * cursor (an opaque `nextBefore` from an earlier answer). Absent: the newest page.
   */
  timelineBefore: z.string().min(1).max(120).optional(),
});

/**
 * S4F: the firm's open work, read-only (`include: ['tasks']`). Acting on a task stays where
 * it is today (Today's lanes and the callbacks); this lists them beside the firm.
 *
 *  * `callback` — an open callback someone asked for (`callbacks.due_at`);
 *  * `call_task` — a promise made on a call (`call_tasks.text`);
 *  * `step` — a pending or held call or LinkedIn step of a sequence (`step_executions`).
 */
export const FIRM_TASK_KINDS = ['callback', 'call_task', 'step', 'meeting_task'] as const;
export const firmTaskDtoSchema = z.strictObject({
  deadline: meetingDeadlineSchema.optional(),
  key: z.string().max(80),
  kind: z.enum(FIRM_TASK_KINDS),
  /** A short label: the task's own text, or a code the desktop puts in words. */
  label: z.string().max(300),
  dueAt: z.iso.datetime(),
  status: z.enum(['open', 'held']),
});
export type FirmTaskDto = z.infer<typeof firmTaskDtoSchema>;

/**
 * S4F: one chronological list of what happened at the firm (`include: ['timeline']`), newest
 * first, 50 to a page. Codes and ids only: no message body, no note, no transcript.
 *
 *  * `call` — a logged call; `code` is its outcome;
 *  * `outcome_corrected` — an outcome changed after the fact; `code` is the new outcome and
 *    `detail` the one it replaced;
 *  * `email_sent` / `email_received` — a message matched to the firm; `detail` is its subject;
 *  * `stage_change` — `code` is the stage moved to and `detail` the one it left;
 *  * `stop_recorded` / `stop_lifted` — a stop on the firm or on one of its contacts' handles;
 *    `code` is the stop's source.
 */
export const FIRM_TIMELINE_KINDS = [
  'call',
  'outcome_corrected',
  'email_sent',
  'email_received',
  'stage_change',
  'stop_recorded',
  'stop_lifted',
] as const;
export const firmTimelineEventSchema = z.strictObject({
  /** Stable across pages and re-reads, so a repeated row is recognised and not shown twice. */
  key: z.string().max(120),
  at: z.iso.datetime(),
  kind: z.enum(FIRM_TIMELINE_KINDS),
  code: z.string().max(80).nullable(),
  detail: z.string().max(200).nullable(),
  /**
   * The cursor that asks for the page of events older than THIS one. The desktop takes it
   * from the oldest row it is showing, so a refreshed first page merged with older pages it
   * already holds can never leave a gap behind a stale page cursor.
   */
  cursor: z.string().max(120),
});
export const firmTimelineSchema = z.strictObject({
  events: z.array(firmTimelineEventSchema).max(50),
  /** The cursor for the next (older) page, or null when this was the last. */
  nextBefore: z.string().max(120).nullable(),
});
export type FirmTimelineEvent = z.infer<typeof firmTimelineEventSchema>;
export type FirmTimeline = z.infer<typeof firmTimelineSchema>;

/**
 * What the firm page says is stopped (migration 0037, David's P2: the CRM shows "Email
 * stopped" on the contact). Computed with the readers' own rule: e-mail is stopped by an
 * `email` or `all` stop, calls by a `phone` or `all` stop.
 *
 *  * `firm` — the channels the firm's own effective stops carry (`phone`, `email`, `all`),
 *    sorted; empty when the firm is not stopped.
 *  * `contacts` — every contact with a stop on one of their handles (numbers and
 *    addresses, the union a send and a dial both read), and which of the two channels
 *    that stops. A contact with neither is not listed. A firm stop is not repeated here.
 */
export const firmStopsDtoSchema = z.strictObject({
  firm: z.array(suppressionChannelSchema),
  contacts: z.array(z.strictObject({ contactId: uuid, email: z.boolean(), phone: z.boolean() })),
});
export type FirmStopsDto = z.infer<typeof firmStopsDtoSchema>;

const stageEventDtoSchema = z.strictObject({
  id: uuid,
  occurredAt: z.iso.datetime(),
  fromStageKey: z.string().nullable(),
  toStageKey: z.string(),
  actorKind: z.enum(['user', 'admin', 'system', 'worker']),
  /** Section 8.1: "Lost changes require a reason". Null for every other change. */
  reason: z.string().nullable(),
});

const firmHoldDtoSchema = z.strictObject({
  id: uuid,
  reasonCode: holdReasonCodeSchema,
  blockedActionKinds: z.array(z.string()),
  startedAt: z.iso.datetime(),
  recoveryAction: z.string().nullable(),
  enrollment: holdEnrollmentDtoSchema.nullable().optional(),
});

const opportunitySummaryDtoSchema = z.strictObject({
  id: uuid,
  status: z.enum(['open', 'won', 'lost']),
  stageKey: z.string(),
  controlMode: z.enum(['automated', 'manual']),
  controlModeReason: z.string().nullable(),
  /**
   * Which of migration 0025's causes put it in manual, or null for an opportunity that
   * went manual before the column existed. The page uses it to decide whether the
   * takeover control has anything left to say (P1-1 of the second review of PR 332).
   */
  controlModeOrigin: z
    .enum(['human_reply', 'engaged_call', 'direct_send', 'salesperson_command', 'direct_send_keep_automation'])
    .nullable(),
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
    /**
     * The firm's follow-up permissions, newest grant first (migration 0025). Here
     * rather than on a screen of its own because the question a person asks is "why
     * may Callie write to these people, and until when?", and the firm page is where
     * they ask it.
     */
    followUpPermissions: z.array(followUpPermissionDtoSchema),
    /** Present exactly when the request negotiated `include: ['stops']` (migration 0037). */
    stops: firmStopsDtoSchema.optional(),
    /**
     * Present exactly when the request negotiated `include: ['preparedBrief']` (lane PB,
     * migration 0038): the firm's prepared brief, or null when it has none.
     */
    preparedBrief: preparedBriefDtoSchema.nullable().optional(),
    /** Present exactly when the request negotiated `include: ['tasks']` (S4F). */
    tasks: z.array(firmTaskDtoSchema).optional(),
    /** Present exactly when the request negotiated `include: ['timeline']` (S4F). */
    timeline: firmTimelineSchema.optional(),
  }),
]);
export type FirmPageResponse = z.infer<typeof firmPageResponseSchema>;

export const pluralFirmPageResponseSchema = z.discriminatedUnion('visibility', [
  firmPageResponseSchema.options[0].extend({ version: z.literal(3) }),
  firmPageResponseSchema.options[1]
    .omit({ opportunity: true, stageHistory: true })
    .extend({
      version: z.literal(3),
      opportunities: z.array(
        z.strictObject({
          opportunity: opportunitySummaryDtoSchema,
          displayName: z.string().max(160).nullable(),
          stageControlMode: z.enum(['legacy_rules', 'human']),
          stageHistory: z.array(stageEventDtoSchema),
        }),
      ),
    }),
]);
export type PluralFirmPageResponse = z.infer<typeof pluralFirmPageResponseSchema>;
