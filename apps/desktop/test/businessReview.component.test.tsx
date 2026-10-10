// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { BusinessReview, type BusinessReviewPorts } from '../src/renderer/firms/BusinessReview.tsx';
import type { BusinessPolicy, BusinessReviewPage } from '@fss/contracts';
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

function deferred<T>(){let resolve:(value:T)=>void=()=>{throw new Error('Deferred promise not initialized');};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const REVIEW_POLICY:BusinessPolicy={mailboxId:ID,ownerUserId:ID,emailAddress:'owner@example.test',generation:2,accountBinding:'a'.repeat(64),revision:1,enabled:false,scopeDays:90,classificationMode:'metadata_only',disclosure:{version:'business-metadata-review-v1',sha256:'b'.repeat(64)},ready:false,reasons:['activation_not_available'],metadataReviewDisclosureText:'Metadata only.',metadataReviewDisclosure:{version:'business-metadata-review-v1',sha256:'b'.repeat(64)}};
function reviewPage(subject:string):BusinessReviewPage{return {available:true,reasons:[],mailboxId:ID,accountBinding:'a'.repeat(64),generation:2,policyRevision:1,captureAllowed:false,nextAfter:ID,conversations:[{conversationId:ID,subject,participants:['private@example.test'],latestProviderAt:'2026-10-09T12:00:00.000Z',category:'uncertain',reason:'unclassified_metadata',metadataRevision:1,decisionRevision:0,humanDecision:null,effectiveDecision:'needs_review',captureAllowed:false}]};}
it('does not publish an older account page after a newer unavailable response',async()=>{
 const user=userEvent.setup();const older=deferred<BusinessReviewPage>();const newer=deferred<BusinessReviewPage>();let calls=0;
 const ports:BusinessReviewPorts={policy:async()=>REVIEW_POLICY,savePolicy:async()=>({revision:2}),review:async(_mailbox,after)=>after===undefined?reviewPage('Initial private metadata'):++calls===1?older.promise:newer.promise};
 render(<BusinessReview enabled ports={ports}/>);await screen.findByText('Initial private metadata');
 await user.click(screen.getByRole('button',{name:'Show more conversations'}));await user.click(screen.getByRole('button',{name:'Show more conversations'}));
 await act(async()=>{newer.resolve({...reviewPage(''),available:false,reasons:['mailbox_binding_changed'],accountBinding:'c'.repeat(64),generation:3,nextAfter:null,conversations:[]});});
 expect(screen.queryByText('Initial private metadata')).toBeNull();
 await act(async()=>{older.resolve(reviewPage('Stale private metadata'));});
 expect(screen.queryByText('Stale private metadata')).toBeNull();expect(screen.queryByText('Initial private metadata')).toBeNull();expect(screen.queryByText('private@example.test')).toBeNull();
});
it('invalidates a pending page when a newer exclusion refresh replaces the review',async()=>{
 const user=userEvent.setup();const pending=deferred<BusinessReviewPage>();let excluded=false;
 const ports:BusinessReviewPorts={policy:async()=>REVIEW_POLICY,savePolicy:async()=>({revision:2}),review:async(_mailbox,after)=>after===undefined?{...reviewPage('Current conversation'),nextAfter:excluded?null:ID,conversations:reviewPage('Current conversation').conversations.map(row=>({...row,decisionRevision:excluded?1:0,humanDecision:excluded?'exclude':null,effectiveDecision:excluded?'excluded':'needs_review'}))}:pending.promise,decide:async()=>{excluded=true;return{decisionRevision:1,captureAllowed:false};}};
 render(<BusinessReview enabled ports={ports}/>);await screen.findByText('Current conversation');await user.click(screen.getByRole('button',{name:'Show more conversations'}));await user.click(screen.getByRole('button',{name:'Exclude conversation'}));await screen.findByText('Excluded by you');
 await act(async()=>{pending.resolve(reviewPage('Stale pre-exclusion page'));});
 expect(screen.queryByText('Stale pre-exclusion page')).toBeNull();expect(screen.getByText('Excluded by you')).toBeTruthy();
});
it('offers bounded import status and an explicit queued request in the existing conversation review without enabling capture',async()=>{
 const user=userEvent.setup();let requested=false,saved=false;const ports:BusinessReviewPorts={policy:async()=>REVIEW_POLICY,savePolicy:async()=>{saved=true;return {revision:2};},imports:{health:async()=>null,request:async input=>{expect(input).toEqual({mailboxId:ID});requested=true;return {importId:ID,status:'queued'};}}};
 render(<BusinessReview enabled ports={ports} privacyKey="one"/>);await screen.findByRole('region',{name:'Mailbox import status'});await user.click(screen.getByRole('button',{name:'Request 90-day import'}));expect(await screen.findByText('Import request queued. Coverage is reported separately after work runs.')).toBeTruthy();expect(requested).toBe(true);expect(saved).toBe(false);expect(screen.getByText('Business conversation capture is off.')).toBeTruthy();expect(screen.queryByRole('button',{name:/enable capture|send email/i})).toBeNull();
});
it("refreshes mailbox policy and review after explicit prepared metadata activation",async ()=> {
 const user=userEvent.setup();
  let activated =false;
  const ports:BusinessReviewPorts = {policy:async ()=> ({
      ...REVIEW_POLICY,revision: activated? 4:3, enabled: activated,
    }),savePolicy:async ()=> ({revision: 4 }),review:async ()=> ({
      ...reviewPage(
        activated? "Current reviewed metadata": "Old reviewed metadata",
      ),policyRevision: activated? 4:3,
    }),
    capabilities: {
      read:async ( input)=> ({
        capability:input.capability,mailboxId:ID,
        configured:input.capability=== "metadata_review",revision:input.capability=== "metadata_review"? (activated? 4:3):0, enabled:input.capability=== "metadata_review" && activated,ready:input.capability=== "metadata_review",reason: "ready",
        authorityReceiptId:input.capability=== "metadata_review"?ID:null,
        proposedRevision: activated? 5: 4,
        proposedConfigurationFingerprint:null,
        configuration:null,
      }),
      activate:async ( input)=> {expect(input).toEqual({
          capability: "metadata_review",mailboxId:ID, expectedRevision:3,
          authorityReceiptId:ID,
        });
        activated=true;
        return {revision: 4, enabled:true, authorityReceiptId:ID };
      },
      disable:async ()=> {
        throw new Error("unexpected disable");
      },
    },
  };
 render(<BusinessReview enabled ports={ports}/>);
  await screen.findByText("Old reviewed metadata");
  await user.click(
    await screen.findByRole('button', {name: "Activate metadata review" }),
  );expect(await screen.findByText("Current reviewed metadata")).toBeTruthy();expect(screen.queryByText("Old reviewed metadata")).toBeNull();
});
