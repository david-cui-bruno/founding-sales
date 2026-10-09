import { z } from "zod";
import { commandIdSchema } from "./auth.ts";
import { semanticVersionSchema } from "./clientVersion.ts";
import {
  crmSourceLookupSchema,
  crmExtractionClaimSchema,
} from "./crmProcessing.ts";
import { canonicalSourceReferenceSchema } from "./people.ts";

/** Capture authority is separate from semantic subject attribution. */
export const crmOriginalAccessClosureSchema = z
  .strictObject({
    firmIds: z.array(z.uuid()).max(100),
    personIds: z.array(z.uuid()).max(100),
  })
  .refine(
    (value) =>
      [value.firmIds, value.personIds].every(
        (ids) =>
          JSON.stringify(ids) === JSON.stringify([...new Set(ids)].sort()),
      ),
    "Access identities must be unique and sorted",
  );
export type CrmOriginalAccessClosure = z.infer<
  typeof crmOriginalAccessClosureSchema
>;

export const crmEvidenceReadSchema = z.strictObject({
  source: crmSourceLookupSchema,
  afterClaimId: z.uuid().optional(),
  afterReviewedAnchorId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
const target = {
  source: crmSourceLookupSchema,
  claimId: z.uuid(),
  claimRevision: z.literal(1),
  claimHash: z.string().regex(/^[a-f0-9]{64}$/u),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedDecisionRevision: z.number().int().min(0),
};
export const crmEvidenceDecideSchema = z.discriminatedUnion("action", [
  z.strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    ...target,
    action: z.enum(["confirm", "dismiss"]),
    rationale: z.string().trim().min(1).max(1000).optional(),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    ...target,
    action: z.literal("correct"),
    correctedInterpretation: z.string().trim().min(1).max(1000),
    rationale: z.string().trim().min(1).max(1000).optional(),
  }),
]);
export type CrmEvidenceDecide = z.infer<typeof crmEvidenceDecideSchema>;

const humanDecisionSchema = z.strictObject({
  action: z.enum(["confirm", "dismiss", "correct"]),
  decisionAt: z.iso.datetime(),
  correctedInterpretation: z.string().min(1).max(1000).nullable(),
  rationale: z.string().min(1).max(1000).nullable(),
});
export const crmEvidenceClaimSchema = crmExtractionClaimSchema
  .extend({
    anchorId: z.uuid().nullable(),
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/u),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    decisionRevision: z.number().int().min(0),
    reviewRequired: z.boolean(),
    effectiveState: z.enum([
      "unreviewed",
      "confirmed",
      "dismissed",
      "corrected",
    ]),
    decision: humanDecisionSchema.nullable(),
    decisionHistory: z
      .array(
        humanDecisionSchema.extend({ revision: z.number().int().positive() }),
      )
      .max(50),
    decisionHistoryTruncated: z.boolean(),
  })
  .strict();
export const crmEvidencePageSchema = z.strictObject({
  source: canonicalSourceReferenceSchema,
  claims: z.array(crmEvidenceClaimSchema).max(50),
  reviewedHistory: z.array(crmEvidenceClaimSchema).max(50),
  nextAfterReviewedAnchorId: z.uuid().nullable(),
  nextAfterClaimId: z.uuid().nullable(),
  projection: z.strictObject({
    scope: z.literal("bounded_source_page"),
    counts: z.strictObject({
      current: z.number().int().min(0).max(50),
      reviewedHistory: z.number().int().min(0).max(50),
      confirmed: z.number().int().min(0).max(100),
      dismissed: z.number().int().min(0).max(100),
      corrected: z.number().int().min(0).max(100),
      unreviewed: z.number().int().min(0).max(100),
      reviewRequired: z.number().int().min(0).max(100),
    }),
    truncated: z.boolean(),
    revisionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});
export type CrmEvidencePage = z.infer<typeof crmEvidencePageSchema>;

export const crmEvidenceClaimTargetSchema = z.strictObject(target);
export const crmConflictSaveSchema = z
  .strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    conflictId: z.uuid().optional(),
    expectedConflictRevision: z.number().int().min(0),
    members: z.array(crmEvidenceClaimTargetSchema).min(2).max(10),
  })
  .refine(
    (value) =>
      new Set(value.members.map((member) => member.claimId)).size ===
      value.members.length,
    { message: "Conflict members must be distinct claims" },
  );
export const crmConflictResolveSchema = z.discriminatedUnion("resolution", [
  z.strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    conflictId: z.uuid(),
    expectedConflictRevision: z.number().int().positive(),
    resolution: z.literal("keep_both"),
    rationale: z.string().trim().min(1).max(1000).optional(),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    conflictId: z.uuid(),
    expectedConflictRevision: z.number().int().positive(),
    resolution: z.literal("prefer_claim"),
    preferredAnchorId: z.uuid(),
    rationale: z.string().trim().min(1).max(1000).optional(),
  }),
]);
export const crmConflictReadSchema = z.strictObject({
  conflictId: z.uuid(),
  afterRevision: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export type CrmEvidenceClaimTarget = z.infer<
  typeof crmEvidenceClaimTargetSchema
>;
export type CrmConflictSave = z.infer<typeof crmConflictSaveSchema>;
export type CrmConflictResolve = z.infer<typeof crmConflictResolveSchema>;

const crmConflictHistorySchema = z.strictObject({
  revision: z.number().int().positive(),
  state: z.enum(["open", "resolved"]),
  resolution: z.enum(["keep_both", "prefer_claim"]).nullable(),
  preferredAnchorId: z.uuid().nullable(),
  decidedAt: z.iso.datetime(),
  rationale: z.string().min(1).max(1000).nullable(),
});
export const crmConflictPageSchema = crmConflictHistorySchema
  .omit({ revision: true })
  .extend({
    conflictId: z.uuid(),
    revision: z.number().int().positive(),
    members: z
      .array(crmExtractionClaimSchema.extend({ anchorId: z.uuid() }).strict())
      .min(2)
      .max(10),
    history: z
      .array(
        crmConflictHistorySchema
          .extend({
            memberAnchorIds: z
              .array(z.uuid())
              .min(2)
              .max(10)
              .refine((ids) => new Set(ids).size === ids.length),
          })
          .strict(),
      )
      .max(50),
    nextAfterRevision: z.number().int().positive().nullable(),
  })
  .strict();

export const crmDecisionHistoryReadSchema = z.strictObject({
  kind: crmSourceLookupSchema.shape.kind,
  sourceId: z.uuid(),
  anchorId: z.uuid(),
  beforeRevision: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const crmDecisionHistoryPageSchema = z.strictObject({
  anchorId: z.uuid(),
  sourceId: z.uuid(),
  kind: crmSourceLookupSchema.shape.kind,
  availability: canonicalSourceReferenceSchema.shape.availability,
  originalEventAt: z.iso.datetime().nullable(),
  originalObservedAt: z.iso.datetime().nullable(),
  currentDecisionRevision: z.number().int().min(0),
  basis: z.enum(["available", "source_unavailable", "deleted_redacted"]),
  decisions: z
    .array(
      humanDecisionSchema
        .extend({
          revision: z.number().int().positive(),
          redacted: z.boolean(),
        })
        .strict(),
    )
    .max(50),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export type CrmDecisionHistoryRead = z.infer<
  typeof crmDecisionHistoryReadSchema
>;

export const crmEvidenceWorkIdentitySchema = z.strictObject({
  kind: z.enum(["call_task", "meeting_task"]),
  id: z.uuid(),
});
export const crmEvidenceWorkBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("call_task"),
    id: z.uuid(),
    expectedVersion: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("meeting_task"),
    id: z.uuid(),
    expectedVersion: z.string().regex(/^[1-9][0-9]{0,9}$/u),
  }),
]);
export const crmEvidenceWorkBindSchema = crmEvidenceClaimTargetSchema
  .extend({
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
    work: crmEvidenceWorkBindingSchema,
  })
  .strict();
export const crmEvidenceWorkReadSchema = z.strictObject({
  work: crmEvidenceWorkIdentitySchema,
  afterDependencyId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const crmEvidenceWorkPageSchema = z.strictObject({
  work: crmEvidenceWorkIdentitySchema
    .extend({
      version: z.string().max(40),
      status: z.enum(["open", "done", "cancelled"]),
      completedAt: z.iso.datetime().nullable(),
    })
    .strict(),
  dependencies: z
    .array(
      z.strictObject({
        dependencyId: z.uuid(),
        anchorId: z.uuid(),
        source: crmSourceLookupSchema,
        observedDecisionRevision: z.number().int().min(0),
        observedWorkVersion: z.string().max(40),
        reviewRequired: z.boolean(),
        reason: z
          .enum([
            "human_decision_changed",
            "conflict_changed",
            "source_changed",
            "source_deleted",
            "material_claim_changed",
          ])
          .nullable(),
        revision: z.number().int().positive(),
      }),
    )
    .max(50),
  nextAfterDependencyId: z.uuid().nullable(),
});
export type CrmEvidenceWorkBind = z.infer<typeof crmEvidenceWorkBindSchema>;
export type CrmEvidenceWorkRead = z.infer<typeof crmEvidenceWorkReadSchema>;

// Main-host command envelopes are never part of renderer payloads.
export const crmEvidenceDecidePayloadSchema = z.discriminatedUnion("action", [
  crmEvidenceDecideSchema.options[0].omit({
    commandId: true,
    clientVersion: true,
  }),
  crmEvidenceDecideSchema.options[1].omit({
    commandId: true,
    clientVersion: true,
  }),
]);
export const crmConflictResolvePayloadSchema = z.discriminatedUnion(
  "resolution",
  [
    crmConflictResolveSchema.options[0].omit({
      commandId: true,
      clientVersion: true,
    }),
    crmConflictResolveSchema.options[1].omit({
      commandId: true,
      clientVersion: true,
    }),
  ],
);
export const crmConflictSavePayloadSchema = z
  .strictObject({
    conflictId: crmConflictSaveSchema.shape.conflictId,
    expectedConflictRevision:
      crmConflictSaveSchema.shape.expectedConflictRevision,
    members: crmConflictSaveSchema.shape.members,
  })
  .refine(
    (value) =>
      new Set(value.members.map((member) => member.claimId)).size ===
      value.members.length,
    { message: "Conflict members must be distinct claims" },
  );
export const crmEvidenceWorkBindPayloadSchema = crmEvidenceWorkBindSchema.omit({
  commandId: true,
  clientVersion: true,
});
export const crmEvidenceDecidedSchema = z.strictObject({
  anchorId: z.uuid(),
  decisionRevision: z.number().int().positive(),
});
export const crmConflictSavedSchema = z.strictObject({
  conflictId: z.uuid(),
  revision: z.number().int().positive(),
});
export const crmEvidenceWorkBoundSchema = z.strictObject({
  dependencyId: z.uuid(),
  revision: z.number().int().positive(),
});

const sourceIdentity = {
  kind: crmSourceLookupSchema.shape.kind,
  sourceId: z.uuid(),
};
export const crmConflictListSchema = z.strictObject({
  ...sourceIdentity,
  afterId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const crmConflictListPageSchema = z.strictObject({
  conflicts: z
    .array(
      z.strictObject({
        conflictId: z.uuid(),
        revision: z.number().int().positive(),
        state: z.enum(["open", "resolved"]),
      }),
    )
    .max(50),
  nextAfterId: z.uuid().nullable(),
});

export const crmDecisionHistoryListSchema = z.strictObject({
  ...sourceIdentity,
  afterId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const crmDecisionHistoryListPageSchema = z.strictObject({
  anchors: z
    .array(
      z.strictObject({
        anchorId: z.uuid(),
        currentDecisionRevision: z.number().int().positive(),
        basis: z.enum(["available", "source_unavailable", "deleted_redacted"]),
      }),
    )
    .max(50),
  nextAfterId: z.uuid().nullable(),
});

export const crmEvidenceWorkListSchema = z.strictObject({
  ...sourceIdentity,
  after: crmEvidenceWorkIdentitySchema.optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const crmEvidenceWorkListPageSchema = z.strictObject({
  works: z
    .array(
      z.strictObject({
        work: crmEvidenceWorkIdentitySchema,
        version: z.string().min(1).max(40),
        status: z.enum(["open", "done", "cancelled"]),
        completedAt: z.iso.datetime().nullable(),
        dependencyCount: z.number().int().min(1).max(500),
        reviewRequired: z.boolean(),
      }),
    )
    .max(50),
  nextAfter: crmEvidenceWorkIdentitySchema.nullable(),
});
