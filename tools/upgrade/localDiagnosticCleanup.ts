/** Recovery only for the private diagnostic process identities witnessed at launch. */
import { execFileSync } from "node:child_process";
import { access, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
export interface LocalProcessIdentity {
  pid: number;
  uid: number;
  started: string;
  command: string;
}
export function processIdentity(pid: number): LocalProcessIdentity | null {
  try {
    const text = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const match = /^(\d+)\s+(.{24})\s+(.+)$/u.exec(text);
    if (!match) return null;
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (state.startsWith("Z")) return null;
    return {
      pid,
      uid: Number(match[1]),
      started: match[2]!,
      command: match[3]!,
    };
  } catch {
    return null;
  }
}
export function processIdentityMatches(identity: LocalProcessIdentity) {
  const actual = processIdentity(identity.pid);
  return (
    actual !== null &&
    JSON.stringify(actual) === JSON.stringify(identity) &&
    actual.uid === process.getuid?.()
  );
}
export function processIsResponsive(identity: LocalProcessIdentity) {
  if (!processIdentityMatches(identity)) return false;
  try {
    return !execFileSync("ps", ["-p", String(identity.pid), "-o", "stat="], {
      encoding: "utf8",
    })
      .trim()
      .startsWith("T");
  } catch {
    return false;
  }
}
interface Witness {
  supervisor: LocalProcessIdentity;
  api: LocalProcessIdentity;
  worker: LocalProcessIdentity;
  postgres: LocalProcessIdentity;
  storagePath: string;
  runId: string;
}
export async function readLocalCleanupWitness(
  directory: string,
): Promise<Witness> {
  const dir = await lstat(directory),
    file = await lstat(join(directory, "cleanup-witness.json"));
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o777) !== 0o700 ||
    dir.uid !== process.getuid?.() ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    (file.mode & 0o777) !== 0o600 ||
    file.uid !== process.getuid?.()
  )
    throw new Error("cleanup_witness_unavailable");
  const witness: Witness = JSON.parse(
    await readFile(join(directory, "cleanup-witness.json"), "utf8"),
  );
  for (const identity of [
    witness.supervisor,
    witness.api,
    witness.worker,
    witness.postgres,
  ])
    if (
      !identity ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 2 ||
      identity.uid !== process.getuid?.() ||
      typeof identity.started !== "string" ||
      typeof identity.command !== "string"
    )
      throw new Error("cleanup_witness_unavailable");
  if (
    !witness.api.command.includes(
      `localDiagnosticProcess.ts api ${join(directory, "api-launch.json")}`,
    ) ||
    !witness.worker.command.includes(
      `localDiagnosticProcess.ts worker ${join(directory, "worker-launch.json")}`,
    ) ||
    !witness.supervisor.command.includes(
      `localDiagnostic.ts serve ${directory} `,
    ) ||
    !witness.postgres.command.includes(`-D ${witness.storagePath} `)
  )
    throw new Error("cleanup_witness_unavailable");
  return witness;
}
export async function recordLocalCleanupWitness(
  directory: string,
  input: Omit<Witness, "postgres">,
) {
  const pid = Number(
    (await readFile(join(input.storagePath, "postmaster.pid"), "utf8")).split(
      "\n",
    )[0],
  );
  const postgres = processIdentity(pid);
  if (
    !postgres ||
    postgres.uid !== process.getuid?.() ||
    !postgres.command.includes(input.storagePath)
  )
    throw new Error("diagnostic_postgres_identity_unavailable");
  await writeFile(
    join(directory, "cleanup-witness.json"),
    JSON.stringify({ ...input, postgres }),
    { mode: 0o600 },
  );
}
async function stopKnown(
  identity: LocalProcessIdentity,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (processIdentity(identity.pid) === null) return true;
  if (!processIdentityMatches(identity)) return false;
  process.kill(identity.pid, signal);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (processIdentity(identity.pid) === null) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!processIdentityMatches(identity)) return false;
  process.kill(identity.pid, "SIGKILL");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (processIdentity(identity.pid) === null) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}
export async function recoverLocalDiagnostic(directory: string) {
  let previous: {
    runFailure?: string | null;
    controllerFailure?: string | null;
  } = {};
  try {
    previous = JSON.parse(
      await readFile(join(directory, "status.json"), "utf8"),
    );
  } catch {
    /* unavailable remains unknown */
  }
  let localCopiesAndKeysRemoved = false;
  let processesAbsent = false,
    databaseStorageAbsent = false,
    runId: string | null = null;
  try {
    const witness = await readLocalCleanupWitness(directory);
    runId = witness.runId;
    // A live controller retains lifecycle ownership. Unknown/reused identities are never signalled.
    if (processIdentity(witness.supervisor.pid) !== null)
      throw new Error("cleanup_controller_identity_unavailable");
    const api = await stopKnown(witness.api),
      worker = await stopKnown(witness.worker);
    if (!api || !worker)
      throw new Error("cleanup_process_identity_unavailable");
    let directoryInfo;
    try {
      directoryInfo = await lstat(witness.storagePath);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (
      directoryInfo &&
      (!directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        directoryInfo.uid !== process.getuid?.() ||
        !basename(witness.storagePath).startsWith("fss-pg-"))
    )
      throw new Error("cleanup_storage_identity_unavailable");
    const postgres = await stopKnown(witness.postgres, "SIGINT");
    if (!postgres) throw new Error("cleanup_postgres_identity_unavailable");
    processesAbsent = true;
    if (directoryInfo)
      await rm(witness.storagePath, { recursive: true, force: true });
    try {
      await access(witness.storagePath);
    } catch (error) {
      databaseStorageAbsent =
        error instanceof Error && "code" in error && error.code === "ENOENT";
    }
    if (!databaseStorageAbsent) throw new Error("cleanup_storage_unknown");
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
    await rm(join(directory, "journal"), { recursive: true, force: true });
    await rm(join(directory, "cleanup-witness.json"), { force: true });
    localCopiesAndKeysRemoved = true;
  } catch {
    /* Unknown recovery retains private evidence and key for an explicit later cleanup. */
  }
  const status = {
    state:
      processesAbsent && databaseStorageAbsent && localCopiesAndKeysRemoved
        ? "cleaned"
        : "cleanup_unknown",
    runId,
    runFailure: previous.runFailure ?? null,
    controllerFailure: previous.controllerFailure ?? "supervisor_unavailable",
    recoveryFailure:
      processesAbsent && databaseStorageAbsent && localCopiesAndKeysRemoved
        ? null
        : "cleanup_unverified",
    recoveryReason: "supervisor_unavailable",
    processesAbsent,
    databaseStorageAbsent,
    localCopiesAndKeysRemoved,
    googleRevocation: "not_attested",
    productionActivationAllowed: false,
  };
  await writeFile(join(directory, "status.json"), JSON.stringify(status), {
    mode: 0o600,
  });
  return status;
}
