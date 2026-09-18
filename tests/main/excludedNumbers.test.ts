import { describe, expect, it } from 'vitest';
import { isExcludedNumber } from '../../src/main/communications/excludedNumbers';
import { createPhoneHandoffLauncher } from '../../src/main/communications/phoneHandoffLauncher';

describe('isExcludedNumber', () => {
  it.each(['211', '311', '411', '511', '611', '711', '811', '911', '988'])('refuses the %s service code dialed as +1%s', code => {
    expect(isExcludedNumber(`+1${code}`)).toBe(true);
  });
  it.each(['+1911', '+1988', '+1401911', '+1401988'])('refuses %s even when padded toward a national number', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+12345', '+123456', '+140155', '+1401555', '+4412345', '+3312345'])('refuses the five- and six-digit short code %s', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+14019110100', '+14015112000', '+14016110100', '+19115550100', '+19885550100'])('refuses %s: a service code in the area or exchange position', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+14019581234', '+14019591234'])('refuses the NANP plant-test exchange in %s', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+14015550100', '+12025550199', '+14015550150'])('refuses the reserved fictional block in %s', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+14015550099', '+14015550200', '+14015551234'])('keeps %s: a 555 line outside the fictional block is a real assignment', value => {
    expect(isExcludedNumber(value)).toBe(false);
  });
  it.each(['+10015551234', '+11015551234', '+14010551234', '+14011551234'])('refuses %s: area or exchange codes cannot start with 0 or 1', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['+1401572332', '+140157233221', '+1'])('refuses %s: not a ten-digit national number', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it.each(['4015723322', '+1 401 572 3322', 'tel:+14015723322', '+14015723322\n', '', '+04015723322'])('refuses malformed input %j instead of repairing it', value => {
    expect(isExcludedNumber(value)).toBe(true);
  });
  it('refuses non-string input', () => {
    expect(isExcludedNumber(undefined as unknown as string)).toBe(true);
    expect(isExcludedNumber(14015723322 as unknown as string)).toBe(true);
  });
  it.each(['+14015723322', '+16175550200', '+12145551234', '+442071234567'])('keeps the ordinary business line %s', value => {
    expect(isExcludedNumber(value)).toBe(false);
  });
  it('is the launcher\'s second gate: an excluded number never reaches the tel: handoff', async () => {
    const opened: string[] = [];
    const launcher = createPhoneHandoffLauncher({ isExcludedNumber, driver: { inspectVerifiedHandler: async () => 'phone_continuity_verified', isVerifiedHandlerCurrent: () => true, openTelUri: async uri => { opened.push(uri); } } });
    await launcher.inspectCapability();
    expect(await launcher.dispatch('+14015550100')).toEqual({ status: 'refused', reasonCode: 'invalid_target' });
    expect(opened).toEqual([]);
    await launcher.inspectCapability();
    expect(await launcher.dispatch('+14015723322')).toEqual({ status: 'handoff_accepted', reasonCode: null });
    expect(opened).toEqual(['tel:+14015723322']);
  });
});
