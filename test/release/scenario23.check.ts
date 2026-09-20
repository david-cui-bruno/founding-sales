import { describe, expect, it } from 'vitest';
import { AUTH_REFUSAL_CODES } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 23: "OIDC state, nonce, code and token-audience replay are refused."
 *
 * The API auth suite replays all four against a real Google fake: a state already
 * consumed, a nonce belonging to a different authorization request, a code Google
 * answers `invalid_grant` for, and an id token minted for another audience or
 * another authorized party. This check adds the validator's own shape — the order it
 * checks things in, and the fact that each of the four has a refusal code of its own.
 *
 * ## The vacuous-pass trap
 *
 * Replaying against an expired request is refused for expiry, not for replay, and
 * the two are indistinguishable from outside unless the codes differ. The lane test
 * closes it by replaying inside the validity window. This file closes the code-set
 * half: `authorization_request_unknown` and `authorization_request_expired` are
 * asserted to be two codes, so a rewrite that answered both with one would make the
 * lane test unable to tell what it had proved. The second `it` closes a nastier
 * variant — a token whose claims are read before its signature is verified would
 * report `audience_mismatch` for an unsigned forgery and look like a correct
 * refusal.
 */

describe('Appendix G 23: each replay is refused for being that replay', () => {
  mustCover(23, [
    'Appendix G 23',
    'authorization_request_unknown',
    'audience_mismatch',
    'nonce_mismatch',
  ]);

  it('gives replay and expiry separate codes, and gives each of the four its own', () => {
    for (const code of [
      'authorization_request_unknown',
      'authorization_request_expired',
      'nonce_mismatch',
      'audience_mismatch',
      'authorized_party_mismatch',
      'token_exchange_failed',
    ] as const) {
      expect(AUTH_REFUSAL_CODES).toContain(code);
    }
    expect(new Set(AUTH_REFUSAL_CODES).size).toBe(AUTH_REFUSAL_CODES.length);
  });

  it('verifies the signature before it reads a single claim', () => {
    const validator = readRepositoryFile('apps/api/src/auth/idToken.ts');
    const algorithm = validator.indexOf("refusal: 'unsupported_algorithm'");
    const signature = validator.indexOf("refusal: 'bad_signature'");
    const issuer = validator.indexOf("refusal: 'issuer_mismatch'");
    const audience = validator.indexOf("refusal: 'audience_mismatch'");
    const nonce = validator.indexOf("refusal: 'nonce_mismatch'");

    expect(algorithm).toBeGreaterThan(-1);
    // Shape, then algorithm, then signature, then claims. Nothing unsigned is ever
    // read for its claims, so `alg: none` cannot talk its way past the issuer check.
    expect(signature).toBeGreaterThan(algorithm);
    expect(issuer).toBeGreaterThan(signature);
    expect(audience).toBeGreaterThan(issuer);
    expect(nonce).toBeGreaterThan(audience);
    // Exactly our client id, and an array carrying it among others is not enough.
    expect(validator).toContain('audience.length === 1 && audience[0] === clientId');
  });
});
