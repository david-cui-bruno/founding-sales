/**
 * Numbers the Mac must never hand to Phone.app, checked after the E.164 shape
 * test in `createPhoneHandoffLauncher` and independently of the authorization
 * gate. The list is explicit and small: North American emergency and service
 * codes, short codes, the NANP plant-test exchanges, and the reserved fictional
 * 555-01XX block that only ever appears in documentation and test data.
 * Anything that is not a well-formed E.164 number is excluded too; the launcher
 * treats a `true` as `invalid_target`, so refusing malformed input is the safe
 * direction. This function never normalizes or repairs its input.
 */

/** N11 service codes plus the 988 lifeline. All three-digit dials, never a business line. */
const SERVICE_CODES: ReadonlySet<string> = new Set(['211', '311', '411', '511', '611', '711', '811', '911', '988']);
/** NANP exchanges reserved for plant testing; a "number" here reaches a test tone or a recording, never a firm. */
const TEST_EXCHANGES: ReadonlySet<string> = new Set(['958', '959']);
const E164 = /^\+[1-9][0-9]{1,14}$/;

export function isExcludedNumber(normalizedE164: string): boolean {
  if (typeof normalizedE164 !== 'string' || normalizedE164.match(E164)?.[0] !== normalizedE164) return true;
  const digits = normalizedE164.slice(1);
  if (!digits.startsWith('1')) {
    // Outside the NANP the country code length varies; only the short-code band is knowable.
    return digits.length < 8;
  }
  const national = digits.slice(1);
  if (national.length !== 10) return true; // N11 codes, 988, five- and six-digit short codes, or a truncated number.
  const area = national.slice(0, 3), exchange = national.slice(3, 6), line = national.slice(6);
  if (SERVICE_CODES.has(area) || SERVICE_CODES.has(exchange)) return true;
  if (/^[01]/.test(area) || /^[01]/.test(exchange)) return true; // Not assignable in the NANP.
  if (TEST_EXCHANGES.has(exchange)) return true;
  if (exchange === '555' && line >= '0100' && line <= '0199') return true; // Reserved fictional block.
  return false;
}
