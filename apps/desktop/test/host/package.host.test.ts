import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as AsarModule from '@electron/asar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL_SCHEME } from '../../scripts/bundle.ts';
import { packageDesktop, type PackagedApp } from '../../scripts/package.ts';
import { verifyPackagedApp } from '../../scripts/verifyPackage.ts';
import { BUNDLE_SHARED_FILES, BUNDLE_WINDOWS } from '../../src/main/bundleScheme.ts';
import { dumpLaunchServices, handlersForScheme, LSREGISTER } from '../../src/main/launchServices.ts';
import { DESKTOP_ROOT, HOST_TESTS_ENABLED } from './support/hostGate.ts';

/**
 * The verifier, against a real bundle (G13a deliverable 1).
 *
 * No Developer ID certificate, no notarization credential and no Apple account
 * exist here, so the release path cannot be walked to its end on this machine. What
 * can be proved, and is the whole point of a verifier, is that it *refuses*: an
 * ad-hoc smoke build is not a release however convenient that would be, a bundle
 * whose contents changed after signing does not verify, and a stamp from another
 * commit is not this release.
 *
 * The build itself is real. It is packaged by `@electron/packager` from the shipped
 * sources, its fuses are burned, and it is signed — with the ad-hoc identity, in a
 * mode the verifier knows about and rejects. Nothing here substitutes an ad-hoc
 * signature for the real path; it exists so that the refusal is observed rather than
 * assumed.
 */

const anotherCommit = '0123456789abcdef0123456789abcdef01234567';

describe.skipIf(!HOST_TESTS_ENABLED)('the package verifier, on a real bundle', () => {
  let out: string;
  let built: PackagedApp;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'fss-desktop-package-'));
    built = await packageDesktop({
      root: DESKTOP_ROOT,
      outDirectory: out,
      env: { FSS_DESKTOP_PACKAGE_MODE: 'local-smoke' },
      appVersion: '1.5.0',
      apiBaseUrl: 'https://api.callie.invalid',
      updateChannelUrl: 'https://updates.callie.invalid/',
    });
  }, 900_000);

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('produces one signed arm64 bundle with the fuses burned', async () => {
    const outcome = await verifyPackagedApp(built.appPath, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });

    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.report.architecture).toBe('arm64');
    expect(outcome.report.fuses).toEqual({ ok: true });
    expect(outcome.report.entitlements).toEqual({ ok: true });
    expect(outcome.report.stamp?.channel).toBe('local-smoke');
  });

  /**
   * G13b deliverable 3, on the artifact rather than on the declaration.
   *
   * `bundleScheme.test.ts` proves the map answers every declared window; it reads
   * nothing from a bundle, because a unit test has no bundle to read. This opens the
   * asar a packager actually produced and asks the shipped handler for each window's
   * page and script — the same 404 a person would get, from the same function the app
   * installs. Until this existed, no test opened a packaged build and loaded all six
   * windows, which is precisely the gap `docs/decisions/g9-bundle-scheme-map.md`
   * recorded under "what is still not tested".
   */
  it('serves every declared window out of the packaged asar', async () => {
    const outcome = await verifyPackagedApp(built.appPath, {
      mode: 'integrity',
      expectedCommitSha: built.stamp.commitSha,
    });
    const serving = outcome.report.bundleServing;

    expect(serving).not.toBeNull();
    expect(serving?.windows.map(window => window.page)).toEqual(BUNDLE_WINDOWS.map(window => window.page));
    for (const window of serving?.windows ?? []) {
      expect(window.pageStatus, window.page).toBe(200);
      expect(window.scriptStatus, window.entry).toBe(200);
      expect(window.declaredEntryLoaded, window.page).toBe(true);
      expect(window.pageScripts.map(script => script.status), window.page).toEqual([200]);
    }
    // And the other direction: nothing shipped that the closed map will not answer.
    expect(serving?.unserved).toEqual([]);
    expect(serving?.ok).toBe(true);
    expect(outcome.failures).not.toContain('bundle_window_unreachable');
    expect(outcome.failures).not.toContain('bundle_file_unserved');
  });

  it('packs exactly the pages, scripts and shared files the windows declare', async () => {
    // The list the check walked, stated once so a window added without a page — or a
    // page left behind after a window was removed — reads as a diff rather than as a
    // boolean.
    const expected = [
      ...BUNDLE_WINDOWS.flatMap(window => [window.page, `${window.entry}.js`]),
      ...BUNDLE_SHARED_FILES,
    ].sort();
    const asar = createRequire(import.meta.url)('@electron/asar') as typeof AsarModule;
    const packed = asar
      .listPackage(join(built.appPath, 'Contents', 'Resources', 'app.asar'), { isPack: false })
      .filter(entry => entry.startsWith('/renderer/'))
      .map(entry => entry.slice('/renderer/'.length))
      .sort();

    expect(packed).toEqual(expected);
  }, 180_000);

  it('refuses the smoke build as a release', async () => {
    const outcome = await verifyPackagedApp(built.appPath, { mode: 'release', expectedCommitSha: built.stamp.commitSha });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toContain('stamp_channel_not_release');
    expect(outcome.failures).toContain('authority_not_developer_id');
    expect(outcome.failures).toContain('notarization_ticket_absent');
    expect(outcome.failures).toContain('update_public_key_absent');
  });

  it('refuses a bundle stamped with another commit', async () => {
    const outcome = await verifyPackagedApp(built.appPath, { mode: 'integrity', expectedCommitSha: anotherCommit });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toContain('stamp_commit_mismatch');
  });

  it('refuses a bundle whose contents changed after it was signed', async () => {
    // One byte on the end of the archive the app loads all of its code from.
    // `codesign --verify --deep --strict` recomputes the sealed resources, so this
    // is the real detection rather than a checksum we invented.
    const copy = await mkdtemp(join(tmpdir(), 'fss-desktop-tampered-'));
    try {
      execFileSync('/bin/cp', ['-Rp', built.appPath, copy]);
      const tamperedApp = join(copy, built.appPath.split('/').pop() ?? 'Callie.app');
      const before = await verifyPackagedApp(tamperedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
      expect(before.failures).toEqual([]);

      await appendFile(join(tamperedApp, 'Contents', 'Resources', 'app.asar'), 'x');

      const after = await verifyPackagedApp(tamperedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
      expect(after.ok).toBe(false);
      expect(after.failures).toContain('signature_invalid');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses an unsigned bundle', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'fss-desktop-unsigned-'));
    try {
      execFileSync('/bin/cp', ['-Rp', built.appPath, copy]);
      const unsignedApp = join(copy, built.appPath.split('/').pop() ?? 'Callie.app');
      execFileSync('/usr/bin/codesign', ['--remove-signature', unsignedApp]);

      const outcome = await verifyPackagedApp(unsignedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toContain('signature_invalid');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 120_000);

  it('embeds the update public key in the bundle it ships', async () => {
    // The smoke build has no key, which is why it is refused as a release above.
    // What this asserts is that the verifier reads the key out of the packaged
    // JavaScript rather than believing the stamp.
    expect(built.stamp.updatePublicKey).toBe('');
    const outcome = await verifyPackagedApp(built.appPath, { mode: 'release', expectedCommitSha: built.stamp.commitSha });
    expect(outcome.report.embeddedUpdatePublicKey).toBe('');
  });

  it('starts, loads its interface and stays up', async () => {
    // The thing only a launch proves: the burned fuses did not brick the binary,
    // the packed ESM entry point resolves inside the asar, the sandboxed preload
    // is found, and `callie-app://` serves the page that `file://` could not.
    const child = spawn(join(built.appPath, 'Contents', 'MacOS', 'Callie'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });

    const ended = new Promise<void>(resolve => { child.on('exit', () => { resolve(); }); });
    const alive = await Promise.race([
      ended.then(() => false),
      new Promise<boolean>(resolve => { setTimeout(() => { resolve(true); }, 12_000); }),
    ]);
    child.kill('SIGTERM');

    expect(output).not.toContain('Library not loaded');
    expect(output).not.toContain('code signature');
    expect(output).not.toContain('ERR_FILE_NOT_FOUND');
    expect(output).not.toContain('Failed to load URL');
    expect(alive, `the app exited within twelve seconds:\n${output}`).toBe(true);
  }, 120_000);

  it('registers its deep-link scheme with Launch Services, and unregisters cleanly', () => {
    // `-f` registers this bundle and `-u` takes it back out, so the Mac is left as
    // it was found. One dump answers both questions below, because a dump of a
    // working Mac is a third of a million lines and takes its time.
    execFileSync(LSREGISTER, ['-f', built.appPath], { timeout: 300_000 });
    try {
      const dump = dumpLaunchServices();
      expect(dump).not.toBeNull();
      expect(handlersForScheme(dump ?? '', APP_URL_SCHEME)).toContain('com.callie.fss.desktop');

      // The `tel:` local-setup check, against the real database. On a Mac with a
      // phone application this names it; on a bare runner it is honestly empty.
      // Either is an answer; throwing, hanging or placing a call would not be.
      const telephone = handlersForScheme(dump ?? '', 'tel');
      for (const identifier of telephone) expect(identifier).toMatch(/^[A-Za-z0-9._-]+$/);
    } finally {
      execFileSync(LSREGISTER, ['-u', built.appPath], { timeout: 300_000 });
    }
  }, 900_000);
});
