/** Owner-approved product description from the approved 2026-09-08 design §1.
 * This is not independent live verification, pricing, an integration guarantee,
 * or permission to make a pilot/material commitment. No prospect data is included. */
export const CALLIE_PRODUCT_FACTS = Object.freeze({
  approvalId: 'callie-product-description:2026-09-08:v1',
  version: 1,
  // The spec moved into docs/archive when the 2026-09-08 plans were archived; the section anchor is unchanged.
  sourceRef: 'docs/archive/superpowers/specs/2026-09-08-meeting-first-fss-design.md#1-the-product-in-one-minute',
  approvalKind: 'owner_approved_description' as const,
  facts: Object.freeze([
    Object.freeze({ id: 'product:callie:description:v1', text: 'Callie is a 24/7 maintenance agent that handles tenant requests and coordinates contractors, including calling them when needed.' }),
  ]),
});
/**
 * The same approved description as the follow-up templates state it, addressed to the audience David calls
 * (his templates decision of 17 September 2026). It names no capability, price, guarantee or integration the
 * 2026-09-08 description does not already name; it only says who the agent is for. Every seeded template body
 * contains this exact phrase, and the schema refuses a template body that does not.
 */
export const CALLIE_OUTREACH_PRODUCT_SENTENCE = 'a 24/7 maintenance agent for property managers';
/** The capability half of the same sentence, verbatim in every template that states it in one sentence. */
export const CALLIE_OUTREACH_PRODUCT_CAPABILITY = 'handles tenant requests and coordinates contractors, including calling them when needed';
export const CALLIE_OUTREACH_PRODUCT_APPROVAL = Object.freeze({
  approvalId: 'callie-followup-templates:2026-09-17:v1',
  derivedFrom: CALLIE_PRODUCT_FACTS.approvalId,
  approvalKind: 'owner_approved_description' as const,
});
