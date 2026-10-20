import { describe, expect, it } from 'vitest';
import { dialCheckResponseSchema } from '../src/dial.ts';
import { phoneHandoffResultSchema, reservePhoneHandoffCommandSchema } from '../src/phoneHandoff.ts';
import { NATIONAL_DNC_COVERED_AREA_CODES, NATIONAL_DNC_UNCHECKED_WARNING, nationalDncDisclosureSchema, unknownNationalDncDisclosure } from '../src/nationalDnc.ts';

const id = '11111111-1111-4111-8111-111111111111';
const risk = { status: 'not_checked_owner_risk', basis: 'verified_business_office', receiptId: id, warning: NATIONAL_DNC_UNCHECKED_WARNING };

describe('national DNC evidence disclosure', () => {
  it('pins the subscribed codes, not a Texas proposal or firm geography', () => {
    expect(NATIONAL_DNC_COVERED_AREA_CODES).toEqual(['401', '508', '617', '774', '857']);
  });
  it('keeps unknown, actual clear and receipted unchecked evidence distinct', () => {
    expect(nationalDncDisclosureSchema.parse(unknownNationalDncDisclosure()).status).toBe('unknown');
    expect(nationalDncDisclosureSchema.parse({ status: 'checked_clear', basis: 'registry', receiptId: null, warning: null }).status).toBe('checked_clear');
    expect(nationalDncDisclosureSchema.parse(risk)).toEqual(risk);
    expect(nationalDncDisclosureSchema.parse({ ...risk, basis: 'owner_self_test' }).basis).toBe('owner_self_test');
    for (const patch of [{ warning: null }, { warning: 'DNC cleared' }, { receiptId: null }, { basis: 'registry' }, { status: 'checked_clear' }]) {
      expect(nationalDncDisclosureSchema.safeParse({ ...risk, ...patch }).success).toBe(false);
    }
    expect(nationalDncDisclosureSchema.safeParse({ ...unknownNationalDncDisclosure(), receiptId: id }).success).toBe(false);
  });
  it('does not manufacture a positive disclosure on legacy advice', () => {
    const advice = { firmId: id, callable: false, reasons: ['dnc_coverage_unknown'], routeId: null, e164: null, telUri: null, firmTimeZone: null, firmLocalTime: null, at: '2026-10-19T22:15:32Z' };
    expect(dialCheckResponseSchema.parse({ advice }).advice).not.toHaveProperty('nationalDnc');
    expect(dialCheckResponseSchema.parse({ advice: { ...advice, nationalDnc: risk } }).advice.nationalDnc).toEqual(risk);
  });
  it('carries the exact warning without turning it into a request-side capability', () => {
    const request = { commandId: id, clientVersion: '1.0.56', firmId: id, routeId: id, routeVersion: 1 };
    expect(reservePhoneHandoffCommandSchema.parse({ ...request, expectedNationalDncReceiptId: id }).expectedNationalDncReceiptId).toBe(id);
    expect(reservePhoneHandoffCommandSchema.safeParse({ ...request, bypassDnc: true }).success).toBe(false);
    const fresh = { attemptId: id, firmId: id, routeId: id, reservedAt: '2026-10-19T22:15:32Z', expiresAt: '2026-10-19T22:15:47Z', actionable: true, e164: '+14015550187', telUri: 'tel:+14015550187', validForMilliseconds: 15000 };
    expect(phoneHandoffResultSchema.parse(fresh)).not.toHaveProperty('nationalDnc');
    expect(phoneHandoffResultSchema.parse({ ...fresh, nationalDnc: risk })).toHaveProperty('nationalDnc', risk);
    expect(phoneHandoffResultSchema.safeParse({ ...fresh, bypassDnc: true }).success).toBe(false);
  });
});
