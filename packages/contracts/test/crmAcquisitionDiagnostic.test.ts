import { expect, it } from "vitest";
import { crmAcquisitionDiagnosticAuthorizationSchema } from "../src/crmAcquisitionDiagnostic.ts";
const id = "00000000-0000-4000-8000-000000000001";
const authorization = {
  id,
  purpose: "acquisition_acceptance",
  workspaceId: id,
  mailboxId: id,
  ownerUserId: id,
  providerAccountId: "business@example.test",
  accountBinding: "a".repeat(64),
  generation: 1,
  oauthGrantObservationId: id,
  databaseInstanceArn: "test-instance",
  databaseSecretArn: "test-secret",
  databaseEndpoint: "test.invalid",
  ecsClusterArn: "test-cluster",
  deploymentIdentity: "test-api",
  workerDeploymentIdentity: "test-worker",
  environmentId: id,
  databaseName: "fss_diagnostic_test",
  implementationCommit: "a".repeat(40),
  apiImageDigest: "sha256:" + "a".repeat(64),
  workerImageDigest: "sha256:" + "b".repeat(64),
  schemaVersion: 99,
  releaseReference: "test-release",
  disclosureVersion: "test-disclosure",
  disclosureSha256: "a".repeat(64),
  consentReference: "test-consent",
  providerPolicyReference: "test-policy",
  reviewedBy: id,
  reviewReference: "test-review",
  verifiedAt: "2026-10-11T00:00:00Z",
  validUntil: "2026-10-11T01:00:00Z",
  maxReads: 8,
  maxUnits: 160,
  metadataUnits: 20,
  bodyUnits: 20,
  messages: [
    {
      messageId: "test-message",
      threadId: "test-thread",
      origin: "received",
      fromAt: "2026-10-01T00:00:00Z",
      toAt: "2026-10-11T00:00:00Z",
    },
  ],
};
it("supports a versioned diagnostic document without weakening the read and quota bounds", () => {
  expect(
    crmAcquisitionDiagnosticAuthorizationSchema.parse(authorization)
      .schemaVersion,
  ).toBe(99);
  for (const change of [
    { schemaVersion: 89 },
    { schemaVersion: 99.5 },
    { schemaVersion: 0 },
    { maxReads: 9 },
    { maxUnits: 161 },
    { metadataUnits: 5 },
    { bodyUnits: 5 },
  ])
    expect(
      crmAcquisitionDiagnosticAuthorizationSchema.safeParse({
        ...authorization,
        ...change,
      }).success,
    ).toBe(false);
  expect(
    crmAcquisitionDiagnosticAuthorizationSchema.parse({
      ...authorization,
      schemaVersion: 90,
    }).schemaVersion,
  ).toBe(90);
});
