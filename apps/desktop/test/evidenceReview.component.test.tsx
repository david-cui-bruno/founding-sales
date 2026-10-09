// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { EvidenceReview, type EvidenceReviewPorts } from '../src/renderer/firms/EvidenceReview.tsx';
afterEach(cleanup);
const ID='11111111-1111-4111-8111-111111111111';
const source={workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt' as const,availability:'available' as const};
it('reads one selected record source and labels bounded evidence coverage and unknown original dates truthfully',async()=>{
 const ports:EvidenceReviewPorts={read:async input=>{expect(input).toEqual({source:{workspaceId:ID,sourceId:ID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},limit:50});return {source,claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page',counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));
 expect(await screen.findByText('Original event date unknown')).toBeTruthy();
 expect(screen.getByText('Source observed: 2026-10-09T00:00:00Z')).toBeTruthy();
 expect(screen.getByText('This source page: 0 current interpretations, 0 previously reviewed interpretations.')).toBeTruthy();
 expect(screen.getByText('No current interpretations on this page.')).toBeTruthy();
});
it('keeps source quotations separate from AI interpretations and dated human review of older interpretations',async()=>{
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'We are slow answering requests.',source:{...source,locator:'utf16:0:30'},anchorId:null,semanticHash:'c'.repeat(64),decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const older={...claim,claimId:'22222222-2222-4222-8222-222222222222',anchorId:ID,interpretation:'Earlier interpretation',decisionRevision:1,effectiveState:'dismissed' as const,decision:{action:'dismiss' as const,decisionAt:'2026-10-08T12:00:00Z',correctedInterpretation:null,rationale:'Not supported'},decisionHistory:[{revision:1,action:'dismiss' as const,decisionAt:'2026-10-08T12:00:00Z',correctedInterpretation:null,rationale:'Not supported'}]};
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[claim],reviewedHistory:[older],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page',counts:{current:1,reviewedHistory:1,confirmed:0,dismissed:1,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}})};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));
 expect(await screen.findByText('AI interpretation · inferred · unreviewed')).toBeTruthy();expect(screen.getByText('May need a faster inbox')).toBeTruthy();expect(screen.getAllByText('We are slow answering requests.')).toHaveLength(2);
 expect(screen.getByText('Previously reviewed interpretation')).toBeTruthy();expect(screen.getByText('Human dismiss · 2026-10-08T12:00:00Z')).toBeTruthy();expect(screen.getByText('Not supported')).toBeTruthy();expect(screen.getAllByText('Source revision 1 · utf16:0:30 · Speaker unknown')).toHaveLength(2);
});
it('clears a copied source page when the actual record source revision changes without a caller-supplied version',async()=>{
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page',counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}})};
 const view=render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('Source observed: 2026-10-09T00:00:00Z');
 view.rerender(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[{...source,revision:2,contentHash:null,availability:'deleted'}]}/>);
 expect(screen.queryByText('Source observed: 2026-10-09T00:00:00Z')).toBeNull();
});
