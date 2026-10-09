// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { BusinessReview, type BusinessReviewPorts } from '../src/renderer/firms/BusinessReview.tsx';
import type { BusinessPolicy } from '@fss/contracts';
afterEach(cleanup);
const ID = '11111111-1111-4111-8111-111111111111';
it('shows capture off and requires explicit metadata-only acknowledgement before preparing review', async () => {
  const user = userEvent.setup();
  const policy: BusinessPolicy = { mailboxId: ID, ownerUserId: ID, emailAddress: 'owner@example.test', generation: 2, accountBinding: 'a'.repeat(64), revision: 0, enabled: false, scopeDays: 90, classificationMode: 'metadata_only', disclosure: null, ready: false, reasons: ['disclosure_required', 'activation_not_available'], metadataReviewDisclosureText: 'Allow metadata-only private review; no bodies or hosted AI.', metadataReviewDisclosure: { version: 'business-metadata-review-v1', sha256: 'b'.repeat(64) } };
  let saved = false;
  const ports: BusinessReviewPorts = { policy: async () => policy, savePolicy: async (input) => { expect(input).toEqual({ mailboxId: ID, expectedRevision: 0, expectedGeneration: 2, expectedAccountBinding: 'a'.repeat(64), enabled: false, disclosure: policy.metadataReviewDisclosure }); saved = true; return { revision: 1 }; } };
  render(<BusinessReview enabled ports={ports}/>);
  expect(await screen.findByText('Business conversation capture is off.')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Prepare metadata review' }).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: 'I approve metadata-only conversation review' }));
  await user.click(screen.getByRole('button', { name: 'Prepare metadata review' }));
  expect(saved).toBe(true);
  expect(screen.queryByRole('button', { name: /enable capture/i })).toBeNull();
});
it('records an explicit review decision against current metadata and refreshes the authoritative page', async () => {
  const user = userEvent.setup();
  let decided = false;
  const policy: BusinessPolicy = { mailboxId: ID, ownerUserId: ID, emailAddress: 'owner@example.test', generation: 2, accountBinding: 'a'.repeat(64), revision: 1, enabled: false, scopeDays: 90, classificationMode: 'metadata_only', disclosure: { version: 'business-metadata-review-v1', sha256: 'b'.repeat(64) }, ready: false, reasons: ['activation_not_available'], metadataReviewDisclosureText: 'Allow metadata-only private review; no bodies or hosted AI.', metadataReviewDisclosure: { version: 'business-metadata-review-v1', sha256: 'b'.repeat(64) } };
  const ports: BusinessReviewPorts = { policy: async () => policy, savePolicy: async () => ({ revision: 2 }), review: async () => ({ available: true, reasons: [], mailboxId: ID, accountBinding: 'a'.repeat(64), generation: 2, policyRevision: 1, captureAllowed: false, nextAfter: null, conversations: [{ conversationId: ID, subject: 'Unknown business contact', participants: ['alex@example.test'], latestProviderAt: '2026-10-09T12:00:00.000Z', category: 'uncertain', reason: 'unclassified_metadata', metadataRevision: 3, decisionRevision: decided ? 1 : 0, humanDecision: decided ? 'exclude' : null, effectiveDecision: decided ? 'excluded' : 'needs_review', captureAllowed: false }] }), decide: async (input) => { expect(input).toEqual({ mailboxId: ID, conversationId: ID, expectedAccountBinding: 'a'.repeat(64), expectedGeneration: 2, expectedPolicyRevision: 1, expectedMetadataRevision: 3, expectedDecisionRevision: 0, decision: 'exclude' }); decided = true; return { decisionRevision: 1, captureAllowed: false }; } };
  render(<BusinessReview enabled ports={ports}/>);
  expect(await screen.findByText('Unknown business contact')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Exclude conversation' }));
  expect(await screen.findByText('Excluded by you')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /send|book/i })).toBeNull();
});
it('clears the existing metadata page when pagination reports a changed mailbox binding',async()=>{
const user=userEvent.setup();
const policy:BusinessPolicy={mailboxId:ID,ownerUserId:ID,emailAddress:'owner@example.test',generation:2,accountBinding:'a'.repeat(64),revision:1,enabled:false,scopeDays:90,classificationMode:'metadata_only',disclosure:{version:'business-metadata-review-v1',sha256:'b'.repeat(64)},ready:false,reasons:['activation_not_available'],metadataReviewDisclosureText:'Metadata only.',metadataReviewDisclosure:{version:'business-metadata-review-v1',sha256:'b'.repeat(64)}};
const ports:BusinessReviewPorts={policy:async()=>policy,savePolicy:async()=>({revision:2}),review:async(_mailboxId,after)=>after===undefined?{available:true,reasons:[],mailboxId:ID,accountBinding:'a'.repeat(64),generation:2,policyRevision:1,captureAllowed:false,nextAfter:ID,conversations:[{conversationId:ID,subject:'Private old-account subject',participants:['alex@example.test'],latestProviderAt:'2026-10-09T12:00:00.000Z',category:'uncertain',reason:'unclassified_metadata',metadataRevision:1,decisionRevision:0,humanDecision:null,effectiveDecision:'needs_review',captureAllowed:false}]}:{available:false,reasons:['mailbox_binding_changed'],mailboxId:ID,accountBinding:'c'.repeat(64),generation:3,policyRevision:1,captureAllowed:false,nextAfter:null,conversations:[]}};
render(<BusinessReview enabled ports={ports}/>);
expect(await screen.findByText('Private old-account subject')).toBeTruthy();
await user.click(screen.getByRole('button',{name:'Show more conversations'}));
await screen.findByText('Metadata review is unavailable. Prepare consent for the current mailbox connection.');
expect(screen.queryByText('Private old-account subject')).toBeNull();
});
