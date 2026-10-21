import type * as FileSystem from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLocalDiagnosticStatus } from "../../tools/upgrade/localDiagnosticStatus.ts";
import { recoverLocalDiagnostic } from "../../tools/upgrade/localDiagnosticCleanup.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
afterEach(() => vi.restoreAllMocks());

it.each(["controller", "recovery"] as const)("keeps the previous complete snapshot readable during %s publication", async (writer) => {
  const directory = await mkdtemp(join(tmpdir(), "callie-status-"));
  const path = join(directory, "status.json");
  const before = { state: "runtime_failed", runFailure: "runtime_failed" };
  const after = { state: "cleanup_unknown", runFailure: "runtime_failed" };
  let release!: () => void;
  let partial!: () => void;
  const paused = new Promise<void>((done) => { release = done; });
  const written = new Promise<void>((done) => { partial = done; });
  let publication: Promise<void> | undefined;
  try {
    await writeFile(path, JSON.stringify(before), { mode: 0o600 });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementationOnce(async (data) => {
        const bytes = String(data);
        await write(bytes.slice(0, 10));
        partial();
        await paused;
        await write(bytes.slice(10));
      });
      return file;
    });
    publication = writer === "controller"
      ? writeLocalDiagnosticStatus(directory, after)
      : recoverLocalDiagnostic(directory).then(() => undefined);
    await written;
    const temporary = (await readdir(directory)).find((name) => name !== "status.json");
    expect(temporary).toBeDefined();
    const partialBytes = await readFile(join(directory, temporary!), "utf8");
    expect(partialBytes).toBe(JSON.stringify(after).slice(0, 10));
    expect(() => JSON.parse(partialBytes)).toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(before);
    release();
    await publication;
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(after);
    if (writer === "recovery") expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      recoveryFailure: "cleanup_unverified",
      productionActivationAllowed: false,
      processesAbsent: false,
      databaseStorageAbsent: false,
      localCopiesAndKeysRemoved: false,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["status.json"]);
  } finally {
    release();
    await publication;
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["write", "sync", "rename"] as const)("preserves the previous status and removes temporary bytes on %s failure", async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), "callie-status-failure-"));
  const path = join(directory, "status.json");
  const previous = { state: "cleanup_unknown", runFailure: "runtime_failed" };
  const error = new Error(`controlled_${failure}_failure`);
  try {
    await writeFile(path, JSON.stringify(previous), { mode: 0o600 });
    if (failure === "rename") vi.mocked(rename).mockRejectedValueOnce(error);
    else vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const write = file.writeFile.bind(file);
      if (failure === "sync") vi.spyOn(file, "sync").mockRejectedValueOnce(error);
      else vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
        await write("{\"state\":");
        throw error;
      });
      return file;
    });
    await expect(writeLocalDiagnosticStatus(directory, { state: "cleaned" })).rejects.toBe(error);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(previous);
    expect(await readdir(directory)).toEqual(["status.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["write", "sync"] as const)("removes owned temporary bytes when %s and cleanup close both reject", async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), "callie-status-close-failure-"));
  const path = join(directory, "status.json");
  const previous = { state: "cleanup_unknown", runFailure: "runtime_failed" };
  const publicationError = new Error(`controlled_${failure}_failure`);
  const closeError = new Error("controlled_close_failure");
  let closeHandle: (() => Promise<void>) | undefined;
  try {
    await writeFile(path, JSON.stringify(previous), { mode: 0o600 });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      closeHandle = file.close.bind(file);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        await closeHandle!();
        throw closeError;
      });
      if (failure === "sync") vi.spyOn(file, "sync").mockRejectedValueOnce(publicationError);
      else vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
        await write("{\"state\":");
        throw publicationError;
      });
      return file;
    });
    await expect(writeLocalDiagnosticStatus(directory, { state: "cleaned" })).rejects.toBe(publicationError);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(previous);
    expect(await readdir(directory)).toEqual(["status.json"]);
  } finally {
    await closeHandle?.();
    await rm(directory, { recursive: true, force: true });
  }
});

it("creates the first complete private status snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "callie-status-first-"));
  try {
    await writeLocalDiagnosticStatus(directory, { state: "preparing" });
    const path = join(directory, "status.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ state: "preparing" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["status.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
