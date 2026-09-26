import { describe, expect, it } from 'vitest';
import { CRM_REFUSAL_CODES as CONTRACT_CODES } from '@fss/contracts';
import { resolveFirmZone } from '../../src/rules/statePosture.ts';
import {
  ROUTE_ELIGIBILITY_POLICY,
  ROUTE_ELIGIBILITY_POLICY_VERSION,
  decideRouteEligibility,
} from '../../crm/routePolicy.ts';
import { CRM_REFUSAL_CODES } from '../../crm/types.ts';
import { FIRM_ZONE_SOURCES, postalPrefix, zoneForPostalCode } from '../../crm/zone.ts';

/**
 * The CRM's pure rules: the versioned route-eligibility policy of section 7.4 and the
 * postal source behind section 9.2's firm time-zone seam. No database, because neither
 * needs one — and both are read by `authorizeDial` and by research, so they have to be
 * decidable without one.
 */

describe('the refusal vocabulary', () => {
  it('is the same set in the domain and on the wire', () => {
    expect([...CRM_REFUSAL_CODES].sort()).toEqual([...CONTRACT_CODES].sort());
  });
});

describe('route eligibility (7.4)', () => {
  it('leaves an unvalidated route a candidate however confident the provider is', () => {
    expect(
      decideRouteEligibility({ source: 'research_provider', technicalValidation: 'unknown', associationConfidence: 0.99 }),
    ).toEqual({ eligibility: 'candidate', policyVersion: null });
  });

  it('makes a failed validation invalid rather than weak', () => {
    expect(
      decideRouteEligibility({ source: 'salesperson', technicalValidation: 'failed', associationConfidence: 1 }),
    ).toEqual({ eligibility: 'invalid', policyVersion: null });
  });

  it('keeps a validated but low-confidence provider route a candidate', () => {
    const below = ROUTE_ELIGIBILITY_POLICY.minimumAssociationConfidence - 0.01;
    expect(
      decideRouteEligibility({ source: 'research_provider', technicalValidation: 'passed', associationConfidence: below }),
    ).toEqual({ eligibility: 'candidate', policyVersion: null });
  });

  it('makes a validated, confident provider route usable and records the policy version', () => {
    expect(
      decideRouteEligibility({ source: 'research_provider', technicalValidation: 'passed', associationConfidence: 0.95 }),
    ).toEqual({ eligibility: 'usable', policyVersion: ROUTE_ELIGIBILITY_POLICY_VERSION });
  });

  it('lets a salesperson vouch for the association but not for the validation', () => {
    expect(
      decideRouteEligibility({ source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.1 }),
    ).toEqual({ eligibility: 'usable', policyVersion: ROUTE_ELIGIBILITY_POLICY_VERSION });
    expect(
      decideRouteEligibility({ source: 'salesperson', technicalValidation: 'unknown', associationConfidence: 1 }),
    ).toEqual({ eligibility: 'candidate', policyVersion: null });
  });

  it('never makes a route with no recorded confidence usable', () => {
    expect(
      decideRouteEligibility({ source: 'research_provider', technicalValidation: 'passed', associationConfidence: null }),
    ).toEqual({ eligibility: 'candidate', policyVersion: null });
  });
});

describe('the postal time-zone source (9.2)', () => {
  it('reads a three-digit prefix, and nothing shorter', () => {
    expect(postalPrefix('79901')).toBe('799');
    expect(postalPrefix('79901-1234')).toBe('799');
    expect(postalPrefix('799')).toBeNull();
  });

  it('places the Texas mountain-time prefixes and the rest of Texas apart', () => {
    expect(zoneForPostalCode('TX', '79901')).toBe('America/Denver');
    expect(zoneForPostalCode('TX', '88510')).toBe('America/Denver');
    expect(zoneForPostalCode('TX', '75201')).toBe('America/Chicago');
  });

  it('places the Florida panhandle in Central and the rest of Florida in Eastern', () => {
    expect(zoneForPostalCode('FL', '32401')).toBe('America/Chicago');
    expect(zoneForPostalCode('FL', '33101')).toBe('America/New_York');
  });

  it('answers nothing for a state whose boundary cuts through prefixes', () => {
    // Michigan, Indiana, Arizona, the Nebraska and Dakota panhandles: a three-digit
    // guess would be wrong for real firms, so the table is silent and the firm stays
    // unresolved, which blocks calling.
    for (const state of ['MI', 'IN', 'AZ', 'NE', 'ND', 'SD', 'KS', 'KY', 'TN', 'OR', 'ID', 'NV', 'AK']) {
      expect(zoneForPostalCode(state, '49855'), state).toBeNull();
    }
  });

  it('answers nothing for a single-zone state, leaving the state default to apply', () => {
    expect(zoneForPostalCode('RI', '02903')).toBeNull();
  });
});

describe('the seam the source plugs into', () => {
  it('prefers the firm postal code over the state default', () => {
    expect(resolveFirmZone({ state: 'TX', postalCode: '79901' }, FIRM_ZONE_SOURCES)).toMatchObject({
      kind: 'resolved',
      zone: 'America/Denver',
      source: 'postal',
      confidence: 'high',
    });
  });

  it('leaves a multi-zone state with no postal data unresolved rather than guessing', () => {
    expect(resolveFirmZone({ state: 'TX' }, FIRM_ZONE_SOURCES)).toMatchObject({
      kind: 'unresolved',
      reason: 'state_spans_zones',
    });
  });

  it('falls back to the single-zone state default at medium confidence', () => {
    expect(resolveFirmZone({ state: 'RI', postalCode: '02903' }, FIRM_ZONE_SOURCES)).toMatchObject({
      kind: 'resolved',
      zone: 'America/New_York',
      source: 'state_default',
      confidence: 'medium',
    });
  });
});
