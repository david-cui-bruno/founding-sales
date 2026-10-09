import { z } from "zod";
import { canonicalSourceReferenceSchema } from "./people.ts";
import { crmSourceLookupSchema } from "./crmProcessing.ts";
import { firmTaskDtoSchema, firmTimelineEventSchema } from "./crmSurface.ts";
// Ask scopes use the same millisecond precision as displayed activity/provider dates.
// Reject finer input instead of silently truncating it during interval validation.
const askScopeDateSchema = z.iso.datetime().refine(
  (value) => !/\.\d{4,}Z$/u.test(value),
  "Ask date scopes support at most millisecond precision",
);
export const askScopeSchema = z
  .strictObject({
    firmId: z.uuid(),
    from: askScopeDateSchema.optional(),
    to: askScopeDateSchema.optional(),
  })
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      Date.parse(value.from) < Date.parse(value.to),
  );
const askOpportunitiesReadSchema = z.strictObject({
  operation: z.literal("opportunities"),
  scope: askScopeSchema,
  status: z.enum(["open", "all"]).default("open"),
  limit: z.number().int().min(1).max(50).default(20),
});
export const askCoverageSchema = z.strictObject({
  scope: z.literal("current_permitted_crm_state"),
  acquisition: z.literal("unverified"),
  semantic: z.literal("not_requested"),
});
const askOpportunitiesResponseSchema = z.strictObject({
  operation: z.literal("opportunities"),
  scope: askScopeSchema,
  dateBasis: z.literal("opportunity_opened_at"),
  count: z.string().regex(/^(0|[1-9]\d*)$/u),
  records: z
    .array(
      z.strictObject({
        opportunityId: z.uuid(),
        firmId: z.uuid(),
        name: z.string().nullable(),
        status: z.enum(["open", "won", "lost"]),
        stageKey: z.string(),
        openedAt: z.iso.datetime(),
      }),
    )
    .max(50),
  truncated: z.boolean(),
  coverage: askCoverageSchema,
});

const askRecordsReadSchema = z.strictObject({
  operation: z.literal("records"),
  query: z.string().trim().min(1).max(160),
  kind: z.enum(["people", "firms"]),
  afterId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
const askTasksReadSchema = z.strictObject({
  operation: z.literal("tasks"),
  scope: askScopeSchema,
  limit: z.number().int().min(1).max(50).default(20),
});
export const askCopiedSourceSchema = crmSourceLookupSchema
  .extend({ locator: z.null() })
  .strict();
export const askExplicitCorpusScopeSchema = z.strictObject({
  sources: z
    .array(askCopiedSourceSchema)
    .min(1)
    .max(10)
    .refine(
      (sources) =>
        new Set(sources.map((source) => `${source.kind}:${source.sourceId}`))
          .size === sources.length,
    ),
});
const askPassagesReadSchema = z.strictObject({
  operation: z.literal("passages"),
  scope: z.union([
    z.strictObject({ personId: z.uuid(), afterSourceId: z.uuid().optional() }),
    askExplicitCorpusScopeSchema,
  ]),
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(50).default(20),
});
const askActivityReadSchema = z.strictObject({
  operation: z.literal("activity"),
  scope: askScopeSchema,
  before: z
    .string()
    .max(120)
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\|[a-z_]+\|[a-zA-Z0-9:-]+$/u,
    )
    .optional(),
});
const askReplyReadSchema = z.strictObject({
  operation: z.literal("reply_status"),
  scope: askScopeSchema,
});
export const askSourcesScopeSchema = z.union([
  z.strictObject({ personId: z.uuid() }),
  z.strictObject({ firmId: z.uuid() }),
]);
export const askSourceCursorSchema = z.strictObject({
  kind: canonicalSourceReferenceSchema.shape.kind,
  sourceId: z.uuid(),
});
export const askSourcesReadSchema = z.strictObject({
  operation: z.literal("sources"),
  scope: askSourcesScopeSchema,
  after: askSourceCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const askDiscoverySourceSchema = canonicalSourceReferenceSchema
  .extend({ observedAt: z.iso.datetime().nullable() })
  .refine(
    (source) =>
      source.availability !== "available" || source.observedAt !== null,
  );
const askSourcesResponseSchema = z.strictObject({
  operation: z.literal("sources"),
  scope: askSourcesScopeSchema,
  sources: z.array(askDiscoverySourceSchema).max(50),
  nextAfter: askSourceCursorSchema.nullable(),
  coverage: z.strictObject({
    scope: z.literal("record_copied_sources"),
    acquisition: z.literal("unverified"),
    semantic: z.literal("not_requested"),
    scanComplete: z.boolean(),
    candidateCeiling: z.literal(50),
    sizeBoundReached: z.boolean(),
  }),
});
export const askReadSchema = z.discriminatedUnion("operation", [
  askSourcesReadSchema,
  askOpportunitiesReadSchema,
  askRecordsReadSchema,
  askTasksReadSchema,
  askPassagesReadSchema,
  askActivityReadSchema,
  askReplyReadSchema,
]);
const askRecordsResponseSchema = z.strictObject({
  operation: z.literal("records"),
  selection: z.enum(["none", "single", "ambiguous", "unresolved"]),
  records: z
    .array(
      z.strictObject({
        recordId: z.uuid(),
        kind: z.enum(["person", "firm"]),
        name: z.string(),
        firmId: z.uuid().nullable(),
      }),
    )
    .max(50),
  nextAfterId: z.uuid().nullable(),
  scanComplete: z.boolean(),
  coverage: askCoverageSchema,
});
const askTasksResponseSchema = z.strictObject({
  operation: z.literal("tasks"),
  scope: askScopeSchema,
  dateBasis: z.literal("task_due_at"),
  count: z.string().regex(/^(0|[1-9]\d*)$/u),
  records: z.array(firmTaskDtoSchema).max(50),
  truncated: z.boolean(),
  coverage: askCoverageSchema,
});
export const askCorpusCoverageSchema = z.strictObject({
  scope: z.literal("explicit_copied_sources"),
  acquisition: z.literal("unverified"),
  semantic: z.literal("not_requested"),
  scanComplete: z.boolean(),
  requestedSources: z.number().int().min(1).max(10),
  inspectedSources: z.number().int().min(0).max(10),
  unavailableSources: z.number().int().min(0).max(10),
  refusedSources: z.number().int().min(0).max(10),
  truncatedSources: z.number().int().min(0).max(10),
  inspectedWindows: z.number().int().min(0).max(1000),
  textBytes: z.number().int().min(0).max(800000),
  sourceByteCeiling: z.literal(80000),
  textByteCeiling: z.literal(800000),
  windowCeiling: z.literal(1000),
  omittedSignatures: z.number().int().min(0).max(10),
  chunkerVersion: z.literal("lexical-original-v1"),
});
const askPassagesResponseSchema = z
  .strictObject({
    operation: z.literal("passages"),
    scope: askPassagesReadSchema.shape.scope,
    passages: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          sources: z.array(canonicalSourceReferenceSchema).min(1).max(1000),
        }),
      )
      .max(50),
    nextAfterSourceId: z.uuid().nullable(),
    truncated: z.boolean(),
    coverage: z.union([
      z.strictObject({
        scope: z.literal("selected_person_copies"),
        acquisition: z.literal("unverified"),
        semantic: z.literal("not_requested"),
        scanComplete: z.boolean(),
        unavailableSources: z.number().int().min(0).max(50),
        omittedSignatures: z.number().int().min(0).max(50),
        chunkerVersion: z.literal("lexical-original-v1"),
      }),
      askCorpusCoverageSchema,
    ]),
  })
  .refine(
    (value) =>
      "sources" in value.scope ===
      (value.coverage.scope === "explicit_copied_sources"),
  );
const askActivityResponseSchema = z.strictObject({
  operation: z.literal("activity"),
  scope: askScopeSchema,
  dateBasis: z.literal("operational_event_at"),
  events: z.array(firmTimelineEventSchema).max(50),
  nextBefore: z.string().max(120).nullable(),
  scanComplete: z.boolean(),
  coverage: askCoverageSchema,
});
const askReplyResponseSchema = z.strictObject({
  operation: z.literal("reply_status"),
  scope: askScopeSchema,
  dateBasis: z.literal("provider_event_at"),
  verifiedOutgoingCount: z.string().regex(/^(0|[1-9]\d*)$/u),
  withoutVerifiedReplyCount: z.string().regex(/^(0|[1-9]\d*)$/u),
  unanswered: z.literal("not_established"),
  truncated: z.boolean(),
  coverage: z.strictObject({
    scope: z.literal("authorized_progress_receipts"),
    acquisition: z.literal("partial"),
    semantic: z.literal("not_requested"),
  }),
});
export const askResponseSchema = z.discriminatedUnion("operation", [
  askSourcesResponseSchema,
  askOpportunitiesResponseSchema,
  askRecordsResponseSchema,
  askTasksResponseSchema,
  askPassagesResponseSchema,
  askActivityResponseSchema,
  askReplyResponseSchema,
]);
