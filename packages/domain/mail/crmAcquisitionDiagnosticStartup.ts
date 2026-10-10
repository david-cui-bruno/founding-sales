import { z } from "zod";
import { createCrmAcquisitionDiagnosticIsolation } from "./crmAcquisitionDiagnosticIsolation.ts";
import type { CrmAcquisitionDiagnosticRuntime } from "./crmAcquisitionDiagnostic.ts";
const configuration = z.strictObject({
  environmentId: z.uuid(),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/u),
  databaseSecretArn: z.string().regex(/^arn:aws:secretsmanager:/u),
  databaseInstanceArn: z.string().regex(/^arn:aws:rds:/u),
  ecsClusterArn: z.string().regex(/^arn:aws:ecs:/u),
});
/** Explicit independent environment mode. Configuration does not provision consent or authorize reads. */
export function createCrmAcquisitionDiagnosticStartup(
  environment: Record<string, string | undefined>,
  identity: {
    implementationCommit: string | null;
    imageDigest: string | null;
    side: "api" | "worker";
    schemaVersion: number;
    connectionString: string;
  },
): CrmAcquisitionDiagnosticRuntime | undefined {
  const raw = environment["FSS_CRM_ACQUISITION_DIAGNOSTIC"];
  if (!raw?.trim()) return undefined;
  let value: z.infer<typeof configuration>;
  try {
    value = configuration.parse(JSON.parse(raw));
  } catch {
    throw new Error("diagnostic_configuration_invalid");
  }
  if (
    !identity.implementationCommit ||
    !identity.imageDigest ||
    identity.schemaVersion !== 90 ||
    !environment["ECS_CONTAINER_METADATA_URI_V4"]
  )
    throw new Error("diagnostic_environment_unavailable");
  const database = new URL(identity.connectionString);
  if (
    !/^fss[_-]diagnostic[_-]/u.test(
      decodeURIComponent(database.pathname.slice(1)),
    )
  )
    throw new Error("diagnostic_database_not_isolated");
  return {
    environmentId: value.environmentId,
    implementationCommit: identity.implementationCommit,
    imageDigest: identity.imageDigest,
    side: identity.side,
    schemaVersion: 90,
    consentIsolationBinding: {
      databaseInstanceArn: value.databaseInstanceArn,
      databaseSecretArn: value.databaseSecretArn,
      databaseEndpoint: database.hostname,
      ecsClusterArn: value.ecsClusterArn,
    },
    verifyIsolation: createCrmAcquisitionDiagnosticIsolation({
      region: value.region,
      taskMetadataEndpoint: environment["ECS_CONTAINER_METADATA_URI_V4"],
      databaseSecretArn: value.databaseSecretArn,
      databaseHost: database.hostname,
      imageDigest: identity.imageDigest,
    }),
  };
}
