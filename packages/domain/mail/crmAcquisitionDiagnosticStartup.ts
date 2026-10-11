import { createLocalDiagnosticIsolation } from "./crmAcquisitionDiagnosticLocal.ts";
import { z } from "zod";
import { REQUIRED_SCHEMA } from "../db/schemaRange.ts";
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
  const localConfiguration = z.strictObject({
    kind: z.literal("local"),
    environmentId: z.uuid(),
    runId: z.uuid(),
    databaseName: z.string().regex(/^fss_diagnostic_/u),
    databasePort: z.number().int().min(1024).max(65535),
    receiptPath: z.string().min(1),
    keyPath: z.string().min(1),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  });
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("diagnostic_configuration_invalid");
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    "kind" in candidate &&
    candidate.kind === "local"
  ) {
    const value = localConfiguration.parse(candidate);
    if (
      environment["FSS_ENVIRONMENT"] !== "diagnostic-local" ||
      environment["ECS_CONTAINER_METADATA_URI_V4"] ||
      !identity.implementationCommit ||
      !identity.imageDigest ||
      identity.schemaVersion !== REQUIRED_SCHEMA
    )
      throw new Error("diagnostic_local_forbidden");
    const database = new URL(identity.connectionString);
    if (
      database.hostname !== "127.0.0.1" ||
      Number(database.port) !== value.databasePort ||
      decodeURIComponent(database.pathname.slice(1)) !== value.databaseName ||
      database.username !== "app_runtime"
    )
      throw new Error("diagnostic_database_not_isolated");
    const localIsolation = {
      kind: "local" as const,
      runId: value.runId,
      databaseHost: "127.0.0.1" as const,
      databasePort: value.databasePort,
      databaseRole: "app_runtime" as const,
      receiptSha256: value.receiptSha256,
    };
    return {
      environmentId: value.environmentId,
      implementationCommit: identity.implementationCommit,
      imageDigest: identity.imageDigest,
      side: identity.side,
      schemaVersion: REQUIRED_SCHEMA,
      localIsolation,
      consentIsolationBinding: { localIsolation },
      verifyIsolation: createLocalDiagnosticIsolation({
        ...value,
        side: identity.side,
        artifactSha256: identity.imageDigest.replace(/^sha256:/u, ""),
      }),
    };
  }
  let value: z.infer<typeof configuration>;
  try {
    value = configuration.parse(JSON.parse(raw));
  } catch {
    throw new Error("diagnostic_configuration_invalid");
  }
  if (
    !identity.implementationCommit ||
    !identity.imageDigest ||
    identity.schemaVersion !== REQUIRED_SCHEMA ||
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
    schemaVersion: REQUIRED_SCHEMA,
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
