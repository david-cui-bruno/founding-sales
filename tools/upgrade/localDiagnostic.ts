/** Disposable local controller. No cloud authority, provider calls, consent or secrets printed. */
import {
  processIdentity,
  processIsResponsive,
  readLocalCleanupWitness,
  recordLocalCleanupWitness,
  recoverLocalDiagnostic,
} from "./localDiagnosticCleanup.ts";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  lstat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startPostgresCluster } from "../../packages/domain/db/testing/embeddedPostgres.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../packages/domain/db/migrationRunner.ts";
import { REQUIRED_SCHEMA } from "../../packages/domain/db/schemaRange.ts";
import {
  provisionCrmAcquisitionDiagnostic,
  revokeCrmAcquisitionDiagnostic,
} from "../../packages/domain/mail/crmAcquisitionDiagnostic.ts";
import { bootstrapWorkspace } from "../../apps/worker/src/tools/fss/bootstrapWorkspace.ts";
const output = (value: string) => process.stdout.write(value + "\n");
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const write = async (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });
const [command, rawDirectory, configurationPath] = process.argv.slice(2),
  directory = resolve(rawDirectory ?? "");
if (
  !rawDirectory ||
  ![
    "start",
    "serve",
    "status",
    "verify",
    "cleanup",
    "provision",
    "revoke",
  ].includes(command ?? "")
)
  throw new Error(
    "usage: localDiagnostic start|status|verify|cleanup <private-run-directory> [private-configuration]",
  );
if (command === "start") {
  if (!configurationPath) throw new Error("diagnostic_configuration_required");
  await mkdir(directory, { mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      fileURLToPath(import.meta.url),
      "serve",
      directory,
      resolve(configurationPath),
    ],
    { detached: true, stdio: "ignore", env: { PATH: process.env["PATH"] } },
  );
  child.unref();
  output(
    JSON.stringify({ state: "starting", directory, supervisorPid: child.pid }),
  );
} else if (command === "provision" || command === "revoke") {
  if (!configurationPath) throw new Error("diagnostic_document_required");
  const request = JSON.parse(await readFile(configurationPath, "utf8"));
  await write(join(directory, `${command}.request`), request);
  output(JSON.stringify({ state: `${command}_requested` }));
} else if (command === "cleanup") {
  const status = JSON.parse(
    await readFile(join(directory, "status.json"), "utf8"),
  );
  if (status.state === "cleaned") output(JSON.stringify(status));
  else {
    let responsive = false;
    try {
      responsive = processIsResponsive(
        (await readLocalCleanupWitness(directory)).supervisor,
      );
    } catch {
      /* unavailable */
    }
    if (!responsive) {
      output(JSON.stringify(await recoverLocalDiagnostic(directory)));
      process.exit(0);
    }
    await writeFile(join(directory, "cleanup.request"), "cleanup", {
      mode: 0o600,
    });
    output(JSON.stringify({ state: "cleanup_requested" }));
  }
} else if (command === "status" || command === "verify") {
  const status = JSON.parse(
    await readFile(join(directory, "status.json"), "utf8"),
  );
  if (
    (command === "verify" || command === "status") &&
    status.state === "running"
  ) {
    let controllerFailure: string | null = "process_witness_unavailable";
    try {
      const witness = await readLocalCleanupWitness(directory);
      controllerFailure =
        !processIsResponsive(witness.supervisor) ||
        status.supervisorPid !== witness.supervisor.pid
          ? "supervisor_unavailable"
          : !processIsResponsive(witness.api) ||
              status.apiPid !== witness.api.pid
            ? "api_unavailable"
            : !processIsResponsive(witness.worker) ||
                status.workerPid !== witness.worker.pid
              ? "worker_unavailable"
              : null;
    } catch {
      /* absent, stopped or reused identity refuses */
    }
    if (controllerFailure) {
      status.state = "runtime_unknown";
      status.controllerFailure = controllerFailure;
      await write(join(directory, "status.json"), status);
    }
  }
  if (command === "verify" && status.state === "running") {
    const result = await fetch(`${status.origin}/readyz`, {
      signal: AbortSignal.timeout(5000),
    });
    status.apiHealthy = result.ok;
  }
  output(JSON.stringify(status));
} else {
  try {
    if (!configurationPath)
      throw new Error("diagnostic_configuration_required");
    // Configuration is owner-supplied dedicated project clients, never an installed desktop credential.
    const file = await lstat(configurationPath);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      (file.mode & 0o777) !== 0o600 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw new Error("diagnostic_configuration_private_required");
    const config = JSON.parse(await readFile(configurationPath, "utf8"));
    if (
      config.implementationCommit !==
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    )
      throw new Error("diagnostic_source_mismatch");
    const origin = new URL(config.origin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("diagnostic_loopback_required");
    const environment: Record<string, string> = {
      ...config.environment,
      FSS_PUBLIC_ORIGIN: origin.origin,
      FSS_ENVIRONMENT: "diagnostic-local",
      FSS_DEPENDENCIES: "live",
      FSS_SENDING_ENABLED: "false",
    };
    if (
      environment["ECS_CONTAINER_METADATA_URI_V4"] ||
      environment["FSS_CRM_CAPABILITIES"]
    )
      throw new Error("diagnostic_external_runtime_forbidden");
    const runId = randomUUID(),
      environmentId = randomUUID(),
      databaseName = `fss_diagnostic_${runId.replaceAll("-", "")}`,
      keyPath = join(directory, "key");
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    await write(join(directory, "status.json"), {
      state: "preparing",
      supervisorPid: process.pid,
      runId,
    });
    let api: ChildProcess | undefined, worker: ChildProcess | undefined;
    let cluster: Awaited<ReturnType<typeof startPostgresCluster>> | undefined,
      session: pg.Client | undefined;
    let stage = "cluster_start";
    let cleanup = false,
      runFailure: string | null = null;
    let apiExit: number | null = null,
      workerExit: number | null = null;
    let apiEvent: string | null = null,
      workerEvent: string | null = null;
    process.once("SIGTERM", () => {
      cleanup = true;
    });
    process.once("SIGINT", () => {
      cleanup = true;
    });
    try {
      cluster = await startPostgresCluster();
      if (cluster.source !== "embedded")
        throw new Error("diagnostic_fresh_cluster_required");
      const admin = new pg.Client({ connectionString: cluster.adminUrl });
      await admin.connect();
      await admin.query(
        `CREATE DATABASE ${databaseName} ENCODING 'UTF8' TEMPLATE template0`,
      );
      await admin.end();
      const url = new URL(cluster.adminUrl);
      url.pathname = `/${databaseName}`;
      session = new pg.Client({ connectionString: url.href });
      await session.connect();
      stage = "migration";
      await applyMigrations(session, { migrations: loadMigrations() });
      stage = "runtime_role";
      const password = randomBytes(24).toString("hex");
      await session.query(
        `ALTER ROLE app_runtime LOGIN PASSWORD '${password}'`,
      );
      stage = "workspace_bootstrap";
      const bootstrap = await bootstrapWorkspace(session, {
        slug: "diagnostic-local",
        displayName: "Local acquisition acceptance",
        adminEmail: "david@usecallie.com",
      });
      if (!bootstrap.ok) throw new Error("diagnostic_bootstrap_refused");
      url.username = "app_runtime";
      url.password = password;
      stage = "artifact_binding";
      const apiArtifactPath = join(directory, "api-artifact.json"),
        workerArtifactPath = join(directory, "worker-artifact.json");
      const paths = execFileSync(
        "git",
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "apps",
          "packages",
          "tools/upgrade",
          "package-lock.json",
          "package.json",
          "tsconfig.base.json",
        ],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean)
        .filter((path, index, paths) => paths.indexOf(path) === index);
      const files = await Promise.all(
        paths.map(async (path) => ({
          path: resolve(path),
          sha256: hash(await readFile(path)),
        })),
      );
      const artifact = {
        implementationCommit: config.implementationCommit,
        schemaVersion: REQUIRED_SCHEMA,
        files,
      };
      await write(apiArtifactPath, artifact);
      await write(workerArtifactPath, artifact);
      const apiArtifactSha256 = hash(await readFile(apiArtifactPath)),
        workerArtifactSha256 = hash(await readFile(workerArtifactPath));
      stage = "launch";
      const launcher = fileURLToPath(
        new URL("./localDiagnosticProcess.ts", import.meta.url),
      );
      api = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          launcher,
          "api",
          join(directory, "api-launch.json"),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env["PATH"] },
        },
      );
      worker = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          launcher,
          "worker",
          join(directory, "worker-launch.json"),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env["PATH"] },
        },
      );
      for (const [side, child] of [
        ["api", api],
        ["worker", worker],
      ] as const) {
        child.on("exit", (code) => {
          if (side === "api") apiExit = code;
          else workerExit = code;
        });
        child.stdout?.on("data", (bytes) => {
          for (const line of String(bytes).split("\n")) {
            try {
              const log = JSON.parse(line);
              if (
                typeof log.event === "string" &&
                /^[a-z_]+$/u.test(log.event)
              ) {
                if (side === "api") apiEvent = log.event;
                else workerEvent = log.event;
              }
            } catch {
              /* pending or absent */
            }
          }
        });
      }
      if (!api.pid || !worker.pid) throw new Error("diagnostic_spawn_failed");
      const receiptPath = join(directory, "runtime-receipt.json");
      await write(receiptPath, {
        kind: "local",
        runId,
        environmentId,
        databaseName,
        databasePort: Number(url.port),
        apiPid: api.pid,
        workerPid: worker.pid,
        keyPath,
        keySha256: hash(await readFile(keyPath)),
        apiArtifactPath,
        workerArtifactPath,
        apiArtifactSha256,
        workerArtifactSha256,
        state: "running",
      });
      const diagnostic = {
        kind: "local",
        environmentId,
        runId,
        databaseName,
        databasePort: Number(url.port),
        receiptPath,
        keyPath,
        receiptSha256: hash(await readFile(receiptPath)),
      };
      const common = {
        ...environment,
        DATABASE_URL: url.href,
        FSS_BUILD_COMMIT: config.implementationCommit,
        FSS_SCHEMA_MIN: String(REQUIRED_SCHEMA),
        FSS_SCHEMA_MAX: String(REQUIRED_SCHEMA),
        FSS_CRM_LOCAL_KEY_PATH: keyPath,
        FSS_CRM_LOCAL_JOURNAL_PATH: join(directory, "journal"),
        FSS_CRM_LOCAL_RUN_ID: runId,
        FSS_CRM_ACQUISITION_DIAGNOSTIC: JSON.stringify(diagnostic),
      };
      await write(join(directory, "api-launch.json"), {
        ...common,
        FSS_ROLE: "api",
        PORT: origin.port,
        FSS_IMAGE_DIGEST: `sha256:${apiArtifactSha256}`,
      });
      await write(join(directory, "worker-launch.json"), {
        ...common,
        FSS_ROLE: "worker",
        FSS_IMAGE_DIGEST: `sha256:${workerArtifactSha256}`,
      });
      if (!cluster.storagePath) throw new Error("diagnostic_storage_missing");
      const supervisorIdentity = processIdentity(process.pid),
        apiIdentity = processIdentity(api.pid),
        workerIdentity = processIdentity(worker.pid);
      if (!supervisorIdentity || !apiIdentity || !workerIdentity)
        throw new Error("diagnostic_process_identity_unavailable");
      await recordLocalCleanupWitness(directory, {
        supervisor: supervisorIdentity,
        api: apiIdentity,
        worker: workerIdentity,
        storagePath: cluster.storagePath,
        runId,
      });
      await write(join(directory, "status.json"), {
        state: "running",
        runId,
        supervisorPid: process.pid,
        apiPid: api.pid,
        workerPid: worker.pid,
        origin: origin.origin,
        environmentId,
        workspaceId: bootstrap.value.workspace.id,
        ownerUserId: bootstrap.value.admin.userId,
        schemaVersion: REQUIRED_SCHEMA,
        artifactKind: "local_source_manifest",
        implementationCommit: config.implementationCommit,
        apiArtifactSha256,
        workerArtifactSha256,
        databaseName,
        databasePort: Number(url.port),
        receiptSha256: diagnostic.receiptSha256,
        productionActivationAllowed: false,
        transport: "not_started",
      });
      while (!cleanup) {
        for (const operation of ["provision", "revoke"]) {
          const requestPath = join(directory, `${operation}.request`);
          try {
            await access(requestPath);
          } catch {
            continue;
          }
          try {
            const document = JSON.parse(await readFile(requestPath, "utf8"));
            let result;
            if (operation === "provision") {
              if (
                !document.localIsolation ||
                document.localIsolation.runId !== runId ||
                document.localIsolation.receiptSha256 !==
                  diagnostic.receiptSha256 ||
                document.environmentId !== environmentId ||
                document.apiImageDigest !== `sha256:${apiArtifactSha256}` ||
                document.workerImageDigest !== `sha256:${workerArtifactSha256}`
              )
                throw new Error("diagnostic_local_binding_mismatch");
              result = await provisionCrmAcquisitionDiagnostic(
                session,
                document,
              );
            } else
              result = await revokeCrmAcquisitionDiagnostic(session, document);
            await write(join(directory, `${operation}.result.json`), result);
          } catch {
            await write(join(directory, `${operation}.result.json`), {
              ok: false,
              reason: "diagnostic_operation_refused",
            });
          }
          await rm(requestPath);
        }
        try {
          await access(join(directory, "cleanup.request"));
          cleanup = true;
        } catch {
          /* pending or absent */
        }
        if (
          api.exitCode !== null ||
          api.signalCode !== null ||
          worker.exitCode !== null ||
          worker.signalCode !== null
        ) {
          runFailure = "runtime_failed";
          await write(join(directory, "status.json"), {
            state: "runtime_failed",
            runId,
            apiExit,
            workerExit,
            apiEvent,
            workerEvent,
          });
          cleanup = true;
        }
        if (!cleanup) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch {
      runFailure = `preparation_failed:${stage}`;
    } finally {
      let processesAbsent = true;
      for (const child of [api, worker])
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await Promise.race([
            new Promise<void>((done) => child!.once("exit", () => done())),
            new Promise<void>((done) => setTimeout(done, 22000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await Promise.race([
              new Promise<void>((done) => child.once("exit", () => done())),
              new Promise<void>((done) => setTimeout(done, 5000)),
            ]);
          }
          if (child.exitCode === null && child.signalCode === null)
            processesAbsent = false;
        }
      let databaseStorageAbsent = false;
      try {
        await session?.end();
        await cluster?.stop();
        if (cluster?.storagePath) {
          try {
            await access(cluster.storagePath);
          } catch (error) {
            databaseStorageAbsent =
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT";
          }
        }
      } catch {
        /* preserve unknown cleanup */
      }
      let localCopiesAndKeysRemoved = false;
      try {
        if (processesAbsent && databaseStorageAbsent) {
          for (const name of [
            "key",
            "api-launch.json",
            "worker-launch.json",
            "api-artifact.json",
            "worker-artifact.json",
            "runtime-receipt.json",
            "cleanup.request",
            "provision.request",
            "revoke.request",
          ])
            await rm(join(directory, name), { force: true });
          await rm(join(directory, "journal"), {
            recursive: true,
            force: true,
          });
          await rm(join(directory, "cleanup-witness.json"), { force: true });
          localCopiesAndKeysRemoved = true;
        }
      } catch {
        /* retain uncertain cleanup evidence */
      }
      await write(join(directory, "status.json"), {
        state:
          processesAbsent && databaseStorageAbsent && localCopiesAndKeysRemoved
            ? "cleaned"
            : "cleanup_unknown",
        runId,
        runFailure,
        apiExit,
        workerExit,
        apiEvent,
        workerEvent,
        processesAbsent,
        databaseStorageAbsent,
        localCopiesAndKeysRemoved,
        googleRevocation: "not_attested",
        productionActivationAllowed: false,
      });
      // Failed teardown can leave PostgreSQL child handles alive. Retain the
      // private witness, exit this controller, and allow explicit recovery.
      if (!(
        processesAbsent &&
        databaseStorageAbsent &&
        localCopiesAndKeysRemoved
      ))
        process.exit(1);
    }
  } catch {
    await write(join(directory, "status.json"), {
      state: "preparation_failed",
      runFailure: "configuration_refused",
      productionActivationAllowed: false,
      googleRevocation: "not_attested",
    });
  }
}
