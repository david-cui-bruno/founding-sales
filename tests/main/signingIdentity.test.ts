import { describe, expect, it } from 'vitest';

import { resolveMacSigningIdentity } from '../../build/signingIdentity';

const KEYCHAIN_LISTING = [
  '  1) 13F2CC8E332D02DD7308112EAA107C443C365345 "Apple Development: davidcui824@gmail.com (72PUH2RF5G)"',
  '     1 valid identities found',
].join('\n');

describe('resolveMacSigningIdentity', () => {
  it('prefers an explicit CALLIE_MAC_SIGN_IDENTITY over keychain discovery', () => {
    const identity = resolveMacSigningIdentity({
      env: { CALLIE_MAC_SIGN_IDENTITY: 'Developer ID Application: Someone (TEAM123)' },
      platform: 'darwin',
      listCodesigningIdentities: () => {
        throw new Error('must not query the keychain when env is set');
      },
    });

    expect(identity).toBe('Developer ID Application: Someone (TEAM123)');
  });

  it('treats a blank CALLIE_MAC_SIGN_IDENTITY as unset and discovers from the keychain', () => {
    const identity = resolveMacSigningIdentity({
      env: { CALLIE_MAC_SIGN_IDENTITY: '   ' },
      platform: 'darwin',
      listCodesigningIdentities: () => KEYCHAIN_LISTING,
    });

    expect(identity).toBe(
      'Apple Development: davidcui824@gmail.com (72PUH2RF5G)',
    );
  });

  it('discovers the first Apple Development identity from the keychain listing', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'darwin',
      listCodesigningIdentities: () => KEYCHAIN_LISTING,
    });

    expect(identity).toBe(
      'Apple Development: davidcui824@gmail.com (72PUH2RF5G)',
    );
  });

  it('prefers Developer ID Application identities over Apple Development ones', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'darwin',
      listCodesigningIdentities: () =>
        [
          '  1) AAAA "Apple Development: dev@example.com (TEAM111)"',
          '  2) BBBB "Developer ID Application: Ship It LLC (TEAM222)"',
          '     2 valid identities found',
        ].join('\n'),
    });

    expect(identity).toBe('Developer ID Application: Ship It LLC (TEAM222)');
  });

  it('returns undefined off macOS without querying the keychain', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'linux',
      listCodesigningIdentities: () => {
        throw new Error('must not query the keychain off macOS');
      },
    });

    expect(identity).toBeUndefined();
  });

  it('returns undefined when the keychain has no usable identities', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'darwin',
      listCodesigningIdentities: () => '     0 valid identities found',
    });

    expect(identity).toBeUndefined();
  });

  it('returns undefined when the keychain query itself fails', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'darwin',
      listCodesigningIdentities: () => {
        throw new Error('security tool unavailable');
      },
    });

    expect(identity).toBeUndefined();
  });

  it('ignores revoked or unrelated certificate kinds', () => {
    const identity = resolveMacSigningIdentity({
      env: {},
      platform: 'darwin',
      listCodesigningIdentities: () =>
        [
          '  1) CCCC "Mac Installer Distribution: Someone (TEAM333)"',
          '     1 valid identities found',
        ].join('\n'),
    });

    expect(identity).toBeUndefined();
  });
});
