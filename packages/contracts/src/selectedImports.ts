import { z } from "zod";
import { uuid, instant } from "./foundationRows.ts";
import { commandIdSchema } from "./auth.ts";
import { semanticVersionSchema } from "./clientVersion.ts";
import { personSourceSchema } from "./people.ts";
export const selectedParticipantSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    endpoint: z.string().max(320).nullable(),
    provenance: z.enum(["parsed", "user_supplied"]),
  })
  .strict();
export const selectedAttachmentSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    url: z
      .string()
      .url()
      .max(2000)
      .refine((value) => /^https?:\/\//u.test(value))
      .nullable(),
  })
  .strict();
export const selectedImportInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(20000)
      .refine((value) => value.trim().length > 0 && !value.includes("\0")),
    subtype: z.enum(["pasted_text", "transcript", "selected_file"]),
    label: z.string().trim().min(1).max(240),
    direction: z.enum(["incoming", "outgoing", "draft", "unknown"]),
    participants: z
      .array(selectedParticipantSchema)
      .max(20)
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).length <= 19000,
      )
      .default([]),
    occurredAt: instant.nullable().default(null),
    attachments: z
      .array(selectedAttachmentSchema)
      .max(20)
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).length <= 49000,
      )
      .default([]),
  })
  .strict();
export const selectedImportPreviewSchema = z
  .object({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    parserVersion: z.literal("selected-v1"),
    participants: z.array(selectedParticipantSchema),
    occurredAt: instant.nullable(),
    dateProvenance: z.enum(["parsed", "user_supplied", "unknown"]),
    direction: z.enum(["incoming", "outgoing", "draft", "unknown"]),
    directionVerified: z.literal(false),
    attribution: z.enum(["unknown", "asserted"]),
    candidates: z.array(
      z
        .object({
          endpoint: z.string(),
          outcome: z.enum([
            "person_match",
            "firm_endpoint_match",
            "needs_review",
            "no_supported_match",
          ]),
          personId: uuid.nullable(),
          firmId: uuid.nullable(),
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
  })
  .strict();
const envelope = {
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
};
const binding = {
  personId: uuid.nullable().default(null),
  firmId: uuid.nullable().default(null),
};
export const selectedImportCommitPayloadSchema = selectedImportInputSchema
  .extend({
    ...binding,
    importKey: z.string().min(1).max(160),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    parserVersion: z.literal("selected-v1"),
  })
  .refine((input) => (input.personId === null) !== (input.firmId === null));
export const selectedImportCommitSchema =
  selectedImportCommitPayloadSchema.safeExtend(envelope);
export const selectedImportReadSchema = z
  .object({
    ...binding,
    afterId: uuid.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((input) => (input.personId === null) !== (input.firmId === null));
export const selectedImportMetadataSchema = z
  .object({
    revision: z.number().int().positive(),
    subtype: z.enum(["pasted_text", "transcript", "selected_file"]),
    label: z.string().nullable(),
    participants: z.array(selectedParticipantSchema).nullable(),
    attachments: z.array(selectedAttachmentSchema).nullable(),
    direction: z.enum(["incoming", "outgoing", "draft", "unknown"]).nullable(),
    directionVerified: z.literal(false),
    attribution: z.enum(["unknown", "asserted"]).nullable(),
    dateProvenance: z.enum(["parsed", "user_supplied", "unknown"]).nullable(),
  })
  .strict();
export const selectedImportPageSchema = z
  .object({
    imports: z.array(
      z
        .object({
          source: personSourceSchema,
          metadata: selectedImportMetadataSchema,
        })
        .strict(),
    ),
    nextAfterId: uuid.nullable(),
  })
  .strict();
export const selectedImportChangePayloadSchema = z
  .object({
    sourceId: uuid,
    expectedSourceRevision: z.number().int().positive(),
    expectedMetadataRevision: z.number().int().positive(),
  })
  .strict();
export const selectedImportChangeSchema =
  selectedImportChangePayloadSchema.extend(envelope);
export const selectedImportCorrectPayloadSchema =
  selectedImportInputSchema.extend({
    sourceId: uuid,
    expectedSourceRevision: z.number().int().positive(),
    expectedMetadataRevision: z.number().int().positive(),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    parserVersion: z.literal("selected-v1"),
  });
export const selectedImportCorrectSchema =
  selectedImportCorrectPayloadSchema.extend(envelope);
export const selectedImportResultSchema = z
  .object({
    sourceId: uuid,
    sourceRevision: z.number().int().positive(),
    metadataRevision: z.number().int().positive(),
  })
  .strict();
