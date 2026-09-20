import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageDesktop, type PackagedApp } from '../../scripts/package.ts';
import { verifyPackagedApp } from '../../scripts/verifyPackage.ts';
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

  it('produces one signed arm64 bundle with the fuses burned', () => {
    const outcome = verifyPackagedApp(built.appPath, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });

    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.report.architecture).toBe('arm64');
    expect(outcome.report.fuses).toEqual({ ok: true });
    expect(outcome.report.entitlements).toEqual({ ok: true });
    expect(outcome.report.stamp.channel).toBe('local-smoke');
  });

  it('refuses the smoke build as a release', () => {
    const outcome = verifyPackagedApp(built.appPath, { mode: 'release', expectedCommitSha: built.stamp.commitSha });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toContain('stamp_channel_not_release');
    expect(outcome.failures).toContain('authority_not_developer_id');
    expect(outcome.failures).toContain('notarization_ticket_absent');
    expect(outcome.failures).toContain('update_public_key_absent');
  });

  it('refuses a bundle stamped with another commit', () => {
    const outcome = verifyPackagedApp(built.appPath, { mode: 'integrity', expectedCommitSha: anotherCommit });

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
      const before = verifyPackagedApp(tamperedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
      expect(before.failures).toEqual([]);

      await appendFile(join(tamperedApp, 'Contents', 'Resources', 'app.asar'), 'x');

      const after = verifyPackagedApp(tamperedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
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

      const outcome = verifyPackagedApp(unsignedApp, { mode: 'integrity', expectedCommitSha: built.stamp.commitSha });
      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toContain('signature_invalid');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 120_000);

  it('embeds the update public key in the bundle it ships', () => {
    // The smoke build has no key, which is why it is refused as a release above.
    // What this asserts is that the verifier reads the key out of the packaged
    // JavaScript rather than believing the stamp.
    expect(built.stamp.updatePublicKey).toBe('');
    const outcome = verifyPackagedApp(built.appPath, { mode: 'release', expectedCommitSha: built.stamp.commitSha });
    expect(outcome.report.embeddedUpdatePublicKey).toBe('');
  });
});
