import { z } from "zod";
/** Gmail method costs published for the quota schedule updated 2026-05-01.
 * These are reserved method units, not measured project-wide headroom. */
export const CRM_DIAGNOSTIC_QUOTA_SCHEDULE = Object.freeze({
  version: "gmail-2026-05-01",
  profile: 1,
  metadata: 20,
  body: 20,
});
const hash = z.string().regex(/^[a-f0-9]{64}$/u),
  reference = z.string().min(1).max(200);
export const crmAcquisitionDiagnosticAuthorizationSchema = z
  .strictObject({
    id: z.uuid(),
    purpose: z.literal("acquisition_acceptance"),
    workspaceId: z.uuid(),
    mailboxId: z.uuid(),
    ownerUserId: z.uuid(),
    providerAccountId: z.string().min(1).max(320),
    accountBinding: hash,
    generation: z.number().int().positive(),
    oauthGrantObservationId: z.uuid(),
    databaseInstanceArn: reference,
    databaseSecretArn: reference,
    databaseEndpoint: reference,
    ecsClusterArn: reference,
    deploymentIdentity: reference,
    workerDeploymentIdentity: reference,
    environmentId: z.uuid(),
    databaseName: reference,
    implementationCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    apiImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    schemaVersion: z.literal(90),
    releaseReference: reference,
    disclosureVersion: reference,
    disclosureSha256: hash,
    consentReference: reference,
    providerPolicyReference: reference,
    reviewedBy: z.uuid(),
    reviewReference: reference,
    verifiedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    maxReads: z.number().int().min(1).max(8),
    maxUnits: z.number().int().min(1).max(160),
    metadataUnits: z.literal(20),
    bodyUnits: z.literal(20),
    messages: z
      .array(
        z.strictObject({
          messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
          threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
          origin: z.enum(["received", "sent"]),
          fromAt: z.iso.datetime(),
          toAt: z.iso.datetime(),
        }),
      )
      .min(1)
      .max(4),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.verifiedAt))
      context.addIssue({ code: "custom", message: "invalid expiry" });
    if (
      new Set(value.messages.map((m) => m.messageId)).size !==
      value.messages.length
    )
      context.addIssue({ code: "custom", message: "duplicate message" });
    if (value.messages.some((m) => Date.parse(m.fromAt) > Date.parse(m.toAt)))
      context.addIssue({ code: "custom", message: "invalid scope" });
  });
export type CrmAcquisitionDiagnosticAuthorization = z.infer<
  typeof crmAcquisitionDiagnosticAuthorizationSchema
>;
export const crmAcquisitionDiagnosticRequestSchema = z.strictObject({
  commandId: z.uuid(),
  clientVersion: z.string().min(1).max(100),
  authorizationId: z.uuid(),
  expectedAuthorizationSha256: hash,
});
export const crmAcquisitionDiagnosticReadSchema = z.strictObject({
  authorizationId: z.uuid(),
});
export const crmAcquisitionDiagnosticRequestResultSchema = z.strictObject({
  authorizationId: z.uuid(),
  status: z.literal("queued"),
  productionActivationAllowed: z.literal(false),
});
export const crmAcquisitionDiagnosticReadResultSchema = z.strictObject({
  authorizationId: z.uuid(),
  purpose: z.literal("acquisition_acceptance"),
  transport: z.enum(["not_started", "controlled", "actual_transport", "mixed"]),
  authorizationSha256: hash,
  releaseReference: reference,
  coverage: z.literal("explicit_scoped_partial"),
  outcomes: z.array(z.string().max(100)),
  authorizedMessages: z.number().int().nonnegative(),
  attemptedReads: z.number().int().nonnegative(),
  observedUnits: z.number().int().nonnegative(),
  conservedUnits: z.number().int().nonnegative(),
  releasedUnits: z.number().int().nonnegative(),
  accountingProvenance: z.enum([
    "not_started",
    "documented_current_schedule",
    "legacy_recorded_unverified",
    "mixed",
  ]),
  accountingBuckets: z.array(
    z.strictObject({
      scheduleVersion: z.enum([
        "gmail-2026-05-01",
        "legacy-v89-recorded-unverified",
      ]),
      attemptedReads: z.number().int().nonnegative(),
      observedUnits: z.number().int().nonnegative(),
      conservedUnits: z.number().int().nonnegative(),
    }),
  ),
  copies: z.array(
    z.strictObject({
      sourceId: z.uuid(),
      sourceRevision: z.number().int().positive(),
      availability: z.enum(["available", "deleted", "awaiting_recapture"]),
    }),
  ),
  productionActivationAllowed: z.literal(false),
});
