import { expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
const execute = promisify(execFile);
it.each(["normal", "orphan", "restricted_storage", "failed_cleanup"] as const)(
  "local acceptance runner cleans actual processes and copies after %s operation",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "callie-local-runner-"));
    await rm(directory, { recursive: true });
    const configuration = directory + ".config";
    let started = false;
    let restrictedStorage: string | undefined;
    const port = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("port_missing");
        server.close(() => done(address.port));
      });
    });
    const environment = {
      FSS_GOOGLE_HOSTED_DOMAIN: "usecallie.com",
      "google-gmail-oauth-client": JSON.stringify({
        client_id: "controlled-readonly.apps.googleusercontent.test",
        client_secret: randomBytes(24).toString("hex"),
      }),
      "google-oidc-client": JSON.stringify({
        client_id: "controlled-signin.apps.googleusercontent.test",
        client_secret: randomBytes(24).toString("hex"),
      }),
      "session-signing-key": randomBytes(48).toString("base64"),
    };
    await writeFile(
      configuration,
      JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        environment,
      }),
      { mode: 0o600 },
    );
    const runner = resolve("tools/upgrade/localDiagnostic.ts");
    try {
      await execute(process.execPath, [
        "--experimental-transform-types",
        runner,
        "start",
        directory,
        configuration,
      ]);
      started = true;
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* pending or absent */
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      if (!ready)
        console.error(await readFile(join(directory, "status.json"), "utf8"));
      expect(ready).toBe(true);
      const before = JSON.parse(
        await readFile(join(directory, "status.json"), "utf8"),
      );
      process.kill(before.workerPid, "SIGSTOP");
      try {
        const pausedWorker = await execute(process.execPath, [
          "--experimental-transform-types",
          runner,
          "verify",
          directory,
        ]);
        expect(JSON.parse(pausedWorker.stdout)).toMatchObject({
          state: "runtime_unknown",
          controllerFailure: "worker_unavailable",
        });
      } finally {
        process.kill(before.workerPid, "SIGCONT");
      }
      process.kill(before.supervisorPid, "SIGSTOP");
      try {
        const verification = await execute(process.execPath, [
          "--experimental-transform-types",
          runner,
          "verify",
          directory,
        ]);
        expect(JSON.parse(verification.stdout).state).toBe("runtime_unknown");
      } finally {
        process.kill(before.supervisorPid, "SIGCONT");
      }
      const address = Object.values(networkInterfaces())
        .flat()
        .find(
          (item) => item && !item.internal && item.family === "IPv4",
        )?.address;
      if (address) {
        const externallyOpen = await new Promise<boolean>((done) => {
          const socket = createConnection({ host: address, port });
          socket.once("connect", () => {
            socket.destroy();
            done(true);
          });
          socket.once("error", () => done(false));
          socket.setTimeout(1000, () => {
            socket.destroy();
            done(false);
          });
        });
        expect(externallyOpen).toBe(false);
      }
      if (mode === "orphan" || mode === "restricted_storage") {
        process.kill(before.supervisorPid, "SIGKILL");
        await new Promise((done) => setTimeout(done, 100));
        const deadController = await execute(process.execPath, [
          "--experimental-transform-types",
          runner,
          "verify",
          directory,
        ]);
        expect(JSON.parse(deadController.stdout).state).toBe("runtime_unknown");
      }
      if (mode === "restricted_storage") {
        const witness = JSON.parse(
          await readFile(join(directory, "cleanup-witness.json"), "utf8"),
        );
        restrictedStorage = witness.storagePath;
        await chmod(witness.storagePath, 0o000);
        const uncertain = await execute(process.execPath, [
          "--experimental-transform-types",
          runner,
          "cleanup",
          directory,
        ]);
        expect(JSON.parse(uncertain.stdout)).toMatchObject({
          state: "cleanup_unknown",
          databaseStorageAbsent: false,
          localCopiesAndKeysRemoved: false,
        });
        await expect(readFile(join(directory, "key"))).resolves.toHaveLength(
          32,
        );
      }
      if (mode === "failed_cleanup") {
        const witness = JSON.parse(
          await readFile(join(directory, "cleanup-witness.json"), "utf8"),
        );
        restrictedStorage = witness.storagePath;
        await chmod(witness.storagePath, 0o000);
        process.kill(before.workerPid, "SIGKILL");
        let failed: { state?: string; runFailure?: string } = {};
        for (let attempt = 0; attempt < 300; attempt++) {
          failed = JSON.parse(
            await readFile(join(directory, "status.json"), "utf8"),
          );
          if (failed.state === "cleanup_unknown") break;
          await new Promise((done) => setTimeout(done, 100));
        }
        expect(failed).toMatchObject({
          state: "cleanup_unknown",
          runFailure: "runtime_failed",
        });
      }
    } finally {
      if (restrictedStorage) await chmod(restrictedStorage, 0o700);
      if (started) {
        await execute(process.execPath, [
          "--experimental-transform-types",
          runner,
          "cleanup",
          directory,
        ]);
        for (let attempt = 0; attempt < 300; attempt++) {
          try {
            if (
              JSON.parse(await readFile(join(directory, "status.json"), "utf8"))
                .state === "cleaned"
            )
              break;
          } catch {
            /* pending or absent */
          }
          await new Promise((done) => setTimeout(done, 100));
        }
        expect(
          JSON.parse(await readFile(join(directory, "status.json"), "utf8"))
            .state,
        ).toBe("cleaned");
        if (mode === "failed_cleanup")
          expect(
            JSON.parse(await readFile(join(directory, "status.json"), "utf8")),
          ).toMatchObject({
            state: "cleaned",
            runFailure: "runtime_failed",
            recoveryFailure: null,
          });
        await expect(readFile(join(directory, "key"))).rejects.toThrow();
      }
      await rm(directory, { recursive: true, force: true });
      await rm(configuration, { force: true });
    }
  },
  60000,
);

it("records a durable body-free refusal when detached preparation has invalid configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "callie-local-invalid-"));
  await rm(directory, { recursive: true });
  const configuration = directory + ".config";
  await writeFile(
    configuration,
    JSON.stringify({
      origin: "https://production.example.test",
      implementationCommit: "0".repeat(40),
      environment: {},
    }),
    { mode: 0o600 },
  );
  try {
    await execute(process.execPath, [
      "--experimental-transform-types",
      resolve("tools/upgrade/localDiagnostic.ts"),
      "start",
      directory,
      configuration,
    ]);
    let status: { state?: string; runFailure?: string } = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        status = JSON.parse(
          await readFile(join(directory, "status.json"), "utf8"),
        );
        if (status.state === "preparation_failed") break;
      } catch {
        /* startup pending */
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(status).toMatchObject({
      state: "preparation_failed",
      runFailure: "configuration_refused",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(configuration, { force: true });
  }
}, 10000);
