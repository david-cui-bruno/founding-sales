import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BUNDLE_ID, APP_PRODUCT_NAME, APP_URL_SCHEME, bundleApp } from './bundle.ts';
import { DESKTOP_ENTITLEMENTS, renderEntitlementsPlist } from './entitlements.ts';
import { DESKTOP_FUSES } from './fuses.ts';
import { buildReleaseStamp, readGitState, type ReleaseStamp } from './releaseStamp.ts';
import { describeSigningPlan, resolveSigningPlan, type Environment, type SigningPlan } from './signing.ts';

/**
 * The macOS build (G13a deliverable 1).
 *
 * Order matters, and it is the reason this is a script rather than a packager
 * configuration file. Fuses are bytes inside the executable, so burning one
 * invalidates whatever signature the executable already had; on Apple silicon an
 * invalid signature is a bundle that will not launch at all. So: stage, pack, burn,
 * sign, notarize, staple — in that order, with the signature applied last and over
 * everything.
 *
 * Nothing here has a fallback. A release build without the Apple credentials stops
 * before it writes anything, naming the variables that are absent. The smoke build
 * is a separate mode that must be asked for by name, signs ad-hoc, and stamps
 * itself so that `verifyPackage.ts` refuses it as a release.
 */

const require = createRequire(import.meta.url);

export interface PackageOptions {
  /** `apps/desktop`. */
  readonly root: string;
  readonly outDirectory: string;
  readonly env: Environment;
  readonly appVersion: string;
  readonly apiBaseUrl: string;
  readonly updateChannelUrl: string;
  readonly now?: () => Date;
}

export interface PackagedApp {
  readonly appPath: string;
  readonly stamp: ReleaseStamp;
  readonly mode: 'release' | 'local-smoke';
}

export class PackagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackagingError';
  }
}

export async function packageDesktop(options: PackageOptions): Promise<PackagedApp> {
  const plan = resolveSigningPlan(options.env);
  if (plan.kind === 'refused') throw new PackagingError(describeSigningPlan(plan));

  const repositoryRoot = resolve(options.root, '..', '..');
  const git = readGitState(repositoryRoot);
  const channel = plan.kind === 'release' ? 'release' : 'local-smoke';
  if (channel === 'release' && git.dirty) {
    throw new PackagingError(
      'PACKAGE: a release is built from a committed tree, and this one has uncommitted changes.',
    );
  }

  const stamp = buildReleaseStamp({
    channel,
    git,
    appVersion: options.appVersion,
    electronVersion: electronVersion(),
    updatePublicKey: plan.updatePublicKey,
    now: (options.now ?? (() => new Date()))(),
  });

  const staging = await mkdtemp(join(tmpdir(), 'fss-desktop-app-'));
  const entitlementsPath = join(staging, '..', `fss-entitlements-${basename(staging)}.plist`);
  try {
    await bundleApp({
      root: options.root,
      stagingDirectory: staging,
      apiBaseUrl: options.apiBaseUrl,
      updateChannelUrl: options.updateChannelUrl,
      stamp,
    });
    await writeFile(entitlementsPath, renderEntitlementsPlist(DESKTOP_ENTITLEMENTS));

    await mkdir(options.outDirectory, { recursive: true });
    const appPath = await pack(staging, options.outDirectory, stamp);
    trimInfoPlist(appPath);
    await burnFuses(appPath);
    await signBundle(appPath, entitlementsPath, plan);
    if (plan.kind === 'release') await notarizeBundle(appPath, plan);

    return { appPath, stamp, mode: channel };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(entitlementsPath, { force: true });
  }
}

function electronVersion(): string {
  const manifest = require('electron/package.json') as { version?: unknown };
  const version = manifest.version;
  if (typeof version !== 'string') throw new PackagingError('PACKAGE: electron is not installed in this tree.');
  return version;
}

async function pack(staging: string, outDirectory: string, stamp: ReleaseStamp): Promise<string> {
  const { packager } = await import('@electron/packager');
  const produced = await packager({
    dir: staging,
    out: outDirectory,
    overwrite: true,
    platform: 'darwin',
    arch: 'arm64',
    name: APP_PRODUCT_NAME,
    appBundleId: APP_BUNDLE_ID,
    appVersion: stamp.appVersion,
    buildVersion: stamp.commitSha.slice(0, 12),
    // The staged application directory has no dependencies at all, so the
    // packager cannot infer the runtime from one. It is the version installed in
    // this checkout, and the stamp records it.
    electronVersion: stamp.electronVersion,
    // Everything is bundled, so there is nothing to prune and nothing to unpack.
    asar: true,
    prune: false,
    // Signing, fuses and notarization happen below, in an order the packager
    // cannot express: it would sign before the fuses are burned. Leaving both
    // options off is what keeps the packager out of it.
    quiet: true,
    extendInfo: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
      LSMinimumSystemVersion: '13.0.0',
      // Declared so Launch Services knows the scheme exists. `main.ts` answers only
      // the exact URLs in its closed list.
      CFBundleURLTypes: [
        {
          CFBundleURLName: `${APP_BUNDLE_ID}.deep-link`,
          CFBundleTypeRole: 'Viewer',
          CFBundleURLSchemes: [APP_URL_SCHEME],
        },
      ],
      // The one folder the app ever writes outside its own container: a verified
      // update is staged in Downloads so a person can see what they are about to
      // install. Every other usage description Electron's default plist carries is
      // deleted below, because a string promising a reason to use the camera is a
      // capability the app is asking for and does not need.
      NSDownloadsFolderUsageDescription: 'Callie saves a verified update here so you can install it.',
      NSHumanReadableCopyright: 'Callie',
    },
  });

  const [directory] = produced;
  if (directory === undefined || produced.length !== 1) {
    throw new PackagingError(`PACKAGE: expected one packaged output, got ${String(produced.length)}.`);
  }
  return join(directory, `${APP_PRODUCT_NAME}.app`);
}

export const ALLOWED_USAGE_DESCRIPTIONS = Object.freeze(['NSDownloadsFolderUsageDescription']);

/**
 * Electron's stock `Info.plist` promises a reason for the camera, the microphone,
 * Bluetooth, contacts, reminders and a dozen other things. None of them is true of
 * this app, and each one is a capability macOS will offer to grant. They are
 * deleted here, before the signature covers the file.
 */
export function trimInfoPlist(appPath: string): void {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  for (const key of usageDescriptionKeys(plistPath)) {
    if (ALLOWED_USAGE_DESCRIPTIONS.includes(key)) continue;
    runOrThrow('/usr/bin/plutil', ['-remove', key, plistPath]);
  }
}

export function usageDescriptionKeys(plistPath: string): readonly string[] {
  const printed = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(printed)) as Record<string, unknown>;
  return Object.keys(parsed)
    .filter(key => key.endsWith('UsageDescription'))
    .sort();
}

async function burnFuses(appPath: string): Promise<void> {
  const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: DESKTOP_FUSES.RunAsNode,
    [FuseV1Options.EnableCookieEncryption]: DESKTOP_FUSES.EnableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: DESKTOP_FUSES.EnableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: DESKTOP_FUSES.EnableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: DESKTOP_FUSES.EnableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: DESKTOP_FUSES.OnlyLoadAppFromAsar,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: DESKTOP_FUSES.LoadBrowserProcessSpecificV8Snapshot,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: DESKTOP_FUSES.GrantFileProtocolExtraPrivileges,
    [FuseV1Options.WasmTrapHandlers]: DESKTOP_FUSES.WasmTrapHandlers,
    // The signature is applied below and covers the burned bytes; resetting an
    // ad-hoc one here would only be undone.
    resetAdHocDarwinSignature: false,
  });
}

async function signBundle(appPath: string, entitlementsPath: string, plan: SigningPlan): Promise<void> {
  if (plan.kind === 'release') {
    const { signAsync } = await import('@electron/osx-sign');
    await signAsync({
      app: appPath,
      platform: 'darwin',
      identity: plan.identity,
      // The hardened runtime is what notarization requires, and the entitlements
      // file is the one rendered from `entitlements.ts`.
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: entitlementsPath, signatureFlags: ['runtime'] }),
      // A secure timestamp from Apple's authority, so the signature outlives the
      // certificate. `codesign` fails rather than falling back when it cannot
      // reach the server, which is what we want.
      strictVerify: true,
    });
    return;
  }

  // The smoke path: ad-hoc, with the release's entitlements, and deliberately
  // without the hardened runtime.
  //
  // Not an oversight. The hardened runtime validates libraries by team
  // identifier, an ad-hoc signature has no team identifier, and each ad-hoc
  // signature is its own identity — so a hardened ad-hoc app cannot load its own
  // Electron framework, and dies in dyld before any of its code runs. The only
  // ways round that are a real Developer ID (which is the release path) or
  // `disable-library-validation` (which is on the forbidden list and would make
  // the smoke build's entitlements a lie). So the smoke build gives that one up,
  // and gains the thing a bundle that cannot launch could never prove: that the
  // fuses, the packed ESM entry point and the sandboxed preload actually start.
  //
  // `verifyPackage.ts` in release mode refuses it for this as well as for its
  // authority, its ticket and its stamp. `docs/decisions/g13-local-smoke-mode.md`.
  runOrThrow('/usr/bin/codesign', [
    '--sign',
    '-',
    '--force',
    '--deep',
    '--entitlements',
    entitlementsPath,
    '--timestamp=none',
    appPath,
  ]);
}

async function notarizeBundle(appPath: string, plan: Extract<SigningPlan, { kind: 'release' }>): Promise<void> {
  const { notarize } = await import('@electron/notarize');
  // `notarize` submits with notarytool and staples the ticket on success. Neither
  // the Apple ID nor the app-specific password is written anywhere by this call.
  await notarize({
    appPath,
    appleId: plan.appleId,
    appleIdPassword: plan.appSpecificPassword,
    teamId: plan.teamId,
  });
}

function runOrThrow(command: string, args: readonly string[]): void {
  try {
    execFileSync(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new PackagingError(`PACKAGE: ${basename(command)} failed: ${String(stderr ?? '').trim()}`);
  }
}

/** `node --experimental-strip-types apps/desktop/scripts/package.ts <out>` */
async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outDirectory = resolve(process.argv[2] ?? join(root, 'out'));
  const appVersion = process.env['FSS_DESKTOP_APP_VERSION'] ?? (await readPackageVersion(root));
  const built = await packageDesktop({
    root,
    outDirectory,
    env: process.env,
    appVersion,
    apiBaseUrl: process.env['FSS_API_BASE_URL'] ?? 'https://api.usecallie.com',
    updateChannelUrl: process.env['FSS_UPDATE_CHANNEL_URL'] ?? 'https://updates.usecallie.com/',
  });
  process.stdout.write(`${JSON.stringify({ appPath: built.appPath, mode: built.mode, stamp: built.stamp }, null, 2)}\n`);
}

async function readPackageVersion(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
