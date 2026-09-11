/** Owner-approved product description from the approved 2026-09-08 design §1.
 * This is not independent live verification, pricing, an integration guarantee,
 * or permission to make a pilot/material commitment. No prospect data is included. */
export const CALLIE_PRODUCT_FACTS = Object.freeze({
  approvalId: 'callie-product-description:2026-09-08:v1',
  version: 1,
  sourceRef: 'docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md#1-the-product-in-one-minute',
  approvalKind: 'owner_approved_description' as const,
  facts: Object.freeze([
    Object.freeze({ id: 'product:callie:description:v1', text: 'Callie is a 24/7 maintenance agent that handles tenant requests and coordinates contractors, including calling them when needed.' }),
  ]),
});
