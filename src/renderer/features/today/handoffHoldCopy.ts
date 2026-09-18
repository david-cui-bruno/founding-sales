import { territoryHoldMessage } from '../../../shared/contracts/territoryClearanceContract';

/**
 * D6 hold text for the dial path. A refusal reaches Today as a short code from
 * three independent places: the phone launcher and its capability inspection
 * (`src/main/communications/phoneHandoffLauncher.ts`), the delegated handoff
 * (`createDelegatedPhoneHandoff`), and the route authorization in
 * `src/main/domain/accounts/accountOutreach.ts` (including the outbound
 * authorization reason codes it forwards). This module is the one place that
 * turns those codes into a sentence David can act on.
 *
 * Pure and total. It reads no state, performs no IO, and never grants, retries
 * or excuses anything: every sentence describes a call that did NOT happen.
 * The two territory holds reuse lane 25's exact `territoryHoldMessage` text so
 * Today and the territory screen never disagree, and an unrecognized code is
 * reported as unrecognized rather than guessed at or rendered raw.
 */

/** `state_clearance_missing` and `jurisdiction_unknown` are answered by lane 25's text, so they are absent here. */
const HOLD_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // Launcher and capability inspection.
  phone_route_unverified: 'this Mac has no verified phone route, so Callie cannot dial',
  no_route: 'the verified phone route was not current at the moment of the call, so Callie did not dial',
  invalid_target: 'the saved number is not a number Callie will dial',
  handoff_uncertain: 'the phone handoff result is unknown; do not redial from here',
  inbound_safety_unwired: 'inbound safety is not wired on this Mac',
  channel_unavailable: 'this channel is not available on this Mac',
  not_integrated: 'this channel is not integrated on this Mac',
  workspace_inactive: 'this workspace is not active',
  // Delegated handoff (createDelegatedPhoneHandoff).
  phone_unconfigured: 'phone handoff is not configured on this Mac',
  workspace_mismatch: 'this request belongs to a different workspace',
  owner_acknowledgment_missing: 'the worker did not acknowledge this request',
  owner_acknowledgment_mismatch: 'the worker acknowledged a different request',
  owner_unavailable: 'current worker evidence is unavailable or incomplete',
  operation_interrupted: 'the request was interrupted before a result was known',
  command_conflict: 'another request is already in flight for this command',
  account_route_unavailable: 'the saved phone route was not authorized at the moment of the call',
  // Route authorization (accountOutreach).
  email_execution_unavailable: 'email is not executable from here',
  stale_route: 'the saved route changed since this request was reviewed',
  stale_evidence: 'the saved company evidence changed since this request was reviewed',
  route_not_business: 'this route is not a business route',
  route_unverified: 'this number has no saved source behind it',
  account_policy_evidence_unavailable: 'no calling policy evidence is saved for this route',
  account_policy_evidence_stale: 'the saved calling policy evidence no longer matches this route',
  account_policy_evidence_invalid: 'the saved calling policy evidence could not be read',
  account_or_route_opted_out: 'this firm or this number is suppressed',
  account_owner_changed: 'ownership of this company changed since this request was reviewed',
  manual_acknowledgment_unavailable: 'the prepared handoff is missing or already consumed',
  manual_acknowledgment_mismatch: 'the prepared handoff does not match this request',
  // Outbound command service.
  stale_contact: 'the saved contact changed since this request was reviewed',
  cycle_not_executable: 'this sales cycle is not executable',
  command_evidence_invalid: 'the evidence behind this command could not be read',
  outbound_busy: 'another outbound request is already running',
  result_not_persisted: 'the result could not be saved, so it is treated as unknown',
  // Outbound authorization reason codes.
  person_or_handle_opted_out: 'this person or number is suppressed',
  channel_contact_kind_mismatch: 'the saved contact is not a phone contact',
  contact_validation_unusable: 'the saved number is not in a usable form',
  federal_status_unknown: 'this number was never checked against the federal registry',
  federal_dnc_listed: 'this number is on the federal do-not-call registry',
  federal_evidence_stale: 'the federal registry check on this number has expired',
  federal_area_code_mismatch: 'the federal check does not cover this area code',
  tcpa_status_unknown: 'the TCPA status of this number is unknown',
  tcpa_blocked: 'this number is TCPA blocked',
  jurisdiction_blocked: 'calling is blocked in this firm\'s jurisdiction',
  state_registration_missing: 'no state telemarketing registration is recorded for this state',
  state_dnc_subscription_missing: 'no state do-not-call subscription is recorded for this state',
  state_consent_rule_unknown: 'the consent rule for this state is unknown',
  outside_recipient_window: 'it is outside the calling window where this firm is',
});

const TERRITORY = new Set(['state_clearance_missing', 'jurisdiction_unknown']);
/** Every reason this module answers. Exported so a test can prove none was left behind. */
export const HANDOFF_HOLD_REASONS: readonly string[] = Object.freeze([...Object.keys(HOLD_TEXT), ...TERRITORY]);

const CODE = /^[a-z0-9_]{1,64}$/;
const STATE = /^[A-Z]{2}$/;

/**
 * `reason` is the refusal code. A territory hold may arrive with the state in
 * `detail`, or encoded as `state_clearance_missing:MA` when the receipt that
 * carried it has no room for a separate field. Anything that is not a plain
 * code or a two-letter state is dropped, never echoed into the DOM.
 */
export function describeHandoffHold(reason: string, detail?: string | null): string {
  const raw = typeof reason === 'string' ? reason : '';
  const separator = raw.indexOf(':');
  const code = separator === -1 ? raw : raw.slice(0, separator);
  const encoded = separator === -1 ? '' : raw.slice(separator + 1);
  if (TERRITORY.has(code)) {
    const candidate = typeof detail === 'string' && detail.length > 0 ? detail : encoded;
    return territoryHoldMessage({
      reason: code as 'state_clearance_missing' | 'jurisdiction_unknown',
      state: STATE.test(candidate) ? candidate : null,
    });
  }
  const text = HOLD_TEXT[code];
  if (text) return `Held: ${text}`;
  return `Held: the call was refused with a reason this screen does not recognize (${CODE.test(raw) ? raw : 'unreadable'})`;
}
