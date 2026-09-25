import { describe, expect, it } from 'vitest';
import { DIAL_HOLD_REFUSAL_CODES, DIAL_REFUSAL_CODES, DIAL_REQUEST_REFUSAL_CODES } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 17: "Dial command replay after suppression, route retirement, posture
 * expiry or ticket consumption yields no allow."
 *
 * The policy suite replays a genuinely valid authorization after each of the four
 * changes and reads the refusal back. This check adds the vocabulary the four answers
 * come from: each cause has its own code, so an operator reading a log can tell which
 * of the four stopped the call, and a rewrite that collapsed them would fail here
 * even though the dial was still, technically, refused.
 *
 * ## The vacuous-pass trap
 *
 * A replay that was refused for a missing ticket proves nothing about the four
 * causes: it never reached the checks. The lane test closes that by proving the dial
 * is allowed first — `authorizeDial` returns `{ allowed: true }` on the untouched
 * input — and only then changing the world underneath it. The trap this file closes
 * is the flattening one: four causes reported as one generic refusal would satisfy
 * "yields no allow" while destroying the operator's ability to act on it, and would
 * also hide a fifth cause creeping in unnamed.
 */

describe('Appendix G 17: four causes, four refusals, and no allow', () => {
  mustCover(17, ['already_consumed', 'route_retired', 'posture_overdue']);

  it('names each of the four causes separately', () => {
    // Three of them are section 15 hold reasons, because a person can act on them;
    // the consumed ticket is a fact about the request and no control clears it.
    for (const code of ['firm_suppressed', 'route_retired', 'posture_overdue'] as const) {
      expect(DIAL_HOLD_REFUSAL_CODES).toContain(code);
    }
    expect(DIAL_REQUEST_REFUSAL_CODES).toContain('already_consumed');
    expect(new Set(DIAL_REFUSAL_CODES).size).toBe(DIAL_REFUSAL_CODES.length);
  });

  it('checks suppression before it checks the route or the posture', () => {
    // The order matters for the same reason the codes do: a suppressed firm whose
    // route also happens to be retired must be reported as suppressed, or a
    // salesperson will "fix" the route and try again.
    const authorize = readRepositoryFile('packages/domain/dial/authorize.ts');
    const suppression = authorize.indexOf('await firstSuppressed(');
    const route = authorize.indexOf('return refused(ELIGIBILITY_REFUSAL[route.eligibility]);');
    const posture = authorize.indexOf('await applicablePosture(context, firm.region_code, input.at);');
    expect(suppression).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(suppression);
    expect(posture).toBeGreaterThan(route);
  });
});
