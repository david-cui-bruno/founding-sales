/**
 * Which credentials a macOS build has, and what it may therefore produce.
 *
 * No signing identity, notarization credential or Apple account exists on this
 * machine or in CI. Every step of the real path is written here and in
 * `package.ts`, and every one of them fails closed: without the named variables the
 * build refuses, and the refusal names the variables rather than describing them.
 *
 * Two rules hold everywhere in this file.
 *
 * **A value never leaves.** `describeSigningPlan` is the only thing that prints, and
 * it prints variable names, a mode and the word "configured". A test asserts that no
 * value from the environment appears in its output, because the one place a
 * credential leaks from a CI job is a log line somebody added while debugging.
 *
 * **The smoke mode is a different mode, not a weaker release.** `local-smoke` has to
 * be asked for by name. It never appears as a fallback when a credential is missing,
 * it never signs with a Developer ID, and the stamp it writes makes the verifier
 * refuse it as a release (`verifyPackage.ts`).
 */

/** What the build itself needs. Present in CI as repository secrets, or locally in a shell. */
export const BUILD_RELEASE_VARIABLES = [
  'FSS_MAC_SIGNING_IDENTITY',
  'FSS_MAC_TEAM_ID',
  'FSS_APPLE_ID',
  'FSS_APPLE_APP_SPECIFIC_PASSWORD',
  'FSS_UPDATE_PUBLIC_KEY',
] as const;

/**
 * What only the workflow needs: the certificate to put in the runner's temporary
 * keychain, and the key that signs the update manifest at publish time. A release
 * built on a Mac that already holds the certificate needs none of these.
 */
export const CI_ONLY_RELEASE_VARIABLES = [
  'FSS_MAC_CERTIFICATE_P12',
  'FSS_MAC_CERTIFICATE_PASSWORD',
  'FSS_MAC_KEYCHAIN_PASSWORD',
  'FSS_UPDATE_SIGNING_KEY',
] as const;

export const PACKAGE_MODE_VARIABLE = 'FSS_DESKTOP_PACKAGE_MODE';

export interface ReleaseSigningPlan {
  readonly kind: 'release';
  readonly identity: string;
  readonly teamId: string;
  readonly appleId: string;
  readonly appSpecificPassword: string;
  readonly updatePublicKey: string;
}

export interface LocalSmokePlan {
  readonly kind: 'local_smoke';
  /** Usually empty. A smoke build with a key can still be pointed at a test channel. */
  readonly updatePublicKey: string;
}

export interface SigningRefusal {
  readonly kind: 'refused';
  readonly reason:
    | 'release_signing_credentials_absent'
    | 'signing_identity_not_developer_id'
    | 'team_id_malformed'
    | 'package_mode_unknown';
  /** Variable names only. Never a value. */
  readonly missing: readonly string[];
}

export type SigningPlan = ReleaseSigningPlan | LocalSmokePlan | SigningRefusal;

export type Environment = Readonly<Record<string, string | undefined>>;

const present = (environment: Environment, name: string): string | null => {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? null : value;
};

export function resolveSigningPlan(environment: Environment): SigningPlan {
  const mode = present(environment, PACKAGE_MODE_VARIABLE) ?? 'release';
  if (mode !== 'release' && mode !== 'local-smoke') {
    return { kind: 'refused', reason: 'package_mode_unknown', missing: [] };
  }

  if (mode === 'local-smoke') {
    return { kind: 'local_smoke', updatePublicKey: present(environment, 'FSS_UPDATE_PUBLIC_KEY') ?? '' };
  }

  const missing = BUILD_RELEASE_VARIABLES.filter(name => present(environment, name) === null);
  if (missing.length > 0) return { kind: 'refused', reason: 'release_signing_credentials_absent', missing };

  const identity = present(environment, 'FSS_MAC_SIGNING_IDENTITY') ?? '';
  // "Apple Development" signs a build for the developer's own Mac and cannot be
  // notarized; "-" is ad-hoc. Either would produce something that fails on the
  // first Mac that is not the one that built it, and would fail it at launch
  // rather than here.
  if (!identity.startsWith('Developer ID Application:')) {
    return { kind: 'refused', reason: 'signing_identity_not_developer_id', missing: [] };
  }

  const teamId = present(environment, 'FSS_MAC_TEAM_ID') ?? '';
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return { kind: 'refused', reason: 'team_id_malformed', missing: [] };

  return {
    kind: 'release',
    identity,
    teamId,
    appleId: present(environment, 'FSS_APPLE_ID') ?? '',
    appSpecificPassword: present(environment, 'FSS_APPLE_APP_SPECIFIC_PASSWORD') ?? '',
    updatePublicKey: present(environment, 'FSS_UPDATE_PUBLIC_KEY') ?? '',
  };
}

/** The only description of a plan that is ever printed. */
export function describeSigningPlan(plan: SigningPlan): string {
  switch (plan.kind) {
    case 'release':
      return [
        'mode: release',
        'signing identity: configured (Developer ID Application)',
        'notarization: configured (notarytool, Apple ID and app-specific password)',
        'update public key: embedded',
      ].join('\n');
    case 'local_smoke':
      return [
        'mode: local-smoke — an ad-hoc signature for a build that runs on this Mac only.',
        'This is not a release, and the package verifier refuses it as one.',
        `update public key: ${plan.updatePublicKey.length === 0 ? 'absent (every update will be refused)' : 'embedded'}`,
      ].join('\n');
    case 'refused':
      return [
        `refused: ${plan.reason}`,
        plan.missing.length === 0
          ? 'no variable is missing; the values present do not describe a releasable configuration.'
          : `absent: ${plan.missing.join(', ')}`,
        `set every one of: ${[...BUILD_RELEASE_VARIABLES].join(', ')}`,
        `or ask for the smoke build explicitly: ${PACKAGE_MODE_VARIABLE}=local-smoke`,
      ].join('\n');
  }
}
