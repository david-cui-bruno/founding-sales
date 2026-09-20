import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as AsarModule from '@electron/asar';
import { answerBundleRequest, BUNDLE_ORIGIN, BUNDLE_WINDOWS } from '../src/main/bundleScheme.ts';
import { APP_BUNDLE_ID, APP_URL_SCHEME } from './bundle.ts';
import { ALLOWED_USAGE_DESCRIPTIONS, usageDescriptionKeys } from './package.ts';
import { compareEntitlements, parseEntitlementsPlist, type EntitlementComparison } from './entitlements.ts';
import { compareFuses, type FuseComparison } from './fuses.ts';
import { RELEASE_STAMP_FILE, validateReleaseStamp, type ReleaseStamp } from './releaseStamp.ts';

/**
 * The package verifier (G13a deliverable 1): signature, notarization ticket, commit
 * stamp and fuses.
 *
 * It answers one question — may this bundle be released — and it answers it by
 * looking at the bundle rather than at the build log. Every check reads something
 * the signature covers or something macOS itself computed, so a build script that
 * skipped a step cannot claim it ran.
 *
 * It never throws for a verification failure. A failure is a code in `failures`, and
 * the list is the whole truth about the bundle: a verifier that stops at the first
 * problem makes a person run it five times to learn five things.
 *
 * `mode: 'integrity'` is everything that does not need Apple: the signature is
 * valid, the fuses are burned, the entitlements are the declared ones, the stamp is
 * this commit. `mode: 'release'` adds the things only a real Developer ID and a real
 * notarization ticket can satisfy, and refuses the smoke build by name.
 */

const require = createRequire(import.meta.url);

export type VerificationFailure =
  | 'app_missing'
  | 'asar_missing'
  | 'stamp_unreadable'
  | 'stamp_commit_mismatch'
  | 'stamp_channel_not_release'
  | 'bundle_identifier_unexpected'
  | 'bundle_version_mismatch'
  | 'url_scheme_unregistered'
  | 'ats_arbitrary_loads_allowed'
  | 'info_plist_claims_unused_capabilities'
  | 'architecture_not_arm64'
  | 'fuse_mismatch'
  | 'signature_invalid'
  | 'signature_adhoc'
  | 'entitlements_wrong'
  | 'authority_not_developer_id'
  | 'hardened_runtime_absent'
  | 'secure_timestamp_absent'
  | 'team_identifier_absent'
  | 'notarization_ticket_absent'
  | 'gatekeeper_rejected'
  | 'update_public_key_absent'
  | 'bundle_window_unreachable'
  | 'bundle_file_unserved';

/** What one declared window's two files did when the packaged scheme was asked for them. */
export interface BundleWindowServing {
  readonly page: string;
  readonly entry: string;
  readonly pageStatus: number;
  readonly scriptStatus: number;
  /** Every `<script src>` the packaged page carries, and what the scheme answers. */
  readonly pageScripts: readonly { readonly src: string; readonly status: number }[];
  /** The page's script tags include the entry its window declares. */
  readonly declaredEntryLoaded: boolean;
}

export interface BundleServingReport {
  readonly windows: readonly BundleWindowServing[];
  /** Files inside the packaged renderer directory the closed map will not serve. */
  readonly unserved: readonly string[];
  readonly ok: boolean;
}

/** The packaged renderer directory, as the two operations this check needs. */
export interface PackagedRenderer {
  /** Renderer-relative names the bundle holds, e.g. `index.html`. */
  list(): readonly string[];
  read(rendererRelativePath: string): Promise<Uint8Array>;
}

export interface VerificationReport {
  readonly appPath: string;
  readonly stamp: ReleaseStamp | null;
  readonly bundleIdentifier: string | null;
  readonly bundleShortVersion: string | null;
  readonly architecture: string | null;
  readonly fuses: FuseComparison | null;
  readonly entitlements: EntitlementComparison | null;
  readonly adHoc: boolean;
  readonly developerIdAuthority: boolean;
  readonly hardenedRuntime: boolean;
  readonly secureTimestamp: boolean;
  readonly teamIdentifier: string | null;
  readonly stapled: boolean;
  readonly gatekeeper: string | null;
  /** Read out of the packed JavaScript, not out of the stamp. */
  readonly embeddedUpdatePublicKey: string;
  readonly usageDescriptions: readonly string[];
  /** Null only when the asar could not be opened at all. */
  readonly bundleServing: BundleServingReport | null;
}

export interface VerificationOutcome {
  readonly ok: boolean;
  readonly failures: readonly VerificationFailure[];
  readonly report: VerificationReport;
}

export interface VerifyOptions {
  readonly mode: 'integrity' | 'release';
  /** The commit the bundle must claim. Usually HEAD of the release checkout. */
  readonly expectedCommitSha?: string;
  readonly expectedAppVersion?: string;
}

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Ran {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function verifyPackagedApp(appPath: string, options: VerifyOptions): Promise<VerificationOutcome> {
  const failures: VerificationFailure[] = [];
  const fail = (code: VerificationFailure): void => {
    if (!failures.includes(code)) failures.push(code);
  };

  const contents = join(appPath, 'Contents');
  const asarPath = join(contents, 'Resources', 'app.asar');
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    return { ok: false, failures: ['app_missing'], report: emptyReport(appPath) };
  }
  if (!existsSync(asarPath)) {
    return { ok: false, failures: ['asar_missing'], report: emptyReport(appPath) };
  }

  const { stamp, packedMain } = readFromAsar(asarPath);
  if (stamp === null) fail('stamp_unreadable');

  // Every declared window, asked of the packaged bundle through the handler the app
  // installs. Not an Apple question, so it is checked in both modes: a build whose
  // windows 404 is broken whoever signed it.
  let bundleServing: BundleServingReport | null = null;
  try {
    bundleServing = await checkBundleServing(packagedRenderer(asarPath));
  } catch {
    bundleServing = null;
  }
  if (bundleServing === null || bundleServing.windows.some(window => !windowServed(window))) {
    fail('bundle_window_unreachable');
  }
  if (bundleServing !== null && bundleServing.unserved.length > 0) fail('bundle_file_unserved');
  if (stamp !== null && options.expectedCommitSha !== undefined && stamp.commitSha !== options.expectedCommitSha) {
    fail('stamp_commit_mismatch');
  }

  const plistPath = join(contents, 'Info.plist');
  const bundleIdentifier = plistValue(plistPath, 'CFBundleIdentifier');
  const bundleShortVersion = plistValue(plistPath, 'CFBundleShortVersionString');
  if (bundleIdentifier !== APP_BUNDLE_ID) fail('bundle_identifier_unexpected');
  const expectedVersion = options.expectedAppVersion ?? stamp?.appVersion;
  if (expectedVersion !== undefined && bundleShortVersion !== expectedVersion) fail('bundle_version_mismatch');
  if (plistValue(plistPath, 'NSAppTransportSecurity.NSAllowsArbitraryLoads') !== 'false') {
    fail('ats_arbitrary_loads_allowed');
  }
  if (plistValue(plistPath, 'CFBundleURLTypes.0.CFBundleURLSchemes.0') !== APP_URL_SCHEME) {
    fail('url_scheme_unregistered');
  }

  // A usage description is a capability the app asks macOS to offer. The list is
  // exactly the one folder a verified update is staged in, and nothing else.
  let usageDescriptions: readonly string[] = [];
  try {
    usageDescriptions = usageDescriptionKeys(plistPath);
  } catch {
    usageDescriptions = [];
  }
  if (usageDescriptions.join(',') !== [...ALLOWED_USAGE_DESCRIPTIONS].sort().join(',')) {
    fail('info_plist_claims_unused_capabilities');
  }

  const executable = join(contents, 'MacOS', plistValue(plistPath, 'CFBundleExecutable') ?? 'Callie');
  const architecture = existsSync(executable) ? run('/usr/bin/lipo', ['-archs', executable]).stdout.trim() : null;
  if (architecture !== 'arm64') fail('architecture_not_arm64');

  const fuses = await readFuses(appPath);
  if (fuses === null || !fuses.ok) fail('fuse_mismatch');

  // `--deep --strict` recomputes the sealed resources, so a byte changed inside the
  // asar after signing fails here. That is the tamper check; nothing we invented.
  if (run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]).status !== 0) {
    fail('signature_invalid');
  }

  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]).stderr;
  const adHoc = /^Signature=adhoc$/m.test(details);
  const developerIdAuthority = /^Authority=Developer ID Application:/m.test(details);
  const hardenedRuntime = /^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime.*\)/m.test(details);
  const secureTimestamp = /^Timestamp=/m.test(details);
  const teamMatch = /^TeamIdentifier=(.+)$/m.exec(details);
  const teamIdentifier = teamMatch === null || teamMatch[1] === 'not set' ? null : (teamMatch[1] ?? null);

  const entitlements = readEntitlements(appPath);
  if (entitlements === null || !entitlements.ok) fail('entitlements_wrong');

  const stapled = run('/usr/bin/xcrun', ['stapler', 'validate', appPath]).status === 0;
  const assessed = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', appPath]);
  const gatekeeper = `${assessed.stdout}${assessed.stderr}`.trim() || null;

  const embeddedUpdatePublicKey =
    stamp !== null && stamp.updatePublicKey.length > 0 && packedMain.includes(JSON.stringify(stamp.updatePublicKey))
      ? stamp.updatePublicKey
      : '';

  if (options.mode === 'release') {
    if (stamp === null || stamp.channel !== 'release') fail('stamp_channel_not_release');
    if (adHoc) fail('signature_adhoc');
    if (!developerIdAuthority) fail('authority_not_developer_id');
    if (!hardenedRuntime) fail('hardened_runtime_absent');
    if (!secureTimestamp) fail('secure_timestamp_absent');
    if (teamIdentifier === null) fail('team_identifier_absent');
    if (!stapled) fail('notarization_ticket_absent');
    if (assessed.status !== 0 || !/source=Notarized Developer ID/.test(gatekeeper ?? '')) fail('gatekeeper_rejected');
    if (embeddedUpdatePublicKey.length === 0) fail('update_public_key_absent');
  }

  return {
    ok: failures.length === 0,
    failures,
    report: {
      appPath,
      stamp,
      bundleIdentifier,
      bundleShortVersion,
      architecture,
      fuses,
      entitlements,
      adHoc,
      developerIdAuthority,
      hardenedRuntime,
      secureTimestamp,
      teamIdentifier,
      stapled,
      gatekeeper,
      embeddedUpdatePublicKey,
      usageDescriptions,
      bundleServing,
    },
  };
}

/** Where the bundle's pages and scripts live inside the asar. */
const RENDERER_DIRECTORY = 'renderer';

/**
 * Does every window actually load out of this bundle? (G13b deliverable 3.)
 *
 * G9 made `BUNDLE_WINDOWS` the one declaration three things read, which makes "a
 * declared window is in the scheme's map" structurally true. It cannot make either of
 * the two statements that are about the *artifact*:
 *
 *   * the file a window names is inside the asar — a copy step that silently skipped
 *     one leaves a window that 404s on a Mac and nowhere else;
 *   * nothing is inside the asar that the closed map refuses to serve — which is the
 *     exact shape of the bug G9 fixed, five pages shipped and three paths answered.
 *
 * Both are asked through `answerBundleRequest`, the handler the packaged app itself
 * installs, so this is the same 404 a person would get rather than a second opinion
 * about it. The archive arrives as two functions so the gate can run this against a
 * fabricated bundle and the host layer against a real one.
 */
export async function checkBundleServing(bundle: PackagedRenderer): Promise<BundleServingReport> {
  const read = async (path: string): Promise<Uint8Array> => await bundle.read(path);
  const statusOf = async (file: string): Promise<number> =>
    (await answerBundleRequest('', `${BUNDLE_ORIGIN}/${file}`, read)).status;

  const windows: BundleWindowServing[] = [];
  for (const window of BUNDLE_WINDOWS) {
    const pageStatus = await statusOf(window.page);
    const scriptStatus = await statusOf(`${window.entry}.js`);
    const pageScripts: { readonly src: string; readonly status: number }[] = [];
    if (pageStatus === 200) {
      const html = new TextDecoder().decode(await bundle.read(window.page));
      for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gu)) {
        const src = match[1] ?? '';
        // A page's own relative reference. Anything that is not a name in the map —
        // an absolute URL, another origin, a path that climbs — answers 404 here for
        // the same reason Chromium would refuse it under `script-src 'self'`.
        pageScripts.push({ src, status: await statusOf(src.replace(/^\.\//u, '')) });
      }
    }
    windows.push({
      page: window.page,
      entry: window.entry,
      pageStatus,
      scriptStatus,
      pageScripts,
      declaredEntryLoaded: pageScripts.some(script => script.src === `./${window.entry}.js`),
    });
  }

  const unserved: string[] = [];
  for (const file of bundle.list()) {
    if ((await statusOf(file)) !== 200) unserved.push(file);
  }

  return { windows, unserved, ok: windows.every(windowServed) && unserved.length === 0 };
}

/** One window is served when its page loads, its script loads, and the page loads it. */
export function windowServed(window: BundleWindowServing): boolean {
  return (
    window.pageStatus === 200 &&
    window.scriptStatus === 200 &&
    window.declaredEntryLoaded &&
    window.pageScripts.length > 0 &&
    window.pageScripts.every(script => script.status === 200)
  );
}

/**
 * The renderer directory as it exists inside the packed archive.
 *
 * `listPackage` reports directories as well as files, so each entry is stated: a
 * directory under `renderer/` is not a servable name, and reporting one as unserved
 * would be a finding about the archive's shape rather than about the windows.
 */
function packagedRenderer(asarPath: string): PackagedRenderer {
  const asar = require('@electron/asar') as typeof AsarModule;
  const prefix = `/${RENDERER_DIRECTORY}/`;
  return {
    list: () =>
      asar
        .listPackage(asarPath, { isPack: false })
        .filter(entry => entry.startsWith(prefix))
        .map(entry => entry.slice(prefix.length))
        .filter(name => {
          if (name.length === 0) return false;
          try {
            return !('files' in asar.statFile(asarPath, join(RENDERER_DIRECTORY, name)));
          } catch {
            return false;
          }
        }),
    read: async name =>
      await Promise.resolve(new Uint8Array(asar.extractFile(asarPath, join(RENDERER_DIRECTORY, name)))),
  };
}

function emptyReport(appPath: string): VerificationReport {
  return {
    appPath,
    stamp: null,
    bundleIdentifier: null,
    bundleShortVersion: null,
    architecture: null,
    fuses: null,
    entitlements: null,
    adHoc: false,
    developerIdAuthority: false,
    hardenedRuntime: false,
    secureTimestamp: false,
    teamIdentifier: null,
    stapled: false,
    gatekeeper: null,
    embeddedUpdatePublicKey: '',
    usageDescriptions: [],
    bundleServing: null,
  };
}

function readFromAsar(asarPath: string): { stamp: ReleaseStamp | null; packedMain: string } {
  const asar = require('@electron/asar') as typeof AsarModule;
  let stamp: ReleaseStamp | null = null;
  let packedMain = '';
  try {
    stamp = validateReleaseStamp(JSON.parse(asar.extractFile(asarPath, RELEASE_STAMP_FILE).toString('utf8')));
  } catch {
    stamp = null;
  }
  try {
    packedMain = asar.extractFile(asarPath, join('main', 'main.js')).toString('utf8');
  } catch {
    packedMain = '';
  }
  return { stamp, packedMain };
}

function plistValue(plistPath: string, key: string): string | null {
  const result = run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The fuse wire, read out of the shipped binary.
 *
 * Through the library rather than through `electron-fuses read`: the package
 * exports only its index, so the bin has no resolvable subpath, and the library
 * returns the states as values instead of as coloured English.
 */
async function readFuses(appPath: string): Promise<FuseComparison | null> {
  const { getCurrentFuseWire, FuseState, FuseV1Options } = await import('@electron/fuses');
  let wire;
  try {
    wire = await getCurrentFuseWire(appPath);
  } catch {
    return null;
  }
  const found: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(wire)) {
    const names = FuseV1Options as unknown as Record<number, string | undefined>;
    const name: unknown = names[Number(key)];
    // Anything only "inherited" was never decided by this build, and counts as off.
    if (typeof name === 'string') found[name] = value === FuseState.ENABLE;
  }
  return compareFuses(found);
}

function readEntitlements(appPath: string): EntitlementComparison | null {
  const result = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', appPath]);
  if (result.status !== 0) return null;
  // codesign prints the plist on standard output and its running commentary on
  // standard error.
  return compareEntitlements(parseEntitlementsPlist(result.stdout));
}

/** `node --experimental-strip-types apps/desktop/scripts/verifyPackage.ts <app> [--integrity]` */
async function main(): Promise<void> {
  const [, , target, ...rest] = process.argv;
  if (target === undefined) throw new Error('PACKAGE: give the path to the .app to verify.');
  const outcome = await verifyPackagedApp(resolve(target), {
    mode: rest.includes('--integrity') ? 'integrity' : 'release',
    ...(process.env['FSS_EXPECTED_COMMIT_SHA'] === undefined
      ? {}
      : { expectedCommitSha: process.env['FSS_EXPECTED_COMMIT_SHA'] }),
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (!outcome.ok) {
    console.error(`PACKAGE: refused — ${outcome.failures.join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
