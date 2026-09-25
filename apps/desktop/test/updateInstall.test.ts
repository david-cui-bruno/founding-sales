import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../src/shared/updateContract.ts';
import {
  checkForUpdate,
  downloadVerifiedArtifact,
  signManifest,
  type UpdateCheckOptions,
  type UpdateDecision,
  type UpdateManifest,
} from '../src/main/updateChannel.ts';
import {
  confirmLaunch,
  createUpdater,
  launchedRecordSchema,
  readTeamIdentifier,
  runningBundleOf,
  teamRequirement,
  type UpdateHost,
  type Updater,
} from '../src/main/updateInstall.ts';
import {
  CHANNEL,
  OTHER_TEAM,
  TEAM,
  createFakeFiles,
  createFakeTools,
  fakeZip,
  manifestFor,
  type FakeBundle,
  type FakeFiles,
  type FakeTools,
} from './support/updateFakes.ts';
import { generateUpdateKeyPair } from './support/updateKeys.ts';

/** The macOS these fixtures run on: above the 13.0.0 every fixture manifest asks for. */
const MAC_OS = '15.4.1';

/**
 * Lane g83: Callie updates itself when it is opened (audit item G11).
 *
 * Every test here runs the real install code — the staging, the bundle checks, the
 * three renames, the records — against a filesystem made of data, a `codesign` that
 * answers from it and a relauncher that only writes down what it was asked to start. What
 * each one proves is the property a person depends on: nothing is installed that does
 * not verify, a failure never leaves half an app, and the previous version is there until
 * the new one has started.
 */

const RUNNING = '/Applications/Callie.app';
const EXE = `${RUNNING}/Contents/MacOS/Callie`;
const UPDATES = '/Users/test/Library/Application Support/Callie/updates';
const DOWNLOADS = '/Users/test/Downloads';
const PREVIOUS = '/Applications/.Callie-1.0.5.previous';
const INCOMING = '/Applications/.Callie-1.0.6.incoming';
const STAGED_BUNDLE = `${UPDATES}/staging/1.0.6/Callie.app`;

interface Harness {
  readonly fake: FakeFiles;
  readonly tools: FakeTools;
  readonly updater: Updater;
  readonly told: { message: string; detail: string }[];
  readonly revealed: string[];
  readonly relaunched: string[];
  readonly published: UpdateStatus[];
  readonly checks: UpdateCheckOptions[];
  readonly downloads: string[];
  /** The notice, the download and the relaunch, in the order they happened. */
  readonly events: string[];
  /** What the channel answers from now on. */
  answer(decision: UpdateDecision): void;
  /** The channel offers this bundle from now on, signed as its own version. */
  offer(bundle: FakeBundle): void;
  /** This build is blocked by a raised minimum (5.3) from now on. */
  block(): void;
  /** The same Mac, started again as `version` — the relaunch the swap asked for. */
  startAs(version: string): Harness;
}

interface HarnessOptions {
  readonly current?: string;
  readonly running?: FakeBundle | null;
  readonly offered?: FakeBundle;
  readonly offeredVersion?: string;
  readonly decision?: UpdateDecision;
  readonly exe?: string;
  readonly fake?: FakeFiles;
  readonly placeRunning?: boolean;
}

const offered: FakeBundle = { version: '1.0.6', team: TEAM };
const zip = fakeZip(offered);
const manifest = manifestFor(zip, '1.0.6');
const available = (value: UpdateManifest = manifest): UpdateDecision => ({ kind: 'available', manifest: value });

function harness(options: HarnessOptions = {}): Harness {
  const fake = options.fake ?? createFakeFiles();
  const current = options.current ?? '1.0.5';
  if (options.fake === undefined) {
    fake.makeDirectory('/Applications');
    fake.makeDirectory(DOWNLOADS);
    fake.makeDirectory(UPDATES);
    // Something else of the person's beside Callie, which nothing here may touch.
    fake.placeBundle('/Applications/Slack.app', { version: '4.0.0', identifier: 'com.tinyspeck.slackmacgap', team: OTHER_TEAM });
    fake.writeFile('/Applications/.Callie-notes', 'mine');
  }
  if (options.running !== null && options.placeRunning !== false) {
    fake.placeBundle(RUNNING, options.running ?? { version: current, team: TEAM });
  }
  let bundle = options.offered ?? offered;
  let bytes = fakeZip(bundle);
  let decision = options.decision ?? available(manifestFor(bytes, options.offeredVersion ?? bundle.version));
  let blocked = false;

  const tools = createFakeTools(fake);
  const told: { message: string; detail: string }[] = [];
  const revealed: string[] = [];
  const relaunched: string[] = [];
  const published: UpdateStatus[] = [];
  const checks: UpdateCheckOptions[] = [];
  const downloads: string[] = [];
  const events: string[] = [];
  const host: UpdateHost = {
    updateDirectory: UPDATES,
    executablePath: options.exe ?? EXE,
    files: fake.files,
    run: tools.run,
    now: () => new Date('2026-09-25T13:00:00.000Z'),
  };
  const updater = createUpdater({
    currentVersion: current,
    systemVersion: MAC_OS,
    channelBaseUrl: CHANNEL,
    publicKey: 'compiled-in',
    host,
    check: async input => {
      checks.push(input);
      return await Promise.resolve(decision);
    },
    // The real download check against the signed size and digest, over fake bytes.
    download: async value => {
      downloads.push(value.releaseVersion);
      events.push('download');
      return await downloadVerifiedArtifact(value, async () => await Promise.resolve(bytes));
    },
    blocked: async () => await Promise.resolve(blocked),
    tell: async (message, detail) => {
      told.push({ message, detail });
      await Promise.resolve();
    },
    reveal: path => {
      revealed.push(path);
    },
    downloadDirectory: () => DOWNLOADS,
    relaunch: path => {
      relaunched.push(path);
      events.push('relaunch');
    },
    publish: status => {
      published.push(status);
      events.push(`publish ${status.kind}`);
    },
  });

  return {
    fake,
    tools,
    updater,
    told,
    revealed,
    relaunched,
    published,
    checks,
    downloads,
    events,
    answer: next => {
      decision = next;
    },
    offer: next => {
      bundle = next;
      bytes = fakeZip(next);
      decision = available(manifestFor(bytes, next.version));
    },
    block: () => {
      blocked = true;
    },
    startAs: version => harness({ ...options, current: version, fake, placeRunning: false, offered: bundle, decision }),
  };
}

/** Nothing in Applications changed: the running bundle is where it was, as it was, and nothing was renamed there. */
function expectApplicationsUntouched(h: Harness, version = '1.0.5'): void {
  expect(h.fake.bundleAt(RUNNING)?.version).toBe(version);
  expect(h.fake.log.filter(line => line.includes('/Applications/'))).toEqual([]);
  expect(h.relaunched).toEqual([]);
}

describe('at launch', () => {
  it('asks the channel once, right away, with this build’s version, channel and key', async () => {
    const h = harness({ decision: { kind: 'up_to_date' } });

    await expect(h.updater.atLaunch()).resolves.toEqual({ kind: 'nothing', decision: { kind: 'up_to_date' } });
    expect(h.checks).toEqual([{ currentVersion: '1.0.5', systemVersion: MAC_OS, channelBaseUrl: CHANNEL, publicKey: 'compiled-in' }]);
    expectApplicationsUntouched(h);
  });

  it('installs what the channel offers without asking: notice, swap, relaunch', async () => {
    const h = harness();

    await expect(h.updater.atLaunch()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });

    // The notice went up before the download started, and nothing was asked.
    expect(h.published).toEqual([{ kind: 'installing', version: '1.0.6' }]);
    expect(h.events).toEqual(['publish installing', 'download', 'relaunch']);
    expect(h.told).toEqual([]);
    // The new bundle is where the running one was; the running one is beside it.
    expect(h.fake.bundleAt(RUNNING)).toMatchObject({ version: '1.0.6', team: TEAM });
    expect(h.fake.bundleAt(PREVIOUS)).toMatchObject({ version: '1.0.5', team: TEAM });
    expect(h.fake.exists(INCOMING)).toBe(false);
    expect(h.relaunched).toEqual([EXE]);
  });

  it('swaps with three renames, the last two in the running bundle’s own directory', async () => {
    const h = harness();
    await h.updater.atLaunch();

    expect(h.fake.log.filter(line => line.startsWith('rename '))).toEqual([
      `rename ${STAGED_BUNDLE} -> ${INCOMING}`,
      `rename ${RUNNING} -> ${PREVIOUS}`,
      `rename ${INCOMING} -> ${RUNNING}`,
    ]);
    // The record that says 1.0.6 must start comes after the swap, and the staged record goes.
    const writes = h.fake.log.filter(line => line.startsWith('write ') || line.startsWith('rename '));
    expect(writes.indexOf(`write ${UPDATES}/installed.json`)).toBeGreaterThan(writes.indexOf(`rename ${INCOMING} -> ${RUNNING}`));
    expect(h.fake.readJson(`${UPDATES}/installed.json`)).toEqual({
      format: 'fss-desktop-installed-update',
      version: '1.0.6',
      previousVersion: '1.0.5',
      installedAt: '2026-09-25T13:00:00.000Z',
    });
    expect(h.fake.exists(`${UPDATES}/staged.json`)).toBe(false);
  });

  it('proves the bundle against the running app: version, identifier, team, and a deep verify naming the team', async () => {
    const h = harness();
    await h.updater.atLaunch();

    expect(h.tools.calls).toEqual([
      `/usr/bin/ditto -x -k ${UPDATES}/Callie-1.0.6-arm64.zip ${UPDATES}/staging/1.0.6`,
      `/usr/bin/codesign -dv --verbose=4 ${RUNNING}`,
      `/usr/bin/plutil -extract CFBundleShortVersionString raw -o - ${STAGED_BUNDLE}/Contents/Info.plist`,
      `/usr/bin/plutil -extract CFBundleIdentifier raw -o - ${STAGED_BUNDLE}/Contents/Info.plist`,
      `/usr/bin/plutil -extract CFBundleIdentifier raw -o - ${RUNNING}/Contents/Info.plist`,
      `/usr/bin/codesign -dv --verbose=4 ${STAGED_BUNDLE}`,
      `/usr/bin/codesign --verify --deep --strict -R ${teamRequirement(TEAM)} ${STAGED_BUNDLE}`,
    ]);
    expect(teamRequirement(TEAM)).toBe(`=anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`);
  });

  it('runs the whole chain from a signed manifest: signature, origin, bytes, bundle', async () => {
    const keys = generateUpdateKeyPair();
    const signed = signManifest(manifest, keys.privateKey);
    const fake = createFakeFiles();
    fake.makeDirectory(DOWNLOADS);
    fake.makeDirectory(UPDATES);
    fake.placeBundle(RUNNING, { version: '1.0.5', team: TEAM });
    const relaunched: string[] = [];
    const updater = createUpdater({
      currentVersion: '1.0.5',
      systemVersion: MAC_OS,
      channelBaseUrl: CHANNEL,
      publicKey: keys.publicKey,
      host: { updateDirectory: UPDATES, executablePath: EXE, files: fake.files, run: createFakeTools(fake).run, now: () => new Date() },
      check: async input => await checkForUpdate({ ...input, fetchJson: async () => await Promise.resolve(signed) }),
      download: async value => await downloadVerifiedArtifact(value, async () => await Promise.resolve(zip)),
      blocked: async () => await Promise.resolve(false),
      tell: async () => { await Promise.resolve(); },
      reveal: () => undefined,
      downloadDirectory: () => DOWNLOADS,
      relaunch: path => { relaunched.push(path); },
      publish: () => undefined,
    });

    await expect(updater.atLaunch()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });
    expect(fake.bundleAt(RUNNING)?.version).toBe('1.0.6');
    expect(relaunched).toEqual([EXE]);
  });

  it('installs nothing when the channel has nothing, cannot be read, or is refused', async () => {
    for (const decision of [
      { kind: 'up_to_date' },
      { kind: 'refused', reason: 'update_offline' },
      { kind: 'refused', reason: 'update_signature_invalid' },
      { kind: 'refused', reason: 'update_key_absent' },
    ] as const) {
      const h = harness({ decision });
      await expect(h.updater.atLaunch()).resolves.toEqual({ kind: 'nothing', decision });
      expectApplicationsUntouched(h);
      // A tampered or silent channel says nothing to the person (install.md step 6).
      expect(h.told).toEqual([]);
      expect(h.downloads).toEqual([]);
    }
  });
});

describe('refusals install nothing', () => {
  const refusedWith = async (options: HarnessOptions, reason: string): Promise<Harness> => {
    const h = harness(options);
    await expect(h.updater.atLaunch()).resolves.toEqual({ kind: 'refused', version: '1.0.6', reason });
    expectApplicationsUntouched(h, options.current ?? '1.0.5');
    expect(h.told).toEqual([{ message: 'Callie could not verify the update', detail: `It has not been installed (${reason}).` }]);
    expect(h.revealed).toEqual([]);
    expect(h.fake.children(DOWNLOADS)).toEqual([]);
    // What failed verification does not stay on disk.
    expect(h.fake.exists(STAGED_BUNDLE)).toBe(false);
    expect(h.fake.exists(`${UPDATES}/staged.json`)).toBe(false);
    expect(h.published.at(-1)).toEqual({ kind: 'none' });
    return h;
  };

  it('refuses a bundle whose version is not the manifest’s', async () => {
    await refusedWith({ offered: { version: '1.0.7', team: TEAM }, offeredVersion: '1.0.6' }, 'update_bundle_version_mismatch');
  });

  it('refuses a bundle that is not newer than the running build', async () => {
    await refusedWith({ current: '1.0.6', offered: { version: '1.0.6', team: TEAM } }, 'update_bundle_not_newer');
  });

  it('refuses a bundle signed by another team', async () => {
    await refusedWith({ offered: { version: '1.0.6', team: OTHER_TEAM } }, 'update_bundle_team_mismatch');
  });

  it('refuses an ad-hoc bundle, which has no team at all', async () => {
    await refusedWith({ offered: { version: '1.0.6', team: null } }, 'update_bundle_team_mismatch');
  });

  it('refuses a bundle whose seal is broken, even with the right team', async () => {
    const h = await refusedWith({ offered: { version: '1.0.6', team: TEAM, intact: false } }, 'update_bundle_signature_invalid');
    expect(h.tools.calls.at(-1)).toContain('--verify --deep --strict');
  });

  it('refuses a bundle that is some other app of the same team', async () => {
    await refusedWith(
      { offered: { version: '1.0.6', team: TEAM, identifier: 'com.callie.something-else' } },
      'update_bundle_identifier_mismatch',
    );
  });

  it('installs nothing from a running build with no Team ID — the local smoke build', async () => {
    const h = await refusedWith({ running: { version: '1.0.5', team: null } }, 'update_running_team_absent');
    // It never got as far as asking who signed the update.
    expect(h.tools.calls.filter(call => call.includes(STAGED_BUNDLE) && call.includes('codesign'))).toEqual([]);
  });

  it('installs nothing when the app is not running from a bundle', async () => {
    const h = harness({ exe: '/usr/local/bin/electron', running: null });
    await expect(h.updater.atLaunch()).resolves.toEqual({
      kind: 'refused',
      version: '1.0.6',
      reason: 'update_running_bundle_unknown',
    });
    expect(h.relaunched).toEqual([]);
    expect(h.fake.log.filter(line => line.startsWith('rename '))).toEqual([]);
  });

  it('keeps the download refusals: bytes that do not match the signed digest are never unpacked', async () => {
    const h = harness({ decision: available({ ...manifest, artifact: { ...manifest.artifact, sha256: '0'.repeat(64) } }) });
    await expect(h.updater.atLaunch()).resolves.toMatchObject({ kind: 'refused', reason: 'update_artifact_digest_mismatch' });
    expect(h.tools.calls).toEqual([]);
    expectApplicationsUntouched(h);
  });

  it('does not offer a refused version again in the same run', async () => {
    const h = await refusedWith({ offered: { version: '1.0.6', team: OTHER_TEAM } }, 'update_bundle_team_mismatch');
    await expect(h.updater.periodic()).resolves.toMatchObject({ kind: 'nothing' });
    expect(h.told).toHaveLength(1);
    expect(h.downloads).toEqual(['1.0.6']);
  });
});

describe('a failure after verification falls back to the zip, never to half an app', () => {
  const fellBack = async (h: Harness, step: string): Promise<void> => {
    await expect(h.updater.atLaunch()).resolves.toEqual({ kind: 'fell_back', version: '1.0.6', step, restored: true });
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.5');
    expect(h.fake.exists(PREVIOUS)).toBe(false);
    expect(h.fake.exists(INCOMING)).toBe(false);
    expect(h.relaunched).toEqual([]);
    // G13a's behaviour: the verified zip in Downloads, revealed, and one sentence.
    expect(h.fake.children(DOWNLOADS)).toEqual(['Callie-1.0.6-arm64.zip']);
    expect(await h.fake.files.readBytes(`${DOWNLOADS}/Callie-1.0.6-arm64.zip`)).toEqual(zip);
    expect(h.revealed).toEqual([`${DOWNLOADS}/Callie-1.0.6-arm64.zip`]);
    expect(h.told).toEqual([
      { message: 'Callie 1.0.6 is ready to install', detail: 'Unzip it and replace Callie in Applications, then open it again.' },
    ]);
    expect(h.published.at(-1)).toEqual({ kind: 'none' });
  };

  it('when the new bundle cannot be moved beside the running one (another volume): nothing changed', async () => {
    const h = harness();
    h.fake.fail({ operation: 'rename', matches: (_from, to) => to === INCOMING, code: 'EXDEV' });
    await fellBack(h, 'move_in');
    expect(h.fake.log.filter(line => line.startsWith('rename '))).toEqual([]);
  });

  it('when the running bundle cannot be moved aside: the new one is taken back', async () => {
    const h = harness();
    h.fake.fail({ operation: 'rename', matches: from => from === RUNNING, code: 'EPERM' });
    await fellBack(h, 'move_aside');
    expect(h.fake.log.filter(line => line.startsWith('rename '))).toEqual([
      `rename ${STAGED_BUNDLE} -> ${INCOMING}`,
      `rename ${INCOMING} -> ${STAGED_BUNDLE}`,
    ]);
  });

  it('when the new bundle cannot be put in place: the running one is put back', async () => {
    const h = harness();
    h.fake.fail({ operation: 'rename', matches: (from, to) => from === INCOMING && to === RUNNING, code: 'EACCES' });
    await fellBack(h, 'move_into_place');
    expect(h.fake.log.filter(line => line.startsWith('rename '))).toEqual([
      `rename ${STAGED_BUNDLE} -> ${INCOMING}`,
      `rename ${RUNNING} -> ${PREVIOUS}`,
      `rename ${PREVIOUS} -> ${RUNNING}`,
      `rename ${INCOMING} -> ${STAGED_BUNDLE}`,
    ]);
    expect(h.fake.exists(`${UPDATES}/installed.json`)).toBe(false);
  });

  it('when the verified zip cannot be unpacked', async () => {
    const h = harness();
    h.tools.failExtract();
    await fellBack(h, 'extract');
  });

  it('says exactly where the running app is in the one case it could not be put back', async () => {
    const h = harness();
    h.fake.fail({ operation: 'rename', matches: (_from, to) => to === RUNNING, code: 'EIO' });
    await expect(h.updater.atLaunch()).resolves.toEqual({
      kind: 'fell_back',
      version: '1.0.6',
      step: 'move_into_place',
      restored: false,
    });
    expect(h.fake.bundleAt(PREVIOUS)?.version).toBe('1.0.5');
    expect(h.relaunched).toEqual([]);
    expect(h.told).toEqual([
      {
        message: 'Callie could not finish the update',
        detail: `Callie 1.0.5 is intact but was moved. Before you open Callie again, put it back in Terminal: mv "${PREVIOUS}" "${RUNNING}"`,
      },
    ]);
  });
});

describe('the previous bundle is kept until the new one has started', () => {
  it('is still there after the swap, and goes once 1.0.6 has recorded its start', async () => {
    const h = harness();
    await h.updater.atLaunch();
    expect(h.fake.bundleAt(PREVIOUS)?.version).toBe('1.0.5');

    const next = h.startAs('1.0.6');
    next.answer({ kind: 'up_to_date' });
    await next.updater.atLaunch();

    expect(h.fake.exists(PREVIOUS)).toBe(false);
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.6');
    expect(launchedRecordSchema.parse(h.fake.readJson(`${UPDATES}/launched.json`))).toEqual({
      format: 'fss-desktop-launched',
      version: '1.0.6',
      confirmedAt: '2026-09-25T13:00:00.000Z',
    });
    expect(h.fake.exists(`${UPDATES}/installed.json`)).toBe(false);
    // The start is recorded before anything is removed.
    const log = h.fake.log;
    expect(log.lastIndexOf(`write ${UPDATES}/launched.json`)).toBeLessThan(log.lastIndexOf(`remove ${PREVIOUS}`));
    // And only Callie's own leftovers were removed from Applications.
    expect(h.fake.bundleAt('/Applications/Slack.app')?.version).toBe('4.0.0');
    expect(h.fake.exists('/Applications/.Callie-notes')).toBe(true);
  });

  it('is kept when the start cannot be recorded', async () => {
    const h = harness();
    await h.updater.atLaunch();
    h.fake.fail({ operation: 'writeText', matches: path => path === `${UPDATES}/launched.json`, code: 'ENOSPC' });

    const confirmation = await confirmLaunch('1.0.6', {
      updateDirectory: UPDATES,
      executablePath: EXE,
      files: h.fake.files,
      run: h.tools.run,
      now: () => new Date(),
    });

    expect(confirmation).toEqual({ confirmed: null, held: null, removed: [] });
    expect(h.fake.bundleAt(PREVIOUS)?.version).toBe('1.0.5');
    expect(h.fake.exists(`${UPDATES}/installed.json`)).toBe(true);
  });

  it('holds a version that never started, so a manual restore is not undone at the next launch', async () => {
    const h = harness();
    await h.updater.atLaunch();
    // 1.0.6 does not start. The person follows install.md: the previous bundle back in place.
    await h.fake.files.remove(RUNNING);
    await h.fake.files.rename(PREVIOUS, RUNNING);

    const restored = h.startAs('1.0.5');
    await expect(restored.updater.atLaunch()).resolves.toEqual({ kind: 'held', version: '1.0.6' });
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.5');
    expect(h.fake.readJson(`${UPDATES}/held.json`)).toEqual({ format: 'fss-desktop-held-updates', versions: ['1.0.6'] });
    expect(restored.relaunched).toEqual([]);
    expect(restored.downloads).toEqual([]);

    // A newer release is not held.
    const later = h.startAs('1.0.5');
    later.offer({ version: '1.0.7', team: TEAM });
    await expect(later.updater.periodic()).resolves.toEqual({ kind: 'ready', version: '1.0.7' });
  });

  it('ignores a record somebody edited to name a path', async () => {
    const h = harness({ decision: { kind: 'up_to_date' } });
    h.fake.writeJson(`${UPDATES}/installed.json`, {
      format: 'fss-desktop-installed-update',
      version: '../../../Slack.app',
      previousVersion: '1.0.4',
      installedAt: '2026-09-25T13:00:00.000Z',
    });
    await h.updater.atLaunch();
    expect(h.fake.bundleAt('/Applications/Slack.app')?.version).toBe('4.0.0');
    expect(h.fake.exists(`${UPDATES}/held.json`)).toBe(false);
  });
});

describe('while in use', () => {
  it('downloads and stages a verified update, shows Restart to update, and leaves the app alone', async () => {
    const h = harness();

    await expect(h.updater.periodic()).resolves.toEqual({ kind: 'ready', version: '1.0.6' });

    expect(h.updater.status()).toEqual({ kind: 'ready', version: '1.0.6' });
    expect(h.published).toEqual([{ kind: 'ready', version: '1.0.6' }]);
    expectApplicationsUntouched(h);
    expect(h.fake.bundleAt(STAGED_BUNDLE)?.version).toBe('1.0.6');
    expect(h.fake.readJson(`${UPDATES}/staged.json`)).toMatchObject({ manifest: { releaseVersion: '1.0.6' } });
    expect(h.told).toEqual([]);
  });

  it('installs on Restart to update, proving the staged bundle again first', async () => {
    const h = harness();
    await h.updater.periodic();
    const verifiedBefore = h.tools.calls.filter(call => call.includes('--verify')).length;

    await expect(h.updater.restartToUpdate()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });

    expect(h.tools.calls.filter(call => call.includes('--verify')).length).toBe(verifiedBefore + 1);
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.6');
    expect(h.fake.bundleAt(PREVIOUS)?.version).toBe('1.0.5');
    expect(h.relaunched).toEqual([EXE]);
    expect(h.downloads).toEqual(['1.0.6']);
  });

  it('refuses at Restart a staged bundle that was changed on disk since it was staged', async () => {
    const h = harness();
    await h.updater.periodic();
    h.fake.placeBundle(STAGED_BUNDLE, { version: '1.0.6', team: OTHER_TEAM });

    await expect(h.updater.restartToUpdate()).resolves.toMatchObject({ kind: 'refused', reason: 'update_bundle_team_mismatch' });
    expectApplicationsUntouched(h);
  });

  it('otherwise installs the staged update at the next launch, without downloading it again', async () => {
    const h = harness();
    await h.updater.periodic();

    const next = h.startAs('1.0.5');
    await expect(next.updater.atLaunch()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });
    expect(next.downloads).toEqual([]);
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.6');
  });

  it('installs a staged update at launch when the channel cannot be read, but not when it withdrew it', async () => {
    const offline = harness();
    await offline.updater.periodic();
    const unread = offline.startAs('1.0.5');
    unread.answer({ kind: 'refused', reason: 'update_offline' });
    await expect(unread.updater.atLaunch()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });

    const withdrawn = harness();
    await withdrawn.updater.periodic();
    const caughtUp = withdrawn.startAs('1.0.5');
    caughtUp.answer({ kind: 'up_to_date' });
    await expect(caughtUp.updater.atLaunch()).resolves.toMatchObject({ kind: 'nothing' });
    expectApplicationsUntouched(caughtUp);
    expect(withdrawn.fake.exists(STAGED_BUNDLE)).toBe(false);
  });

  it('installs at once when the API has raised the minimum above this build', async () => {
    const h = harness();
    h.block();

    await expect(h.updater.periodic()).resolves.toEqual({ kind: 'relaunching', version: '1.0.6' });
    expect(h.published).toEqual([{ kind: 'installing', version: '1.0.6' }]);
    expect(h.fake.bundleAt(RUNNING)?.version).toBe('1.0.6');
    expect(h.relaunched).toEqual([EXE]);
    // Proved once, not twice: it was staged a moment ago by this same call.
    expect(h.tools.calls.filter(call => call.includes('--verify'))).toHaveLength(1);
  });

  it('checks once at a time', async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.updater.periodic(), h.updater.periodic()]);
    expect(first).toEqual({ kind: 'ready', version: '1.0.6' });
    expect(second).toEqual({ kind: 'busy' });
    expect(h.downloads).toEqual(['1.0.6']);
  });

  it('has nothing to restart when nothing is staged', async () => {
    const h = harness();
    await expect(h.updater.restartToUpdate()).resolves.toEqual({ kind: 'nothing', decision: null });
    expectApplicationsUntouched(h);
  });
});

describe('reading the bundle', () => {
  it('finds the bundle the executable is in, and nothing when it is not in one', () => {
    expect(runningBundleOf(EXE)).toEqual({ path: RUNNING, parent: '/Applications', executable: 'Callie' });
    expect(runningBundleOf('/Users/test/Callie 2.app/Contents/MacOS/Callie')?.parent).toBe('/Users/test');
    expect(runningBundleOf('/usr/local/bin/node')).toBeNull();
    expect(runningBundleOf('/Callie/Contents/MacOS/Callie')).toBeNull();
  });

  it('reads the Team ID codesign prints, and none for an ad-hoc or unsigned bundle', async () => {
    const answer = (status: number, stderr: string) => async () => await Promise.resolve({ status, stdout: '', stderr });
    await expect(readTeamIdentifier(RUNNING, answer(0, `Identifier=x\nTeamIdentifier=${TEAM}\n`))).resolves.toBe(TEAM);
    await expect(readTeamIdentifier(RUNNING, answer(0, 'Signature=adhoc\nTeamIdentifier=not set\n'))).resolves.toBeNull();
    await expect(readTeamIdentifier(RUNNING, answer(1, 'code object is not signed at all'))).resolves.toBeNull();
    await expect(readTeamIdentifier(RUNNING, answer(0, 'TeamIdentifier=" or 1=1\n'))).resolves.toBeNull();
  });
});
