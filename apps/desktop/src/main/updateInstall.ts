import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { compareVersions, semanticVersionSchema } from '@fss/contracts';
import { NO_UPDATE, type UpdateStatus } from '../shared/updateContract.ts';
import {
  updateManifestSchema,
  verifyArtifactBytes,
  type ArtifactDownload,
  type UpdateCheckOptions,
  type UpdateDecision,
  type UpdateManifest,
  type UpdateRefusal,
} from './updateChannel.ts';

/**
 * Installing a verified update in place, and every decision about when (lane g83, audit
 * item G11).
 *
 * `updateChannel.ts` decides whether the channel's answer may be believed: the signed
 * manifest, the origin, the version above this one, the bytes' size and digest. This
 * file decides what happens next, and it adds three proofs about the *bundle* before
 * anything replaces the running app:
 *
 * * the extracted bundle's `CFBundleShortVersionString` is the manifest's
 *   `releaseVersion`, and that is above the running version;
 * * its `CFBundleIdentifier` is the running bundle's;
 * * its Team ID (from `codesign -dv`) is the running bundle's, and
 *   `codesign --verify --deep --strict` passes with a requirement that the certificate
 *   chain ends at Apple and names that team. A build with no Team ID — the local smoke
 *   build, signed ad hoc — installs nothing.
 *
 * Then the swap is three renames: the staged bundle into the running bundle's directory
 * under a hidden name, the running bundle aside under another, the new one into its
 * place. The last two are in one directory, so the only move that can fail for a reason
 * outside this app's control (another volume, a folder a standard user cannot write) is
 * the first, and it changes nothing. A failure after the first rename is undone. The
 * previous bundle stays beside the new one until the new one has started once
 * (`confirmLaunch`), so a build that cannot start can be restored by hand
 * (`docs/greenfield/install.md`, "If an update will not start").
 *
 * Nothing here imports Electron. Every file operation and every command goes through a
 * port, so the whole of it is tested with a fake filesystem, a fake `codesign` and a fake
 * relauncher (`test/updateInstall.test.ts`). `updater.ts` binds the ports to macOS.
 * `docs/decisions/g83-the-update-installs-itself.md`.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What a command printed and how it ended. A command that could not start ends -1. */
export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export type EntryKind = 'directory' | 'file' | 'symlink' | 'other';

/** The file operations the install needs, and no others. */
export interface UpdateFiles {
  /** What is at `path` without following a link, or null when nothing is. */
  kind(path: string): Promise<EntryKind | null>;
  /** The names in a directory; empty when it does not exist. */
  list(path: string): Promise<readonly string[]>;
  makeDirectory(path: string): Promise<void>;
  /** Null when absent. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** Null when absent. */
  readBytes(path: string): Promise<Uint8Array | null>;
  /** Written readable by this user only. */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** rename(2): atomic, and refused across volumes. */
  rename(from: string, to: string): Promise<void>;
  /** Recursive; nothing there is not an error. */
  remove(path: string): Promise<void>;
}

export interface UpdateHost {
  /** `<userData>/updates`: the staging directory and the four records. */
  readonly updateDirectory: string;
  /** `app.getPath('exe')`: `/Applications/Callie.app/Contents/MacOS/Callie` in a packaged build. */
  readonly executablePath: string;
  readonly files: UpdateFiles;
  readonly run: CommandRunner;
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** The name the release bundle has inside its zip (`publishUpdate.ts` zips `Callie.app` with `--keepParent`). */
export const RELEASE_BUNDLE_NAME = 'Callie.app';

const CODESIGN = '/usr/bin/codesign';
const DITTO = '/usr/bin/ditto';
const PLUTIL = '/usr/bin/plutil';

export interface UpdateLayout {
  readonly directory: string;
  readonly stagingRoot: string;
  readonly stagedRecord: string;
  readonly installedRecord: string;
  readonly launchedRecord: string;
  readonly heldRecord: string;
  zip(version: string): string;
  staging(version: string): string;
  stagedBundle(version: string): string;
}

export function updateLayout(directory: string): UpdateLayout {
  return {
    directory,
    stagingRoot: join(directory, 'staging'),
    stagedRecord: join(directory, 'staged.json'),
    installedRecord: join(directory, 'installed.json'),
    launchedRecord: join(directory, 'launched.json'),
    heldRecord: join(directory, 'held.json'),
    zip: version => join(directory, `Callie-${version}-arm64.zip`),
    staging: version => join(directory, 'staging', version),
    stagedBundle: version => join(directory, 'staging', version, RELEASE_BUNDLE_NAME),
  };
}

export interface RunningBundle {
  /** `/Applications/Callie.app`. */
  readonly path: string;
  /** `/Applications`. */
  readonly parent: string;
  /** `Callie`, the name under `Contents/MacOS`. */
  readonly executable: string;
}

/** The `.app` the running executable is inside, or null when it is not inside one. */
export function runningBundleOf(executablePath: string): RunningBundle | null {
  const macos = dirname(executablePath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null;
  if (dirname(bundle) === bundle) return null;
  return { path: bundle, parent: dirname(bundle), executable: basename(executablePath) };
}

/**
 * The previous bundle, beside the new one, under a name with no `.app`: Launch Services
 * registers nothing without the extension, so it is not a second Callie in Launchpad,
 * Spotlight or the `callie:` scheme, and the leading dot keeps it out of Finder.
 */
export function previousBundlePath(parent: string, version: string): string {
  return join(parent, `.Callie-${version}.previous`);
}

export function incomingBundlePath(parent: string, version: string): string {
  return join(parent, `.Callie-${version}.incoming`);
}

/** Only these names are ever removed from the running bundle's directory. */
const LEFTOVER_NAME = /^\.Callie-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(previous|incoming)$/u;

// ---------------------------------------------------------------------------
// The records in the update directory
// ---------------------------------------------------------------------------

/**
 * No record holds a path. Every path is derived from a version and the layout, so a
 * record somebody edited can name a version this code then refuses, never a directory
 * this code then deletes.
 */
const stagedRecordSchema = z.strictObject({
  format: z.literal('fss-desktop-staged-update'),
  manifest: updateManifestSchema,
  stagedAt: z.iso.datetime(),
});

const installedRecordSchema = z.strictObject({
  format: z.literal('fss-desktop-installed-update'),
  version: semanticVersionSchema,
  previousVersion: semanticVersionSchema,
  installedAt: z.iso.datetime(),
});
export type InstalledRecord = z.infer<typeof installedRecordSchema>;

/** Written by every start, before anything beside the running bundle is removed. */
export const launchedRecordSchema = z.strictObject({
  format: z.literal('fss-desktop-launched'),
  version: semanticVersionSchema,
  confirmedAt: z.iso.datetime(),
});

const heldRecordSchema = z.strictObject({
  format: z.literal('fss-desktop-held-updates'),
  versions: z.array(semanticVersionSchema).max(100),
});

async function readRecord<T>(host: UpdateHost, path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string | null;
  try {
    text = await host.files.readText(path);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeRecord(host: UpdateHost, path: string, value: unknown): Promise<void> {
  await host.files.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Best effort: the answer is whether it worked, never an exception. */
async function attempt(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
}

const newer = (candidate: string, running: string): boolean => {
  const left = semanticVersionSchema.safeParse(candidate);
  const right = semanticVersionSchema.safeParse(running);
  return left.success && right.success && compareVersions(left.data, right.data) > 0;
};

/** The staged update, when there is one this build could install: newer, and its bundle present. */
export async function readStaged(host: UpdateHost, currentVersion: string): Promise<UpdateManifest | null> {
  const layout = updateLayout(host.updateDirectory);
  const record = await readRecord(host, layout.stagedRecord, stagedRecordSchema);
  if (record === null) return null;
  const version = record.manifest.releaseVersion;
  if (!newer(version, currentVersion)) return null;
  if ((await host.files.kind(layout.stagedBundle(version))) !== 'directory') return null;
  return record.manifest;
}

/** Everything staged: the record, the extracted bundles and the zips. */
export async function discardStaged(host: UpdateHost): Promise<void> {
  const layout = updateLayout(host.updateDirectory);
  await attempt(async () => { await host.files.remove(layout.stagedRecord); });
  await attempt(async () => { await host.files.remove(layout.stagingRoot); });
  const names = await host.files.list(layout.directory).catch(() => [] as readonly string[]);
  for (const name of names) {
    if (/^Callie-.+-arm64\.zip$/u.test(name)) await attempt(async () => { await host.files.remove(join(layout.directory, name)); });
  }
}

/** Versions that were installed and never started. They are not installed again automatically. */
export async function readHeld(host: UpdateHost): Promise<readonly string[]> {
  const record = await readRecord(host, updateLayout(host.updateDirectory).heldRecord, heldRecordSchema);
  return record?.versions ?? [];
}

async function writeHeld(host: UpdateHost, versions: readonly string[]): Promise<void> {
  const path = updateLayout(host.updateDirectory).heldRecord;
  if (versions.length === 0) {
    await host.files.remove(path);
    return;
  }
  await writeRecord(host, path, { format: 'fss-desktop-held-updates', versions: [...new Set(versions)].slice(-100) });
}

// ---------------------------------------------------------------------------
// The bundle: what it says it is, and who signed it
// ---------------------------------------------------------------------------

export type InstallRefusal =
  /** The running executable is not inside an `.app`: a development run. */
  | 'update_running_bundle_unknown'
  /** The running bundle has no Team ID (an ad-hoc smoke build), so no update's Team ID can be compared with it. */
  | 'update_running_team_absent'
  | 'update_bundle_missing'
  | 'update_bundle_unreadable'
  | 'update_bundle_version_mismatch'
  | 'update_bundle_not_newer'
  | 'update_bundle_identifier_mismatch'
  | 'update_bundle_team_mismatch'
  | 'update_bundle_signature_invalid';

/** Every reason an update is not installed that the person is told about. */
export type UpdateInstallRefusal = UpdateRefusal | InstallRefusal;

/** The signing team, from `codesign -dv`'s `TeamIdentifier=` line. Null for "not set", an ad-hoc signature or no signature. */
export async function readTeamIdentifier(bundlePath: string, run: CommandRunner): Promise<string | null> {
  const result = await run(CODESIGN, ['-dv', '--verbose=4', bundlePath]);
  if (result.status !== 0) return null;
  // codesign writes its description on standard error.
  const match = /^TeamIdentifier=(.+)$/mu.exec(`${result.stderr}\n${result.stdout}`);
  const value = match?.[1]?.trim() ?? '';
  return /^[A-Z0-9]{10}$/u.test(value) ? value : null;
}

async function readInfoString(bundlePath: string, key: string, run: CommandRunner): Promise<string | null> {
  const result = await run(PLUTIL, ['-extract', key, 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')]);
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

/**
 * The requirement the new bundle's signature must satisfy: an Apple-issued certificate
 * chain whose leaf names this team. `--verify` alone proves the signature is intact, not
 * who made it — a self-signed certificate can carry any Team ID it likes.
 */
export function teamRequirement(teamIdentifier: string): string {
  return `=anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

export type BundleCheck = { readonly ok: true } | { readonly ok: false; readonly reason: InstallRefusal };

export interface BundleCheckInput {
  readonly bundlePath: string;
  readonly releaseVersion: string;
  readonly currentVersion: string;
}

/**
 * The bundle on disk, against the manifest and the running app. Cheap reads first, the
 * deep signature check (seconds, over the whole framework) last.
 */
export async function verifyStagedBundle(input: BundleCheckInput, host: UpdateHost): Promise<BundleCheck> {
  const refuse = (reason: InstallRefusal): BundleCheck => ({ ok: false, reason });
  const running = runningBundleOf(host.executablePath);
  if (running === null) return refuse('update_running_bundle_unknown');
  const runningTeam = await readTeamIdentifier(running.path, host.run);
  if (runningTeam === null) return refuse('update_running_team_absent');

  if ((await host.files.kind(input.bundlePath)) !== 'directory') return refuse('update_bundle_missing');
  const version = await readInfoString(input.bundlePath, 'CFBundleShortVersionString', host.run);
  if (version === null) return refuse('update_bundle_unreadable');
  if (version !== input.releaseVersion) return refuse('update_bundle_version_mismatch');
  if (!newer(version, input.currentVersion)) return refuse('update_bundle_not_newer');

  const identifier = await readInfoString(input.bundlePath, 'CFBundleIdentifier', host.run);
  const runningIdentifier = await readInfoString(running.path, 'CFBundleIdentifier', host.run);
  if (identifier === null || runningIdentifier === null || identifier !== runningIdentifier) {
    return refuse('update_bundle_identifier_mismatch');
  }

  if ((await readTeamIdentifier(input.bundlePath, host.run)) !== runningTeam) return refuse('update_bundle_team_mismatch');
  const verified = await host.run(CODESIGN, [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    teamRequirement(runningTeam),
    input.bundlePath,
  ]);
  if (verified.status !== 0) return refuse('update_bundle_signature_invalid');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Staging and the swap
// ---------------------------------------------------------------------------

export type InstallFailure =
  /** The staging directory or the zip could not be written. */
  | 'stage_write'
  /** `ditto` could not unpack the verified zip. */
  | 'extract'
  | 'stage_record'
  /** The new bundle could not be moved beside the running one: another volume, or a folder this user cannot write. Nothing changed. */
  | 'move_in'
  /** The running bundle could not be moved aside. The new one was taken back; nothing changed. */
  | 'move_aside'
  /** The new bundle could not be put in place. The running one was put back. */
  | 'move_into_place';

export type StageOutcome =
  | { readonly kind: 'staged'; readonly manifest: UpdateManifest }
  | { readonly kind: 'refused'; readonly reason: UpdateInstallRefusal }
  | { readonly kind: 'failed'; readonly step: InstallFailure };

/**
 * Unzip the verified bytes into `<userData>/updates/staging/<version>` and prove the
 * bundle. A refused bundle is deleted; a staged one is recorded.
 */
export async function stageUpdate(
  manifest: UpdateManifest,
  bytes: Uint8Array,
  currentVersion: string,
  host: UpdateHost,
): Promise<StageOutcome> {
  // Checked again here, at the last moment before anything opens them.
  const bytesCheck = verifyArtifactBytes(manifest, bytes);
  if (!bytesCheck.ok) return { kind: 'refused', reason: bytesCheck.reason };

  const layout = updateLayout(host.updateDirectory);
  const version = manifest.releaseVersion;
  await discardStaged(host);
  try {
    await host.files.makeDirectory(layout.staging(version));
    await host.files.writeBytes(layout.zip(version), bytes);
  } catch {
    return { kind: 'failed', step: 'stage_write' };
  }

  // `ditto` is what `publishUpdate.ts` zipped with, and the only archiver that keeps a
  // signature's extended attributes through the round trip.
  const extracted = await host.run(DITTO, ['-x', '-k', layout.zip(version), layout.staging(version)]);
  if (extracted.status !== 0) return { kind: 'failed', step: 'extract' };

  const check = await verifyStagedBundle(
    { bundlePath: layout.stagedBundle(version), releaseVersion: version, currentVersion },
    host,
  );
  if (!check.ok) {
    await discardStaged(host);
    return { kind: 'refused', reason: check.reason };
  }

  try {
    await writeRecord(host, layout.stagedRecord, {
      format: 'fss-desktop-staged-update',
      manifest,
      stagedAt: host.now().toISOString(),
    });
  } catch {
    return { kind: 'failed', step: 'stage_record' };
  }
  return { kind: 'staged', manifest };
}

export type SwapOutcome =
  | { readonly kind: 'swapped'; readonly relaunchPath: string; readonly previousPath: string }
  | {
      readonly kind: 'failed';
      readonly step: InstallFailure;
      /** False only if the running bundle could not be put back where it was. */
      readonly restored: boolean;
      readonly runningPath: string | null;
      readonly previousPath: string | null;
    };

/**
 * Put the staged bundle where the running one is, keeping the running one beside it.
 *
 *   1. staged  → `<parent>/.Callie-<new>.incoming`    (may fail; nothing has changed)
 *   2. running → `<parent>/.Callie-<current>.previous` (same directory)
 *   3. incoming → running                              (same directory)
 *
 * A failure at 2 takes the new bundle back; a failure at 3 puts the running one back.
 * The installed record is written after 3, and says which version must start.
 */
export async function swapInto(manifest: UpdateManifest, currentVersion: string, host: UpdateHost): Promise<SwapOutcome> {
  const running = runningBundleOf(host.executablePath);
  const failed = (step: InstallFailure, restored: boolean, previousPath: string | null = null): SwapOutcome => ({
    kind: 'failed',
    step,
    restored,
    runningPath: running?.path ?? null,
    previousPath,
  });
  if (running === null) return failed('move_in', true);

  const layout = updateLayout(host.updateDirectory);
  const version = manifest.releaseVersion;
  const staged = layout.stagedBundle(version);
  const incoming = incomingBundlePath(running.parent, version);
  const previous = previousBundlePath(running.parent, currentVersion);

  // Leftovers of an attempt that stopped half-way, by this code's own two names only. A
  // `.previous` named after the running version is a copy of what is running.
  if (!(await attempt(async () => { await host.files.remove(incoming); }))) return failed('move_in', true);
  if (!(await attempt(async () => { await host.files.remove(previous); }))) return failed('move_in', true);

  if (!(await attempt(async () => { await host.files.rename(staged, incoming); }))) return failed('move_in', true);
  if (!(await attempt(async () => { await host.files.rename(running.path, previous); }))) {
    await attempt(async () => { await host.files.rename(incoming, staged); });
    return failed('move_aside', true);
  }
  if (!(await attempt(async () => { await host.files.rename(incoming, running.path); }))) {
    const restored = await attempt(async () => { await host.files.rename(previous, running.path); });
    await attempt(async () => { await host.files.rename(incoming, staged); });
    return failed('move_into_place', restored, restored ? null : previous);
  }

  // In place. The record says which version has to start before the previous one goes;
  // if it cannot be written, the previous bundle is swept at the next confirmed start
  // instead, so it is kept either way.
  await attempt(async () => {
    await writeRecord(host, layout.installedRecord, {
      format: 'fss-desktop-installed-update',
      version,
      previousVersion: currentVersion,
      installedAt: host.now().toISOString(),
    });
  });
  await attempt(async () => { await host.files.remove(layout.stagedRecord); });
  return {
    kind: 'swapped',
    relaunchPath: join(running.path, 'Contents', 'MacOS', running.executable),
    previousPath: previous,
  };
}

// ---------------------------------------------------------------------------
// The first start after an update
// ---------------------------------------------------------------------------

export interface LaunchConfirmation {
  /** The version this start recorded as having started, or null if the record could not be written. */
  readonly confirmed: string | null;
  /** A version that was installed and is not the one running: it did not start, and is held. */
  readonly held: string | null;
  /** What was removed from beside the running bundle. */
  readonly removed: readonly string[];
}

/**
 * Called once this build has started — after `start(...)` has opened the window.
 *
 * The launched record is written first, and only then is the previous bundle removed,
 * so a build that dies before this point leaves the previous one where the manual
 * restore expects it. If the installed record names a different version from the one
 * running, that version was installed and something else is running now: the person
 * restored the previous bundle, and the version is held so the next launch does not
 * put it back.
 */
export async function confirmLaunch(currentVersion: string, host: UpdateHost): Promise<LaunchConfirmation> {
  const layout = updateLayout(host.updateDirectory);
  await attempt(async () => { await host.files.makeDirectory(layout.directory); });
  const installed = await readRecord(host, layout.installedRecord, installedRecordSchema);

  let held: string | null = null;
  if (installed !== null && installed.version !== currentVersion) {
    held = installed.version;
    await attempt(async () => { await writeHeld(host, [...(await readHeld(host)), installed.version]); });
  }

  const recorded = await attempt(async () => {
    await writeRecord(host, layout.launchedRecord, {
      format: 'fss-desktop-launched',
      version: currentVersion,
      confirmedAt: host.now().toISOString(),
    });
  });
  if (!recorded) return { confirmed: null, held, removed: [] };
  await attempt(async () => { await host.files.remove(layout.installedRecord); });

  const removed: string[] = [];
  const running = runningBundleOf(host.executablePath);
  if (running !== null) {
    const names = await host.files.list(running.parent).catch(() => [] as readonly string[]);
    for (const name of names) {
      if (!LEFTOVER_NAME.test(name)) continue;
      const path = join(running.parent, name);
      if (await attempt(async () => { await host.files.remove(path); })) removed.push(path);
    }
  }

  // A staged update at or below this version is spent; a held version at or below it is moot.
  const stagedRecord = await readRecord(host, layout.stagedRecord, stagedRecordSchema);
  if (stagedRecord === null || !newer(stagedRecord.manifest.releaseVersion, currentVersion)) await discardStaged(host);
  const stillHeld = (await readHeld(host)).filter(version => newer(version, currentVersion));
  await attempt(async () => { await writeHeld(host, stillHeld); });

  return { confirmed: currentVersion, held, removed };
}

// ---------------------------------------------------------------------------
// When: at launch, while in use, and on Restart
// ---------------------------------------------------------------------------

export interface UpdaterOptions {
  readonly currentVersion: string;
  readonly channelBaseUrl: string;
  /** Base64 SPKI DER, compiled in by the build. Empty means every update is refused. */
  readonly publicKey: string;
  readonly host: UpdateHost;
  readonly check: (options: UpdateCheckOptions) => Promise<UpdateDecision>;
  readonly download: (manifest: UpdateManifest) => Promise<ArtifactDownload>;
  /** True when the API has raised the minimum above this build and it refuses every mutation (5.3). */
  readonly blocked: () => Promise<boolean>;
  readonly tell: (message: string, detail: string) => Promise<void>;
  readonly reveal: (path: string) => void;
  readonly downloadDirectory: () => string;
  /** `app.relaunch({ execPath })` and `app.exit(0)`. */
  readonly relaunch: (executablePath: string) => void;
  /** The page's one line: installing, ready, or nothing. */
  readonly publish: (status: UpdateStatus) => void;
  readonly log?: (line: string) => void;
}

export type UpdateOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'nothing'; readonly decision: UpdateDecision | null }
  | { readonly kind: 'held'; readonly version: string }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'relaunching'; readonly version: string }
  | { readonly kind: 'refused'; readonly version: string; readonly reason: UpdateInstallRefusal }
  | { readonly kind: 'fell_back'; readonly version: string; readonly step: InstallFailure; readonly restored: boolean };

export interface Updater {
  /** Right after `start(...)`: record this start, then install whatever the channel offers, without asking. */
  atLaunch(): Promise<UpdateOutcome>;
  /** The six-hourly check: download and stage, then offer Restart — or install now if this build is blocked. */
  periodic(): Promise<UpdateOutcome>;
  /** The sidebar's Restart to update. */
  restartToUpdate(): Promise<UpdateOutcome>;
  status(): UpdateStatus;
}

const BUSY: UpdateOutcome = { kind: 'busy' };

/** A verified answer that no longer offers what was staged: the release was withdrawn, or this build caught up. */
function withdraws(decision: UpdateDecision): boolean {
  return decision.kind === 'up_to_date' || (decision.kind === 'refused' && decision.reason === 'update_downgrade_refused');
}

function sameArtifact(left: UpdateManifest, right: UpdateManifest): boolean {
  return (
    left.releaseVersion === right.releaseVersion &&
    left.artifact.sha256 === right.artifact.sha256 &&
    left.artifact.sizeBytes === right.artifact.sizeBytes
  );
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { host, currentVersion } = options;
  const layout = updateLayout(host.updateDirectory);
  const log = options.log ?? (() => undefined);
  let status: UpdateStatus = NO_UPDATE;
  /** Versions that were refused or fell back in this run: not tried again until the next launch. */
  const spent = new Set<string>();
  let inFlight: Promise<UpdateOutcome> | null = null;

  const setStatus = (next: UpdateStatus): void => {
    status = next;
    options.publish(next);
  };

  const exclusive = (work: () => Promise<UpdateOutcome>): Promise<UpdateOutcome> => {
    if (inFlight !== null) return Promise.resolve(BUSY);
    const running = (async () => {
      try {
        return await work();
      } catch (error: unknown) {
        // A port that threw where no step expected it. Nothing is half-done by then —
        // the swap catches its own — so the app stays as it is.
        log(`update: stopped (${error instanceof Error ? error.message : String(error)})`);
        if (status.kind === 'installing') setStatus(NO_UPDATE);
        return { kind: 'nothing', decision: null } as const;
      }
    })();
    inFlight = running;
    void running.finally(() => {
      inFlight = null;
    });
    return running;
  };

  const decide = async (): Promise<UpdateDecision> =>
    await options.check({
      currentVersion,
      channelBaseUrl: options.channelBaseUrl,
      publicKey: options.publicKey,
    });

  const refuse = async (version: string, reason: UpdateInstallRefusal): Promise<UpdateOutcome> => {
    spent.add(version);
    setStatus(NO_UPDATE);
    log(`update: ${version} refused (${reason})`);
    await options.tell('Callie could not verify the update', `It has not been installed (${reason}).`);
    return { kind: 'refused', version, reason };
  };

  /**
   * The install failed after everything was verified: hand the person the verified zip,
   * as every build before g83 did, and leave the app as it is.
   */
  const fallBack = async (
    manifest: UpdateManifest,
    bytes: Uint8Array | null,
    step: InstallFailure,
    restored: boolean,
    previousPath: string | null,
    runningPath: string | null,
  ): Promise<UpdateOutcome> => {
    const version = manifest.releaseVersion;
    spent.add(version);
    setStatus(NO_UPDATE);
    log(`update: ${version} not installed (${step}); falling back`);
    if (!restored) {
      // Two renames in one directory, the second undoing the first, and the second
      // failed. The running app is intact at `previousPath`; the person is told exactly
      // where, before they quit it.
      await options.tell(
        'Callie could not finish the update',
        `Callie ${currentVersion} is intact but was moved. Before you open Callie again, put it back in Terminal: ` +
          `mv "${previousPath ?? ''}" "${runningPath ?? ''}"`,
      );
      return { kind: 'fell_back', version, step, restored };
    }

    let artifact = bytes ?? (await host.files.readBytes(layout.zip(version)).catch(() => null));
    if (artifact === null || !verifyArtifactBytes(manifest, artifact).ok) {
      const again = await options.download(manifest);
      if (!again.ok) return await refuse(version, again.reason);
      artifact = again.bytes;
    }
    const target = join(options.downloadDirectory(), `Callie-${version}-arm64.zip`);
    if (!(await attempt(async () => { await host.files.writeBytes(target, artifact); }))) {
      await discardStaged(host);
      await options.tell('Callie could not install the update', `It has not been installed (${step}).`);
      return { kind: 'fell_back', version, step, restored };
    }
    await discardStaged(host);
    options.reveal(target);
    await options.tell(
      `Callie ${version} is ready to install`,
      'Unzip it and replace Callie in Applications, then open it again.',
    );
    return { kind: 'fell_back', version, step, restored };
  };

  const swapAndRelaunch = async (manifest: UpdateManifest, bytes: Uint8Array | null): Promise<UpdateOutcome> => {
    const swapped = await swapInto(manifest, currentVersion, host);
    if (swapped.kind === 'failed') {
      return await fallBack(manifest, bytes, swapped.step, swapped.restored, swapped.previousPath, swapped.runningPath);
    }
    log(`update: ${manifest.releaseVersion} in place; ${currentVersion} kept at ${swapped.previousPath}`);
    options.relaunch(swapped.relaunchPath);
    return { kind: 'relaunching', version: manifest.releaseVersion };
  };

  /** Download, stage, verify and swap, with the notice up throughout. */
  const installFresh = async (manifest: UpdateManifest): Promise<UpdateOutcome> => {
    const version = manifest.releaseVersion;
    setStatus({ kind: 'installing', version });
    await discardStaged(host);
    const downloaded = await options.download(manifest);
    if (!downloaded.ok) return await refuse(version, downloaded.reason);
    const staged = await stageUpdate(manifest, downloaded.bytes, currentVersion, host);
    if (staged.kind === 'refused') return await refuse(version, staged.reason);
    if (staged.kind === 'failed') return await fallBack(manifest, downloaded.bytes, staged.step, true, null, null);
    return await swapAndRelaunch(manifest, downloaded.bytes);
  };

  /** A bundle staged earlier: proved again, because it has sat on disk since, then swapped. */
  const installStaged = async (manifest: UpdateManifest): Promise<UpdateOutcome> => {
    const version = manifest.releaseVersion;
    setStatus({ kind: 'installing', version });
    const check = await verifyStagedBundle(
      { bundlePath: layout.stagedBundle(version), releaseVersion: version, currentVersion },
      host,
    );
    if (!check.ok) {
      await discardStaged(host);
      return await refuse(version, check.reason);
    }
    return await swapAndRelaunch(manifest, null);
  };

  return {
    status: () => status,

    atLaunch: async () =>
      await exclusive(async () => {
        const confirmation = await confirmLaunch(currentVersion, host);
        if (confirmation.held !== null) log(`update: ${confirmation.held} did not start; held`);
        for (const path of confirmation.removed) log(`update: removed ${path}`);

        const decision = await decide();
        const held = await readHeld(host);
        const staged = await readStaged(host, currentVersion);
        if (decision.kind === 'available') {
          const manifest = decision.manifest;
          if (held.includes(manifest.releaseVersion)) return { kind: 'held', version: manifest.releaseVersion };
          if (staged !== null && sameArtifact(staged, manifest)) return await installStaged(staged);
          return await installFresh(manifest);
        }
        if (withdraws(decision)) {
          await discardStaged(host);
          return { kind: 'nothing', decision };
        }
        // The channel could not be read or believed just now. An update staged and
        // verified earlier still stands on its own proofs.
        if (staged !== null && !held.includes(staged.releaseVersion)) return await installStaged(staged);
        return { kind: 'nothing', decision };
      }),

    periodic: async () =>
      await exclusive(async () => {
        const decision = await decide();
        if (decision.kind !== 'available') {
          if (withdraws(decision)) {
            await discardStaged(host);
            if (status.kind === 'ready') setStatus(NO_UPDATE);
          }
          return { kind: 'nothing', decision };
        }
        const manifest = decision.manifest;
        const version = manifest.releaseVersion;
        if (spent.has(version)) return { kind: 'nothing', decision };
        if ((await readHeld(host)).includes(version)) return { kind: 'held', version };

        const staged = await readStaged(host, currentVersion);
        let bytes: Uint8Array | null = null;
        if (staged === null || !sameArtifact(staged, manifest)) {
          if (status.kind === 'ready') setStatus(NO_UPDATE);
          const downloaded = await options.download(manifest);
          if (!downloaded.ok) return await refuse(version, downloaded.reason);
          const outcome = await stageUpdate(manifest, downloaded.bytes, currentVersion, host);
          if (outcome.kind === 'refused') return await refuse(version, outcome.reason);
          if (outcome.kind === 'failed') return await fallBack(manifest, downloaded.bytes, outcome.step, true, null, null);
          bytes = downloaded.bytes;
        }

        if (await options.blocked()) {
          // 5.3: this build may not change anything, so a restart loses nothing.
          if (bytes === null) return await installStaged(manifest);
          setStatus({ kind: 'installing', version });
          return await swapAndRelaunch(manifest, bytes);
        }
        setStatus({ kind: 'ready', version });
        return { kind: 'ready', version };
      }),

    restartToUpdate: async () => {
      // A click while the periodic check is reading the channel waits for it.
      while (inFlight !== null) await inFlight;
      return await exclusive(async () => {
        if (status.kind !== 'ready') return { kind: 'nothing', decision: null };
        const staged = await readStaged(host, currentVersion);
        if (staged === null || staged.releaseVersion !== status.version) {
          setStatus(NO_UPDATE);
          return { kind: 'nothing', decision: null };
        }
        return await installStaged(staged);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The real ports
// ---------------------------------------------------------------------------

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/** `node:fs`, as the port. Used by `updater.ts`; tested against a temporary directory. */
export function nodeUpdateFiles(): UpdateFiles {
  return {
    kind: async path => {
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) return 'symlink';
        if (stats.isDirectory()) return 'directory';
        if (stats.isFile()) return 'file';
        return 'other';
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    list: async path => {
      try {
        return await readdir(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    makeDirectory: async path => {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    readText: async path => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    writeText: async (path, text) => {
      // Written beside and renamed over, so a record is either the old one or the new one.
      const temporary = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, path);
    },
    readBytes: async path => {
      try {
        return new Uint8Array(await readFile(path));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    writeBytes: async (path, bytes) => {
      await writeFile(path, bytes, { mode: 0o600 });
    },
    rename: async (from, to) => {
      await rename(from, to);
    },
    remove: async path => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * The system tools, by absolute path, with a bare environment: no inherited `PATH` can
 * put another `codesign` in front of Apple's, and `LANG=C` keeps its output parseable.
 */
export function systemCommandRunner(timeoutMs = 600_000): CommandRunner {
  return async (command, args) =>
    await new Promise<CommandResult>(resolve => {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolve({
            status: error === null ? 0 : typeof code === 'number' ? code : -1,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
}
