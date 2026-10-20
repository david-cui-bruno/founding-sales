import { z } from 'zod';
import { uuid } from './foundationRows.ts';

/** David's October 19 decision. These codes never become uncovered when evidence expires. */
export const NATIONAL_DNC_COVERED_AREA_CODES = ['401', '508', '617', '774', '857'] as const;
export const NATIONAL_DNC_OWNER_DECISION = 'david-20261019-221531-uncovered-office-iphone-v1';
export const NATIONAL_DNC_OWNER_APPROVED_AT = '2026-10-19T22:15:31.941Z';
export const NATIONAL_DNC_UNCHECKED_WARNING = 'Not checked against national DNC';
/** Older clients must not receive an unchecked handoff without the visible disclosure. */
export const NATIONAL_DNC_RISK_MIN_CLIENT_VERSION = '1.0.56';

/** Disclosure only, never a dispatch capability or proof of legal permission. */
export const nationalDncDisclosureSchema = z.strictObject({
  status: z.enum(['checked_clear', 'not_checked_owner_risk', 'unknown']),
  basis: z.enum(['registry', 'verified_business_office', 'owner_self_test']).nullable(),
  receiptId: uuid.nullable(),
  warning: z.literal(NATIONAL_DNC_UNCHECKED_WARNING).nullable(),
}).refine(value => {
  if (value.status === 'unknown') return value.basis === null && value.receiptId === null && value.warning === null;
  if (value.status === 'checked_clear') return value.basis === 'registry' && value.receiptId === null && value.warning === null;
  return value.basis !== null && value.basis !== 'registry' && value.receiptId !== null && value.warning === NATIONAL_DNC_UNCHECKED_WARNING;
}, 'Disclosure must distinguish actual registry evidence from receipted owner risk');
export type NationalDncDisclosure = z.infer<typeof nationalDncDisclosureSchema>;
export const unknownNationalDncDisclosure = (): NationalDncDisclosure => ({
  status: 'unknown', basis: null, receiptId: null, warning: null,
});
