import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { holdReasonCodeSchema } from './reasonCodes.ts';
import { uuid } from './foundationRows.ts';
import { firmIdentityDtoSchema, firmReadDtoSchema, routeEligibilitySchema } from './crm.ts';

/**
 * The wire contract of the CRM surface: search, admin CSV import, and export
 * (specification 7.2, 14.1, Appendix F, Appendix G 38).
 *
 * Three shapes, and one rule that explains all three: **these are POSTs, including
 * the two that are reads.**
 *
 * A search term is a prospect's name, their email address or their phone number, and
 * a query string is the one part of a request that is written to a load balancer
 * access log, kept in a proxy's history and quoted back in an error page. Section
 * 14.1 asks for redacted responses; putting the thing being searched for into the
 * URL would leak it on the way in, where no response shape can help. So the term
 * travels in a JSON body, like every other named field this API takes.
 */

// ---------------------------------------------------------------------------
// Filters, shared by search and export
// ---------------------------------------------------------------------------

export const SEQUENCE_STATUS_FILTERS = ['any', 'none', 'active', 'stopped'] as const;
export const sequenceStatusFilterSchema = z.enum(SEQUENCE_STATUS_FILTERS);

export const searchFiltersSchema = z.strictObject({
  /** Exactly one of `userId` and `unassigned`. Both, or neither, is refused. */
  owner: z
    .strictObject({ userId: uuid.optional(), unassigned: z.literal(true).optional() })
    .optional(),
  stageKey: z.string().max(40).optional(),
  sequenceStatus: sequenceStatusFilterSchema.optional(),
  holdReasonCode: holdReasonCodeSchema.optional(),
  routeEligibility: routeEligibilitySchema.optional(),
  activeSince: z.iso.datetime().optional(),
  activeUntil: z.iso.datetime().optional(),
});
export type SearchFiltersInput = z.infer<typeof searchFiltersSchema>;

export const SEARCH_MATCH_FIELDS = [
  'name',
  'domain',
  'locality',
  'alias',
  'address',
  'contact',
  'email',
  'phone',
] as const;
export const searchMatchFieldSchema = z.enum(SEARCH_MATCH_FIELDS);

export const searchRequestSchema = z.strictObject({
  /** A fragment. Absent or blank means "every firm this caller may see". */
  term: z.string().max(200).optional(),
  filters: searchFiltersSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** What a hit matched on — field kinds, never the matching value. */
export const searchHitSchema = z.strictObject({
  visibility: z.enum(['any_active_member', 'assigned_or_admin']),
  firm: firmIdentityDtoSchema,
  matchedOn: z.array(searchMatchFieldSchema),
  lastActivityAt: z.iso.datetime(),
});
export type SearchHitDto = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.strictObject({
  hits: z.array(searchHitSchema),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ---------------------------------------------------------------------------
// Admin CSV import (Appendix G 38)
// ---------------------------------------------------------------------------

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
] as const;
export const importColumnSchema = z.enum(IMPORT_COLUMNS);

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
] as const;
export const importIssueCodeSchema = z.enum(IMPORT_ISSUE_CODES);

/** One mebibyte of body is the API's limit; a file is bounded well below it. */
export const importPreviewRequestSchema = z.strictObject({ csv: z.string().min(1).max(512 * 1024) });

export const importPreviewRowSchema = z.strictObject({
  rowNumber: z.number().int().min(2),
  outcome: z.enum(['create', 'duplicate', 'invalid']),
  issues: z.array(z.strictObject({ column: importColumnSchema, code: importIssueCodeSchema })),
  firm: z.strictObject({
    name: z.string(),
    website: z.string().nullable(),
    addressLine: z.string().nullable(),
    locality: z.string().nullable(),
    regionCode: z.string().nullable(),
    postalCode: z.string().nullable(),
    externalId: z.string().nullable(),
    ownerUserId: z.string().nullable(),
  }),
  contact: z.strictObject({ fullName: z.string(), title: z.string().nullable() }).nullable(),
  routes: z.array(z.strictObject({ kind: z.enum(['email', 'phone']), value: z.string() })),
});
export type ImportPreviewRowDto = z.infer<typeof importPreviewRowSchema>;

export const importPreviewResponseSchema = z.strictObject({
  rows: z.array(importPreviewRowSchema),
  counts: z.strictObject({
    create: z.number().int().min(0),
    duplicate: z.number().int().min(0),
    invalid: z.number().int().min(0),
  }),
});

/**
 * The commit.
 *
 * The *file* is sent again, not the preview: a preview is a value the client holds,
 * and a client that could post an edited one would be posting rows the server never
 * validated. The server re-previews the same bytes and commits the rows the caller
 * named, each under its own command id — so one row is one receipt, one transaction
 * and one atomic effect (Appendix G 38), and a retry of the whole file commits the
 * rows that did not land and replays the ones that did.
 */
export const importCommitRequestSchema = z.strictObject({
  clientVersion: semanticVersionSchema,
  csv: z.string().min(1).max(512 * 1024),
  rows: z
    .array(z.strictObject({ rowNumber: z.number().int().min(2), commandId: commandIdSchema }))
    .min(1)
    .max(2_000),
});

export const importCommitResultSchema = z.strictObject({
  rowNumber: z.number().int().min(2),
  status: z.enum(['accepted', 'refused']),
  replayed: z.boolean(),
  reason: z.string().nullable(),
  firmId: uuid.nullable(),
});
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;

export const importCommitResponseSchema = z.strictObject({
  results: z.array(importCommitResultSchema),
  counts: z.strictObject({
    accepted: z.number().int().min(0),
    refused: z.number().int().min(0),
  }),
});

// ---------------------------------------------------------------------------
// Export (5.2)
// ---------------------------------------------------------------------------

export const exportRequestSchema = z.strictObject({
  term: z.string().max(200).optional(),
  filters: searchFiltersSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const exportResponseSchema = z.strictObject({
  rows: z.array(firmReadDtoSchema),
  selection: z.strictObject({ termPresent: z.boolean(), filters: z.array(z.string()) }),
  exportedAt: z.iso.datetime(),
  truncated: z.boolean(),
});
export type ExportResponse = z.infer<typeof exportResponseSchema>;
