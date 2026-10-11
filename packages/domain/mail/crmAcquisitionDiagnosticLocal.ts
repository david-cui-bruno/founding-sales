import type { GoogleClientBundle } from "../release/deployment.ts";
import type { MailPublicConfig } from "./config.ts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { envelopeCipher, type EnvelopeCipher } from "./envelope.ts";
/** Run-owned file, never a fixture key. Both actual processes reopen the same private key. */
export async function createLocalDiagnosticCipher(
  environment: Record<string, string | undefined>,
): Promise<EnvelopeCipher> {
  if (
    environment["FSS_ENVIRONMENT"] !== "diagnostic-local" ||
    environment["ECS_CONTAINER_METADATA_URI_V4"]
  )
    throw new Error("diagnostic_local_forbidden");
  const path = environment["FSS_CRM_LOCAL_KEY_PATH"],
    runId = environment["FSS_CRM_LOCAL_RUN_ID"];
  if (!path || !runId || !/^[a-f0-9-]{36}$/u.test(runId))
    throw new Error("diagnostic_key_invalid");
  let diagnostic: unknown;
  try {
    diagnostic = JSON.parse(
      environment["FSS_CRM_ACQUISITION_DIAGNOSTIC"] ?? "",
    );
  } catch {
    throw new Error("diagnostic_local_forbidden");
  }
  if (
    !diagnostic ||
    typeof diagnostic !== "object" ||
    !("kind" in diagnostic) ||
    diagnostic.kind !== "local" ||
    !("runId" in diagnostic) ||
    diagnostic.runId !== runId ||
    !("keyPath" in diagnostic) ||
    diagnostic.keyPath !== path
  )
    throw new Error("diagnostic_local_forbidden");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("diagnostic_key_invalid");
  const master = await readFile(path);
  if (master.length !== 32) throw new Error("diagnostic_key_invalid");
  return envelopeCipher({
    keyId: `diagnostic-local:${runId}`,
    async generateDataKey() {
      const plaintext = randomBytes(32),
        iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", master, iv);
      return {
        plaintext,
        wrapped: Buffer.concat([
          iv,
          cipher.update(plaintext),
          cipher.final(),
          cipher.getAuthTag(),
        ]),
      };
    },
    async unwrapDataKey(wrapped) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        master,
        wrapped.subarray(0, 12),
      );
      decipher.setAuthTag(wrapped.subarray(-16));
      return Buffer.concat([
        decipher.update(wrapped.subarray(12, -16)),
        decipher.final(),
      ]);
    },
  });
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrmAcquisitionDiagnosticRuntime } from "./crmAcquisitionDiagnostic.ts";
const receiptSchema = z.strictObject({
  kind: z.literal("local"),
  runId: z.uuid(),
  environmentId: z.uuid(),
  databaseName: z.string().regex(/^fss_diagnostic_/u),
  databasePort: z.number().int(),
  apiPid: z.number().int().positive(),
  workerPid: z.number().int().positive(),
  keyPath: z.string(),
  keySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  apiArtifactPath: z.string(),
  workerArtifactPath: z.string(),
  apiArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workerArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.literal("running"),
});
export function createLocalDiagnosticIsolation(options: {
  receiptPath: string;
  keyPath: string;
  side: "api" | "worker";
  artifactSha256: string;
  runId: string;
  environmentId: string;
  databaseName: string;
  databasePort: number;
}): CrmAcquisitionDiagnosticRuntime["verifyIsolation"] {
  return async (binding) => {
    try {
      if (
        !binding.localIsolation ||
        binding.localIsolation.runId !== options.runId ||
        binding.environmentId !== options.environmentId ||
        binding.databaseName !== options.databaseName ||
        binding.localIsolation.databasePort !== options.databasePort ||
        binding.connectedServerAddress !== "127.0.0.1" ||
        binding.connectedServerPort !== options.databasePort ||
        binding.connectedRole !== "app_runtime"
      )
        return false;
      const stat = await lstat(options.receiptPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        return false;
      const bytes = await readFile(options.receiptPath);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        binding.localIsolation.receiptSha256
      )
        return false;
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (
        receipt.runId !== options.runId ||
        receipt.environmentId !== options.environmentId ||
        receipt.databaseName !== options.databaseName ||
        receipt.databasePort !== options.databasePort ||
        receipt.keyPath !== options.keyPath
      )
        return false;
      if (
        (options.side === "api" ? receipt.apiPid : receipt.workerPid) !==
        process.pid
      )
        return false;
      if (
        binding.purpose !== "oauth_bootstrap" &&
        binding.deploymentIdentity !== `local-process:${process.pid}`
      )
        return false;
      for (const pid of [receipt.apiPid, receipt.workerPid])
        process.kill(pid, 0);
      const key = await lstat(receipt.keyPath);
      if (
        !key.isFile() ||
        key.isSymbolicLink() ||
        (key.mode & 0o777) !== 0o600 ||
        (process.getuid && key.uid !== process.getuid()) ||
        (await readFile(receipt.keyPath)).length !== 32 ||
        createHash("sha256")
          .update(await readFile(receipt.keyPath))
          .digest("hex") !== receipt.keySha256
      )
        return false;
      const artifact =
        options.side === "api"
          ? receipt.apiArtifactPath
          : receipt.workerArtifactPath;
      const artifactBytes = await readFile(artifact);
      const manifest = z
        .strictObject({
          implementationCommit: z.string().regex(/^[a-f0-9]{40}$/u),
          schemaVersion: z.number().int(),
          files: z
            .array(
              z.strictObject({
                path: z.string(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              }),
            )
            .min(1),
        })
        .parse(JSON.parse(artifactBytes.toString("utf8")));
      for (const file of manifest.files) {
        const source = await lstat(file.path);
        if (
          !source.isFile() ||
          source.isSymbolicLink() ||
          createHash("sha256")
            .update(await readFile(file.path))
            .digest("hex") !== file.sha256
        )
          return false;
      }
      const digest = createHash("sha256").update(artifactBytes).digest("hex");
      return (
        digest === options.artifactSha256 &&
        digest ===
          (options.side === "api"
            ? receipt.apiArtifactSha256
            : receipt.workerArtifactSha256)
      );
    } catch {
      return false;
    }
  };
}

import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  journalObjectBody,
  journalObjectKey,
  type SuppressionJournal,
} from "../suppression/journal.ts";
/** Local durable audit; it never labels a filesystem write as S3 Object Lock. */
export async function createLocalDiagnosticJournal(
  environment: Record<string, string | undefined>,
): Promise<SuppressionJournal> {
  if (
    environment["FSS_ENVIRONMENT"] !== "diagnostic-local" ||
    environment["ECS_CONTAINER_METADATA_URI_V4"]
  )
    throw new Error("diagnostic_local_forbidden");
  const directory = environment["FSS_CRM_LOCAL_JOURNAL_PATH"];
  if (!directory) throw new Error("diagnostic_local_journal_missing");
  await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("diagnostic_local_journal_invalid");
  return {
    async append(record) {
      const name = createHash("sha256")
        .update(journalObjectKey(record))
        .digest("hex");
      let file;
      try {
        file = await open(join(directory, name), "wx", 0o600);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return;
        throw new Error("diagnostic_local_journal_unavailable");
      }
      try {
        await file.writeFile(journalObjectBody(record));
        await file.sync();
      } finally {
        await file.close();
      }
    },
  };
}

/** Capture-only local acceptance has no Pub/Sub/watch lane or invented cloud identifiers. */
export function readLocalDiagnosticMailPublicConfig(
  bundle: GoogleClientBundle,
  environment: Record<string, string | undefined>,
) {
  if (
    environment["FSS_ENVIRONMENT"] !== "diagnostic-local" ||
    !environment["FSS_CRM_LOCAL_RUN_ID"] ||
    environment["ECS_CONTAINER_METADATA_URI_V4"]
  )
    throw new Error("diagnostic_local_forbidden");
  const origin = environment["FSS_PUBLIC_ORIGIN"],
    hosted =
      environment["FSS_GOOGLE_HOSTED_DOMAIN"]?.trim() || bundle.hostedDomain;
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) || !hosted)
    throw new Error("diagnostic_local_configuration_invalid");
  const config: MailPublicConfig = {
    clientId: bundle.clientId,
    redirectUri: origin + "/oauth/gmail/callback",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    apiBaseUrl: "https://gmail.googleapis.com",
    pushTopicName: "",
    pushAudience: "",
    pushServiceAccountEmail: "",
    hostedDomain: hosted,
    baselineDays: 0,
  };
  return {
    config,
    pushTopicSource: "absent" as const,
    hostedDomainSource: environment["FSS_GOOGLE_HOSTED_DOMAIN"]?.trim()
      ? ("environment" as const)
      : ("secret" as const),
  };
}
