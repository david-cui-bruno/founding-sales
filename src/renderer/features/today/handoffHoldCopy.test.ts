import { describe, expect, it } from 'vitest';
import { outboundAuthorizationReasonCodeSchema } from '../../../shared/contracts/commonContract';
import { territoryHoldMessage } from '../../../shared/contracts/territoryClearanceContract';
import { HANDOFF_HOLD_REASONS, describeHandoffHold } from './handoffHoldCopy';

/** Every refusal code the launcher, the delegated handoff and accountOutreach can return. */
const launcher = ['phone_route_unverified', 'no_route', 'invalid_target', 'handoff_uncertain', 'inbound_safety_unwired',
  'channel_unavailable', 'not_integrated', 'workspace_inactive'];
const delegated = ['phone_unconfigured', 'workspace_mismatch', 'owner_acknowledgment_missing', 'owner_acknowledgment_mismatch',
  'owner_unavailable', 'operation_interrupted', 'command_conflict', 'account_route_unavailable'];
const outreach = ['email_execution_unavailable', 'stale_route', 'stale_evidence', 'route_not_business', 'route_unverified',
  'account_policy_evidence_unavailable', 'account_policy_evidence_stale', 'account_policy_evidence_invalid',
  'account_or_route_opted_out', 'account_owner_changed', 'manual_acknowledgment_unavailable', 'manual_acknowledgment_mismatch'];
const outbound = ['stale_contact', 'cycle_not_executable', 'command_evidence_invalid', 'outbound_busy', 'result_not_persisted'];
const every = [...new Set([...launcher, ...delegated, ...outreach, ...outbound,
  ...outboundAuthorizationReasonCodeSchema.options, 'state_clearance_missing'])];

describe('describeHandoffHold', () => {
  it('returns lane 25 territory text for the two territory holds, with the state from the detail or the encoded reason', () => {
    expect(describeHandoffHold('state_clearance_missing', 'MA')).toBe(territoryHoldMessage({ reason: 'state_clearance_missing', state: 'MA' }));
    expect(describeHandoffHold('state_clearance_missing', 'MA')).toBe('Held: no clearance confirmed for MA');
    expect(describeHandoffHold('state_clearance_missing:MA')).toBe('Held: no clearance confirmed for MA');
    expect(describeHandoffHold('state_clearance_missing')).toBe(territoryHoldMessage({ reason: 'state_clearance_missing', state: null }));
    expect(describeHandoffHold('jurisdiction_unknown')).toBe(territoryHoldMessage({ reason: 'jurisdiction_unknown', state: null }));
    expect(describeHandoffHold('jurisdiction_unknown', 'RI')).toBe('Held: this firm\'s state could not be read from its listing');
    // An explicit detail wins over the encoded suffix; neither is ever rendered raw.
    expect(describeHandoffHold('state_clearance_missing:RI', 'MA')).toBe('Held: no clearance confirmed for MA');
  });

  it('names every refusal reason the dial path can return in plain words', () => {
    for (const reason of every) {
      const text = describeHandoffHold(reason);
      expect(text, reason).toMatch(/^Held: \S/);
      expect(text, reason).not.toContain(reason);
      expect(text.length, reason).toBeLessThanOrEqual(200);
    }
    expect([...HANDOFF_HOLD_REASONS].sort()).toEqual([...every].sort());
  });

  it('stays honest and safe for an unrecognized, malformed or unsafe reason', () => {
    expect(describeHandoffHold('invented_reason')).toBe('Held: the call was refused with a reason this screen does not recognize (invented_reason)');
    expect(describeHandoffHold('/Users/founder/private')).toBe('Held: the call was refused with a reason this screen does not recognize (unreadable)');
    expect(describeHandoffHold('a'.repeat(65))).toBe('Held: the call was refused with a reason this screen does not recognize (unreadable)');
    expect(describeHandoffHold('')).toBe('Held: the call was refused with a reason this screen does not recognize (unreadable)');
    expect(describeHandoffHold(undefined as unknown as string)).toBe('Held: the call was refused with a reason this screen does not recognize (unreadable)');
    expect(describeHandoffHold('state_clearance_missing', '/Users/founder')).toBe(territoryHoldMessage({ reason: 'state_clearance_missing', state: null }));
  });
});
