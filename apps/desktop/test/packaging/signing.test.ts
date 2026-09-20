import { describe, expect, it } from 'vitest';
import {
  BUILD_RELEASE_VARIABLES,
  CI_ONLY_RELEASE_VARIABLES,
  describeSigningPlan,
  resolveSigningPlan,
} from '../../scripts/signing.ts';

/**
 * G13a's hardest constraint: no signing identity, no notarization credential and no
 * Apple account exist on this machine or in CI. Every step of the real path is
 * written, and every step of it has to fail closed and say which named variable is
 * absent — without ever printing what one of them contains.
 *
 * The values below are made up in the test. None of them is a credential, and the
 * point of the last case is that nothing that *looks* like one ever reaches a log.
 */

const fullEnvironment = {
  FSS_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example Co (Z9Z9Z9Z9Z9)',
  FSS_MAC_TEAM_ID: 'Z9Z9Z9Z9Z9',
  FSS_APPLE_ID: 'releases@example.invalid',
  FSS_APPLE_APP_SPECIFIC_PASSWORD: 'wwww-xxxx-yyyy-zzzz',
  FSS_UPDATE_PUBLIC_KEY: 'MCowBQYDK2VwAyEAdGhpcyBpcyBub3QgYSByZWFsIHB1YmxpYyBrZXk=',
} as const;

describe('a release build refuses to start without the whole Apple path', () => {
  it('names every variable it needs when the environment is empty', () => {
    const plan = resolveSigningPlan({});

    expect(plan).toEqual({
      kind: 'refused',
      reason: 'release_signing_credentials_absent',
      missing: [...BUILD_RELEASE_VARIABLES],
    });
  });

  it('names only the variables actually absent', () => {
    const plan = resolveSigningPlan({ ...fullEnvironment, FSS_APPLE_APP_SPECIFIC_PASSWORD: undefined });

    expect(plan).toEqual({
      kind: 'refused',
      reason: 'release_signing_credentials_absent',
      missing: ['FSS_APPLE_APP_SPECIFIC_PASSWORD'],
    });
  });

  it('treats a blank value as absent', () => {
    expect(resolveSigningPlan({ ...fullEnvironment, FSS_MAC_TEAM_ID: '   ' })).toEqual({
      kind: 'refused',
      reason: 'release_signing_credentials_absent',
      missing: ['FSS_MAC_TEAM_ID'],
    });
  });

  it('refuses a signing identity that is not a Developer ID Application certificate', () => {
    // "Apple Development" signs a build that runs on the developer's own Mac and
    // nowhere else, and it cannot be notarized. Accepting it would produce a release
    // that fails on the first Mac that is not this one.
    expect(
      resolveSigningPlan({ ...fullEnvironment, FSS_MAC_SIGNING_IDENTITY: 'Apple Development: Someone (ABCDE12345)' }),
    ).toEqual({ kind: 'refused', reason: 'signing_identity_not_developer_id', missing: [] });
  });

  it('refuses an ad-hoc identity offered as a release', () => {
    expect(resolveSigningPlan({ ...fullEnvironment, FSS_MAC_SIGNING_IDENTITY: '-' })).toEqual({
      kind: 'refused',
      reason: 'signing_identity_not_developer_id',
      missing: [],
    });
  });

  it('refuses a team id that is not a ten-character Apple team identifier', () => {
    expect(resolveSigningPlan({ ...fullEnvironment, FSS_MAC_TEAM_ID: 'Z9Z9' })).toEqual({
      kind: 'refused',
      reason: 'team_id_malformed',
      missing: [],
    });
  });

  it('builds the release plan when every variable is there', () => {
    const plan = resolveSigningPlan(fullEnvironment);

    expect(plan).toEqual({
      kind: 'release',
      identity: fullEnvironment.FSS_MAC_SIGNING_IDENTITY,
      teamId: fullEnvironment.FSS_MAC_TEAM_ID,
      appleId: fullEnvironment.FSS_APPLE_ID,
      appSpecificPassword: fullEnvironment.FSS_APPLE_APP_SPECIFIC_PASSWORD,
      updatePublicKey: fullEnvironment.FSS_UPDATE_PUBLIC_KEY,
    });
  });
});

describe('the local smoke mode is separated from the release path', () => {
  it('needs no Apple credential at all', () => {
    expect(resolveSigningPlan({ FSS_DESKTOP_PACKAGE_MODE: 'local-smoke' })).toEqual({
      kind: 'local_smoke',
      updatePublicKey: '',
    });
  });

  it('stays local smoke even when the release variables happen to be set', () => {
    expect(resolveSigningPlan({ ...fullEnvironment, FSS_DESKTOP_PACKAGE_MODE: 'local-smoke' })).toEqual({
      kind: 'local_smoke',
      updatePublicKey: fullEnvironment.FSS_UPDATE_PUBLIC_KEY,
    });
  });

  it('refuses a mode it does not recognise rather than falling back', () => {
    expect(resolveSigningPlan({ ...fullEnvironment, FSS_DESKTOP_PACKAGE_MODE: 'release-ish' })).toEqual({
      kind: 'refused',
      reason: 'package_mode_unknown',
      missing: [],
    });
  });
});

describe('nothing a build prints contains a credential', () => {
  it('describes the release plan without any value from the environment', () => {
    const description = describeSigningPlan(resolveSigningPlan(fullEnvironment));

    for (const value of Object.values(fullEnvironment)) {
      expect(description).not.toContain(value);
    }
    expect(description).toContain('release');
    expect(description).toContain('notarization: configured');
  });

  it('describes a refusal by variable name only', () => {
    const description = describeSigningPlan(resolveSigningPlan({}));

    expect(description).toContain('FSS_MAC_SIGNING_IDENTITY');
    expect(description).toContain('release_signing_credentials_absent');
  });

  it('says out loud that a smoke build is not a release', () => {
    expect(describeSigningPlan(resolveSigningPlan({ FSS_DESKTOP_PACKAGE_MODE: 'local-smoke' }))).toContain(
      'not a release',
    );
  });
});

describe('the secret names are stated once, for the workflow and the documentation', () => {
  it('keeps the build set and the CI-only set disjoint', () => {
    const ciOnly: readonly string[] = CI_ONLY_RELEASE_VARIABLES;
    const overlap = BUILD_RELEASE_VARIABLES.filter(name => ciOnly.includes(name));
    expect(overlap).toEqual([]);
  });

  it('includes the certificate and the update signing key in the CI-only set', () => {
    expect([...CI_ONLY_RELEASE_VARIABLES]).toEqual([
      'FSS_MAC_CERTIFICATE_P12',
      'FSS_MAC_CERTIFICATE_PASSWORD',
      'FSS_MAC_KEYCHAIN_PASSWORD',
      'FSS_UPDATE_SIGNING_KEY',
    ]);
  });
});
