import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLocalDiagnosticCipher } from "../mail/crmAcquisitionDiagnosticLocal.ts";
it("independent local API and worker compositions share authenticated envelopes, and refuse public keys or production", async () => {
  const directory = await mkdtemp(join(tmpdir(), "callie-local-key-"));
  const keyPath = join(directory, "key");
  try {
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    const environment = {
      FSS_ENVIRONMENT: "diagnostic-local",
      FSS_CRM_LOCAL_KEY_PATH: keyPath,
      FSS_CRM_LOCAL_RUN_ID: "00000000-0000-4000-8000-000000000001",
      FSS_CRM_ACQUISITION_DIAGNOSTIC: JSON.stringify({
        kind: "local",
        runId: "00000000-0000-4000-8000-000000000001",
        keyPath,
      }),
    };
    const api = await createLocalDiagnosticCipher(environment),
      worker = await createLocalDiagnosticCipher(environment);
    expect(
      await worker.decrypt(await api.encrypt("private-refresh-token")),
    ).toBe("private-refresh-token");
    await expect(
      createLocalDiagnosticCipher({
        ...environment,
        FSS_ENVIRONMENT: "production",
      }),
    ).rejects.toThrow("diagnostic_local_forbidden");
    await writeFile(join(directory, "public"), randomBytes(32), {
      mode: 0o644,
    });
    await expect(
      createLocalDiagnosticCipher({
        ...environment,
        FSS_CRM_LOCAL_KEY_PATH: join(directory, "public"),
        FSS_CRM_ACQUISITION_DIAGNOSTIC: JSON.stringify({
          kind: "local",
          runId: "00000000-0000-4000-8000-000000000001",
          keyPath: join(directory, "public"),
        }),
      }),
    ).rejects.toThrow("diagnostic_key_invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
it("separate API and worker processes decrypt the same run token across an ordinary restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "callie-key-process-")),
    keyPath = join(directory, "key");
  try {
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    const environment = {
      PATH: process.env["PATH"],
      FSS_ENVIRONMENT: "diagnostic-local",
      FSS_CRM_LOCAL_KEY_PATH: keyPath,
      FSS_CRM_LOCAL_RUN_ID: "00000000-0000-4000-8000-000000000001",
      FSS_CRM_ACQUISITION_DIAGNOSTIC: JSON.stringify({
        kind: "local",
        runId: "00000000-0000-4000-8000-000000000001",
        keyPath,
      }),
    };
    const modulePath = fileURLToPath(
      new URL("../mail/crmAcquisitionDiagnosticLocal.ts", import.meta.url),
    );
    const imported = `import {createLocalDiagnosticCipher} from ${JSON.stringify(modulePath)}; const cipher=await createLocalDiagnosticCipher(process.env);`;
    const encrypted = await execute(
      process.execPath,
      [
        "--experimental-transform-types",
        "--input-type=module",
        "--eval",
        imported +
          `const envelope=await cipher.encrypt('synthetic-refresh-token');process.stdout.write(JSON.stringify(envelope));`,
      ],
      { env: environment },
    );
    const worker =
      imported +
      `const envelope=JSON.parse(process.env.CONTROLLED_ENVELOPE);for(const key of ['wrappedDataKey','ciphertext','iv','authTag']) envelope[key]=Buffer.from(envelope[key].data);process.stdout.write(await cipher.decrypt(envelope));`;
    for (let restart = 0; restart < 2; restart++)
      expect(
        (
          await execute(
            process.execPath,
            [
              "--experimental-transform-types",
              "--input-type=module",
              "--eval",
              worker,
            ],
            { env: { ...environment, CONTROLLED_ENVELOPE: encrypted.stdout } },
          )
        ).stdout,
      ).toBe("synthetic-refresh-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
