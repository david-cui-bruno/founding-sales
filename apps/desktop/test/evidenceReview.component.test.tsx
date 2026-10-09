// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessingHealth, type ProcessingPorts } from '../src/renderer/firms/ProcessingHealth.tsx';
import { EvidenceReview, type EvidenceReviewPorts } from '../src/renderer/firms/EvidenceReview.tsx';
afterEach(cleanup);
const ID='11111111-1111-4111-8111-111111111111';
const source={workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt' as const,availability:'available' as const};
it('reads one selected record source and labels bounded evidence coverage and unknown original dates truthfully',async()=>{
 const ports:EvidenceReviewPorts={read:async input=>{expect(input).toEqual({source:{workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null},limit:50});return {source,claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));
 expect(await screen.findByText('Original event date unknown')).toBeTruthy();
 expect(screen.getByText('Source observed: 2026-10-09T00:00:00Z')).toBeTruthy();
 expect(screen.getByText('This source page: 0 current interpretations, 0 previously reviewed interpretations.')).toBeTruthy();
 expect(screen.getByText('No current interpretations on this page.')).toBeTruthy();
});
it('keeps source quotations separate from AI interpretations and dated human review of older interpretations',async()=>{
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'We are slow answering requests.',source:{...source,locator:'utf16:0:30'},anchorId:null,semanticHash:'c'.repeat(64),decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const older={...claim,claimId:'22222222-2222-4222-8222-222222222222',anchorId:ID,interpretation:'Earlier interpretation',decisionRevision:1,effectiveState:'dismissed' as const,decision:{action:'dismiss' as const,decisionAt:'2026-10-08T12:00:00Z',correctedInterpretation:null,rationale:'Not supported'},decisionHistory:[{revision:1,action:'dismiss' as const,decisionAt:'2026-10-08T12:00:00Z',correctedInterpretation:null,rationale:'Not supported'}]};
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[claim],reviewedHistory:[older],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:1,confirmed:0,dismissed:1,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}})};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));
 expect(await screen.findByText('AI interpretation · inferred · unreviewed')).toBeTruthy();expect(screen.getByText('May need a faster inbox')).toBeTruthy();expect(screen.getAllByText('We are slow answering requests.')).toHaveLength(2);
 expect(screen.getByText('Previously reviewed interpretation')).toBeTruthy();expect(screen.getByText('Human dismiss · 2026-10-08T12:00:00Z')).toBeTruthy();expect(screen.getByText('Not supported')).toBeTruthy();expect(screen.getAllByText('Source revision 1 · utf16:0:30 · Speaker unknown')).toHaveLength(2);
});
it('clears a copied source page when the actual record source revision changes without a caller-supplied version',async()=>{
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}})};
 const view=render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('Source observed: 2026-10-09T00:00:00Z');
 view.rerender(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[{...source,revision:2,contentHash:null,availability:'deleted'}]}/>);
 expect(screen.queryByText('Source observed: 2026-10-09T00:00:00Z')).toBeNull();
});
it('confirms a human decision against exact server claim identity and rereads current state without editing the quotation',async()=>{
 let confirmed=false;
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'We are slow answering requests.',source:{...source,locator:'utf16:0:30'},anchorId:null,semanticHash:'c'.repeat(64),decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[confirmed?{...claim,anchorId:ID,decisionRevision:1,effectiveState:'confirmed',decision:{action:'confirm',decisionAt:'2026-10-09T10:00:00Z',correctedInterpretation:null,rationale:null}}:claim],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:confirmed?1:0,dismissed:0,corrected:0,unreviewed:confirmed?0:1,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}}),decide:async input=>{expect(input).toEqual({source:{workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null},claimId:ID,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),expectedDecisionRevision:0,action:'confirm'});confirmed=true;return {anchorId:ID,decisionRevision:1};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('May need a faster inbox');
 await userEvent.click(screen.getByRole('button',{name:'Confirm interpretation 1'}));
 expect(await screen.findByText('Human confirm · 2026-10-09T10:00:00Z')).toBeTruthy();expect(screen.getByText('We are slow answering requests.')).toBeTruthy();expect(screen.getByText('AI interpretation · inferred · confirmed')).toBeTruthy();
});
it('discovers and opens redacted dated history after a fresh reload of a deleted record source without reading withdrawn quotes',async()=>{
 const deleted={...source,revision:2,contentHash:null,availability:'deleted' as const};
 const ports:EvidenceReviewPorts={read:async()=>{throw new Error('must not read deleted quotes');},historyList:async input=>{expect(input).toEqual({kind:'selected_note',sourceId:ID,limit:50});return {anchors:[{anchorId:ID,currentDecisionRevision:1,basis:'deleted_redacted'}],nextAfterId:null};},historyRead:async input=>{expect(input).toEqual({kind:'selected_note',sourceId:ID,anchorId:ID,limit:50});return {anchorId:ID,sourceId:ID,kind:'selected_note',availability:'deleted',originalEventAt:null,originalObservedAt:null,currentDecisionRevision:1,basis:'deleted_redacted',decisions:[{revision:1,action:'correct',decisionAt:'2026-10-09T10:00:00Z',correctedInterpretation:null,rationale:null,redacted:true}],nextBeforeRevision:null};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[deleted]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review decision history 1'}));await screen.findByRole('button',{name:'Open decision history 1'});
 await userEvent.click(screen.getByRole('button',{name:'Open decision history 1'}));
 expect(await screen.findByText('Human correct · 2026-10-09T10:00:00Z · revision 1')).toBeTruthy();expect(screen.getByText('Source content and original dates have been removed. Dated review actions remain.')).toBeTruthy();expect(screen.getByText('Correction and rationale redacted')).toBeTruthy();expect(screen.queryByText(/Human correction:/)).toBeNull();
});
it('records a human correction separately from the immutable source quotation at the current decision revision',async()=>{
 let corrected=false;
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'We are slow answering requests.',source:{...source,locator:'utf16:0:30'},anchorId:ID,semanticHash:'c'.repeat(64),decisionRevision:1,reviewRequired:false,effectiveState:'confirmed' as const,decision:{action:'confirm' as const,decisionAt:'2026-10-09T10:00:00Z',correctedInterpretation:null,rationale:null},decisionHistory:[],decisionHistoryTruncated:false};
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[corrected?{...claim,decisionRevision:2,effectiveState:'corrected',decision:{action:'correct',decisionAt:'2026-10-09T11:00:00Z',correctedInterpretation:'They need intake triage',rationale:'Confirmed on call'}}:claim],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:corrected?0:1,dismissed:0,corrected:corrected?1:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}}),decide:async input=>{expect(input).toMatchObject({claimId:ID,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),expectedDecisionRevision:1,action:'correct',correctedInterpretation:'They need intake triage',rationale:'Confirmed on call'});corrected=true;return {anchorId:ID,decisionRevision:2};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('May need a faster inbox');
 await userEvent.click(screen.getByRole('button',{name:'Correct interpretation 1'}));await userEvent.type(screen.getByLabelText('Human interpretation correction'),'They need intake triage');await userEvent.type(screen.getByLabelText('Decision rationale'),'Confirmed on call');await userEvent.click(screen.getByRole('button',{name:'Save human correction'}));
 expect(await screen.findByText('Human correction: They need intake triage')).toBeTruthy();expect(screen.getByText('We are slow answering requests.')).toBeTruthy();expect(screen.getByText('May need a faster inbox')).toBeTruthy();
});
it('clears a correction draft when the user selects another source in the same record',async()=>{
 const other={...source,sourceId:'22222222-2222-4222-8222-222222222222'};
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'Original private words',source,anchorId:null,semanticHash:'c'.repeat(64),decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const ports:EvidenceReviewPorts={read:async input=>({source:input.source.sourceId===ID?source:other,claims:input.source.sourceId===ID?[claim]:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:input.source.sourceId===ID?1:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:input.source.sourceId===ID?1:0,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}}),decide:async()=>{throw new Error('must not submit old correction');}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source,other]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('Original private words');await userEvent.click(screen.getByRole('button',{name:'Correct interpretation 1'}));await userEvent.type(screen.getByLabelText('Human interpretation correction'),'Old source correction');
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 2'}));await screen.findByText('No current interpretations on this page.');
 expect(screen.queryByLabelText('Human interpretation correction')).toBeNull();expect(screen.queryByText('Original private words')).toBeNull();
});
it('dismisses an interpretation while retaining its original quotation and explicit human decision date',async()=>{
 let dismissed=false;
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'e'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'May need a faster inbox',status:'inferred' as const,quote:'We are slow answering requests.',source,anchorId:null,semanticHash:'c'.repeat(64),decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const ports:EvidenceReviewPorts={read:async()=>({source,claims:[dismissed?{...claim,anchorId:ID,decisionRevision:1,effectiveState:'dismissed',decision:{action:'dismiss',decisionAt:'2026-10-09T10:00:00Z',correctedInterpretation:null,rationale:null}}:claim],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:dismissed?1:0,corrected:0,unreviewed:dismissed?0:1,reviewRequired:0},truncated:false,revisionFingerprint:'d'.repeat(64)}}),decide:async input=>{expect(input).toMatchObject({action:'dismiss',claimId:ID,expectedDecisionRevision:0});dismissed=true;return {anchorId:ID,decisionRevision:1};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));await screen.findByText('May need a faster inbox');await userEvent.click(screen.getByRole('button',{name:'Dismiss interpretation 1'}));
 expect(await screen.findByText('Human dismiss · 2026-10-09T10:00:00Z')).toBeTruthy();expect(screen.getByText('We are slow answering requests.')).toBeTruthy();
});
it('opens evidence through the actual existing source-processing surface and clears it when record privacy changes',async()=>{
 const evidence:EvidenceReviewPorts={read:async()=>({source,claims:[],reviewedHistory:[],nextAfterReviewedAnchorId:null,nextAfterClaimId:null,projection:{scope:'bounded_source_page' as const,counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:false,revisionFingerprint:'b'.repeat(64)}})};
 const ports:ProcessingPorts={evidence,health:async()=>({sourceId:ID,sourceRevision:1,availability:'available',generations:[],truncated:false,unknownAcceptance:false}),request:async()=>{throw new Error('review must not extract');}};
 const view=render(<ProcessingHealth source={source} ports={ports} enabled recordId={ID} privacyKey="before"/>);
 await userEvent.click(screen.getByRole('button',{name:'Review evidence 1'}));expect(await screen.findByText('Source observed: 2026-10-09T00:00:00Z')).toBeTruthy();
 view.rerender(<ProcessingHealth source={source} ports={ports} enabled={false} recordId={ID} privacyKey="after"/>);
 expect(screen.queryByText('Source observed: 2026-10-09T00:00:00Z')).toBeNull();expect(screen.queryByRole('button',{name:'Review evidence 1'})).toBeNull();
});
it('discovers a saved conflict and shows contradictory source evidence and dated group membership without preferring the newer import',async()=>{
 const other='22222222-2222-4222-8222-222222222222';
 const member={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:ID,firmIds:[],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs intake triage',status:'inferred' as const,quote:'Original source one',source,anchorId:ID};
 const ports:EvidenceReviewPorts={read:async()=>{throw new Error('conflict read is separate');},conflictList:async input=>{expect(input).toEqual({kind:'selected_note',sourceId:ID,limit:50});return {conflicts:[{conflictId:ID,revision:1,state:'open' as const}],nextAfterId:null};},conflictRead:async input=>{expect(input).toEqual({conflictId:ID,limit:50});return {conflictId:ID,revision:1,state:'open' as const,resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T10:00:00Z',rationale:null,members:[member,{...member,claimId:other,anchorId:other,interpretation:'Intake already works',quote:'Original source two',source:{...source,sourceId:other,occurredAt:'2026-09-01T00:00:00Z',observedAt:'2026-10-09T11:00:00Z'}}],history:[{revision:1,state:'open' as const,resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T10:00:00Z',rationale:null,memberAnchorIds:[ID,other]}],nextAfterRevision:null};}};
 render(<EvidenceReview enabled recordId={ID} privacyKey="current" ports={ports} sources={[source]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));await screen.findByRole('button',{name:'Open conflict 1'});await userEvent.click(screen.getByRole('button',{name:'Open conflict 1'}));
 expect(await screen.findByText('Original source one')).toBeTruthy();expect(screen.getByText('Original source two')).toBeTruthy();expect(screen.getByText('Original event date: 2026-09-01T00:00:00Z')).toBeTruthy();expect(screen.getByText('Source observed: 2026-10-09T11:00:00Z')).toBeTruthy();expect(screen.getByText('Group revision 1 · open · 2026-10-09T10:00:00Z · 2 members')).toBeTruthy();expect(screen.getByText('Import time does not decide which interpretation is true.')).toBeTruthy();
});
it('keeps both contradictory claims through an explicit dated human resolution and reloads the group',async()=>{
 const other='22222222-2222-4222-8222-222222222222';
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs intake',status:'inferred' as const,quote:'Immutable source passage',source};
 const group={conflictId:ID,revision:1,state:'open' as const,resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T10:00:00Z',rationale:null,members:[{...claim,anchorId:ID},{...claim,claimId:other,anchorId:other}],history:[{revision:1,state:'open' as const,resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T10:00:00Z',rationale:null,memberAnchorIds:[ID,other]}],nextAfterRevision:null};
 const resolve=vi.fn(async()=>({conflictId:ID,revision:2}));
 const readConflict=vi.fn().mockResolvedValueOnce(group).mockResolvedValueOnce({...group,revision:2,state:'resolved',resolution:'keep_both',decidedAt:'2026-10-09T11:00:00Z'});
 const ports:EvidenceReviewPorts={read:vi.fn(),conflictList:vi.fn(async()=>({conflicts:[{conflictId:ID,revision:1,state:'open' as const}],nextAfterId:null})),conflictRead:readConflict,conflictResolve:resolve};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 fireEvent.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));fireEvent.click(await screen.findByRole('button',{name:'Open conflict 1'}));
 fireEvent.click(await screen.findByRole('button',{name:'Keep both interpretations'}));
 await waitFor(()=>expect(resolve).toHaveBeenCalledWith({conflictId:ID,expectedConflictRevision:1,resolution:'keep_both'}));
 expect(await screen.findByText('Current group revision 2 · resolved')).toBeTruthy();
 expect(screen.getAllByText('Immutable source passage')).toHaveLength(2);
 expect(screen.getByText('Human resolution: keep_both · 2026-10-09T11:00:00Z')).toBeTruthy();
});
it('creates a conflict from two selected current exact interpretations without copying or editing source passages',async()=>{
 const user=userEvent.setup(),other='22222222-2222-4222-8222-222222222222';
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs intake',status:'inferred' as const,quote:'Original unchanged passage',source,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const saved=vi.fn(async()=>({conflictId:ID,revision:1}));
 const ports:EvidenceReviewPorts={read:vi.fn(async()=>({source,claims:[claim,{...claim,claimId:other}],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:2,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:2,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}})),conflictSave:saved};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review evidence 1'}));
 await user.click(await screen.findByRole('checkbox',{name:'Conflict member interpretation 1'}));await user.click(screen.getByRole('checkbox',{name:'Conflict member interpretation 2'}));await user.click(screen.getByRole('button',{name:'Save evidence conflict'}));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith({expectedConflictRevision:0,members:[expect.objectContaining({claimId:ID,contextHash:claim.contextHash,expectedDecisionRevision:0}),expect.objectContaining({claimId:other,contextHash:claim.contextHash})]}));
 expect(await screen.findByText('Conflict saved. Reload conflicts to review the current group.')).toBeTruthy();
});
it('shows completed work and separate evidence review flags without reopening or changing the action',async()=>{
 const user=userEvent.setup();const work={kind:'call_task' as const,id:ID};
 const ports:EvidenceReviewPorts={read:vi.fn(),workList:vi.fn(async()=>({works:[{work,version:'2026-10-09T00:00:00Z',status:'done' as const,completedAt:'2026-10-09T11:00:00Z',dependencyCount:1,reviewRequired:true}],nextAfter:null})),workRead:vi.fn(async()=>({work:{...work,version:'2026-10-09T00:00:00Z',status:'done' as const,completedAt:'2026-10-09T11:00:00Z'},dependencies:[{dependencyId:ID,anchorId:ID,source:{workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null},observedDecisionRevision:1,observedWorkVersion:'2026-10-09T00:00:00Z',reviewRequired:true,reason:'source_deleted' as const,revision:2}],nextAfterDependencyId:null}))};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review dependent work for evidence 1'}));await user.click(await screen.findByRole('button',{name:'Open dependent work 1'}));
 expect(await screen.findByText('Actual action: done · completed 2026-10-09T11:00:00Z')).toBeTruthy();
 expect(screen.getByText('Evidence review required: source_deleted')).toBeTruthy();
 expect(screen.getByText('Evidence review does not reopen or alter a completed action.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:/reopen|send|complete/i})).toBeNull();
});
it('binds evidence only to a supplied real task context after fetching its current canonical version',async()=>{
 const user=userEvent.setup();const task={kind:'call_task' as const,id:ID};
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs intake',status:'inferred' as const,quote:'Unchanged source passage',source,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const bound=vi.fn(async()=>({dependencyId:ID,revision:1}));const workRead=vi.fn(async()=>({work:{...task,version:'2026-10-09T11:00:00Z',status:'open' as const,completedAt:null},dependencies:[],nextAfterDependencyId:null}));
 const ports:EvidenceReviewPorts={read:vi.fn(async()=>({source,claims:[claim],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}})),workRead,workBind:bound};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one" workContexts={[task]}/>);
 await user.click(screen.getByRole('button',{name:'Review evidence 1'}));await user.click(await screen.findByRole('button',{name:'Support existing task 1 with interpretation 1'}));
 await waitFor(()=>expect(workRead).toHaveBeenCalledWith({work:task,limit:50}));
 expect(bound).toHaveBeenCalledWith(expect.objectContaining({claimId:ID,contextHash:claim.contextHash,expectedDecisionRevision:0,work:{...task,expectedVersion:'2026-10-09T11:00:00Z'}}));
 expect(await screen.findByText('Evidence dependency saved. Task status is unchanged.')).toBeTruthy();
});
it('passes only actual record task references through the existing processing surface',async()=>{
 const user=userEvent.setup(),task={kind:'meeting_task' as const,id:ID};
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Needs intake',status:'inferred' as const,quote:'Record passage',source,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const bind=vi.fn(async()=>({dependencyId:ID,revision:1}));
 const evidence:EvidenceReviewPorts={read:vi.fn(async()=>({source,claims:[claim],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}})),workRead:async()=>({work:{...task,version:'2',status:'open',completedAt:null},dependencies:[],nextAfterDependencyId:null}),workBind:bind};
 const ports:ProcessingPorts={health:async()=>({sourceId:ID,sourceRevision:1,availability:'available',generations:[],truncated:false,unknownAcceptance:false}),request:async()=>{},evidence};
 render(<ProcessingHealth source={source} ports={ports} enabled recordId={ID} privacyKey="one" workContexts={[task]}/>);
 await user.click(screen.getByRole('button',{name:'Review evidence 1'}));await user.click(await screen.findByRole('button',{name:'Support existing task 1 with interpretation 1'}));
 await waitFor(()=>expect(bind).toHaveBeenCalledWith(expect.objectContaining({work:{...task,expectedVersion:'2'}})));
});
it('follows only server-provided decision-history cursors and replaces the bounded older action page',async()=>{
 const user=userEvent.setup();const read=vi.fn().mockResolvedValueOnce({anchorId:ID,sourceId:ID,kind:'selected_note',availability:'deleted',originalEventAt:null,originalObservedAt:null,currentDecisionRevision:51,basis:'deleted_redacted',decisions:[{revision:51,action:'dismiss',decisionAt:'2026-10-09T11:00:00Z',correctedInterpretation:null,rationale:null,redacted:true}],nextBeforeRevision:51}).mockResolvedValueOnce({anchorId:ID,sourceId:ID,kind:'selected_note',availability:'deleted',originalEventAt:null,originalObservedAt:null,currentDecisionRevision:51,basis:'deleted_redacted',decisions:[{revision:50,action:'confirm',decisionAt:'2026-10-09T10:00:00Z',correctedInterpretation:null,rationale:null,redacted:true}],nextBeforeRevision:null});
 const ports:EvidenceReviewPorts={read:vi.fn(),historyList:async()=>({anchors:[{anchorId:ID,currentDecisionRevision:51,basis:'deleted_redacted'}],nextAfterId:null}),historyRead:read};
 render(<EvidenceReview sources={[{...source,availability:'deleted',contentHash:null}]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review decision history 1'}));await user.click(await screen.findByRole('button',{name:'Open decision history 1'}));await user.click(await screen.findByRole('button',{name:'Older decision actions'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith({kind:'selected_note',sourceId:ID,anchorId:ID,beforeRevision:51,limit:50}));expect(await screen.findByText('Human confirm · 2026-10-09T10:00:00Z · revision 50')).toBeTruthy();expect(screen.queryByText('Human dismiss · 2026-10-09T11:00:00Z · revision 51')).toBeNull();
});
it('uses returned evidence cursors for a new bounded page without inventing aggregate counts',async()=>{
 const user=userEvent.setup();const page={source,claims:[],reviewedHistory:[],nextAfterClaimId:ID,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page' as const,counts:{current:0,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:0,reviewRequired:0},truncated:true,revisionFingerprint:'e'.repeat(64)}};
 const read=vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({...page,nextAfterClaimId:null,projection:{...page.projection,truncated:false}});
 render(<EvidenceReview sources={[source]} ports={{read}} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review evidence 1'}));await user.click(await screen.findByRole('button',{name:'Next evidence page'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith({source:{workspaceId:ID,sourceId:ID,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null},afterClaimId:ID,limit:50}));
 expect(await screen.findByText('This source page: 0 current interpretations, 0 previously reviewed interpretations.')).toBeTruthy();expect(screen.queryByText('More evidence exists beyond this bounded page.')).toBeNull();
});
it('follows bounded discovery cursors for history, conflicts and existing dependent work',async()=>{
 const user=userEvent.setup(),work={kind:'call_task' as const,id:ID};
 const historyList=vi.fn().mockResolvedValue({anchors:[],nextAfterId:ID}),conflictList=vi.fn().mockResolvedValue({conflicts:[],nextAfterId:ID}),workList=vi.fn().mockResolvedValue({works:[],nextAfter:work});
 const ports:EvidenceReviewPorts={read:vi.fn(),historyList,historyRead:vi.fn(),conflictList,conflictRead:vi.fn(),workList,workRead:vi.fn()};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review decision history 1'}));await user.click(await screen.findByRole('button',{name:'More decision history references'}));expect(historyList).toHaveBeenLastCalledWith({kind:'selected_note',sourceId:ID,afterId:ID,limit:50});
 await user.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));await user.click(await screen.findByRole('button',{name:'More conflict references'}));expect(conflictList).toHaveBeenLastCalledWith({kind:'selected_note',sourceId:ID,afterId:ID,limit:50});
 await user.click(screen.getByRole('button',{name:'Review dependent work for evidence 1'}));await user.click(await screen.findByRole('button',{name:'More dependent work references'}));expect(workList).toHaveBeenLastCalledWith({kind:'selected_note',sourceId:ID,after:work,limit:50});
});
it('drops a late task-version answer after navigation before issuing any evidence binding',async()=>{
 const user=userEvent.setup(),task={kind:'call_task' as const,id:ID};let finish!:(value:Awaited<ReturnType<NonNullable<EvidenceReviewPorts['workRead']>>>)=>void;
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),semanticHash:'d'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Sensitive proposal',status:'inferred' as const,quote:'Sensitive original passage',source,anchorId:null,decisionRevision:0,reviewRequired:false,effectiveState:'unreviewed' as const,decision:null,decisionHistory:[],decisionHistoryTruncated:false};
 const bind=vi.fn(async()=>({dependencyId:ID,revision:1}));const ports:EvidenceReviewPorts={read:async()=>({source,claims:[claim],reviewedHistory:[],nextAfterClaimId:null,nextAfterReviewedAnchorId:null,projection:{scope:'bounded_source_page',counts:{current:1,reviewedHistory:0,confirmed:0,dismissed:0,corrected:0,unreviewed:1,reviewRequired:0},truncated:false,revisionFingerprint:'e'.repeat(64)}}),workRead:()=>new Promise(resolve=>{finish=resolve;}),workBind:bind};
 const view=render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one" workContexts={[task]}/>);
 await user.click(screen.getByRole('button',{name:'Review evidence 1'}));await user.click(await screen.findByRole('button',{name:'Support existing task 1 with interpretation 1'}));view.rerender(<EvidenceReview sources={[]} ports={ports} enabled={false} recordId="next" privacyKey="two"/>);
 finish({work:{...task,version:'2026-10-09T11:00:00Z',status:'open',completedAt:null},dependencies:[],nextAfterDependencyId:null});await waitFor(()=>expect(bind).not.toHaveBeenCalled());expect(screen.queryByText('Sensitive original passage')).toBeNull();
});
it('drops late conflict evidence after privacy changes without publishing withdrawn passages',async()=>{
 const user=userEvent.setup();let finish!:(value:Awaited<ReturnType<NonNullable<EvidenceReviewPorts['conflictRead']>>>)=>void;
 const ports:EvidenceReviewPorts={read:vi.fn(),conflictList:async()=>({conflicts:[{conflictId:ID,revision:1,state:'open'}],nextAfterId:null}),conflictRead:()=>new Promise(resolve=>{finish=resolve;})};
 const view=render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));await user.click(await screen.findByRole('button',{name:'Open conflict 1'}));view.rerender(<EvidenceReview sources={[{...source,contentHash:null,availability:'deleted'}]} ports={ports} enabled recordId={ID} privacyKey="two"/>);
 const other='22222222-2222-4222-8222-222222222222';const claim={anchorId:ID,claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Sensitive proposal',status:'inferred' as const,quote:'Withdrawn conflict passage',source};
 finish({conflictId:ID,revision:1,state:'open',resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T11:00:00Z',rationale:null,members:[claim,{...claim,anchorId:other,claimId:other}],history:[],nextAfterRevision:null});await waitFor(()=>expect(screen.queryByText('Withdrawn conflict passage')).toBeNull());expect(screen.queryByRole('button',{name:'Open conflict 1'})).toBeNull();
});
it('paginates conflict revisions and work dependencies with only their returned server cursors',async()=>{
 const user=userEvent.setup(),other='22222222-2222-4222-8222-222222222222',work={kind:'call_task' as const,id:ID};
 const claim={anchorId:ID,claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Need',status:'inferred' as const,quote:'Original passage',source};
 const conflictRead=vi.fn().mockResolvedValue({conflictId:ID,revision:51,state:'open',resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T11:00:00Z',rationale:null,members:[claim,{...claim,anchorId:other,claimId:other}],history:[],nextAfterRevision:50});
 const workRead=vi.fn().mockResolvedValue({work:{...work,version:'2026-10-09T11:00:00Z',status:'done',completedAt:'2026-10-09T11:00:00Z'},dependencies:[],nextAfterDependencyId:ID});
 const ports:EvidenceReviewPorts={read:vi.fn(),conflictList:async()=>({conflicts:[{conflictId:ID,revision:51,state:'open'}],nextAfterId:null}),conflictRead,workList:async()=>({works:[{work,version:'2026-10-09T11:00:00Z',status:'done',completedAt:'2026-10-09T11:00:00Z',dependencyCount:51,reviewRequired:true}],nextAfter:null}),workRead};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);
 await user.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));await user.click(await screen.findByRole('button',{name:'Open conflict 1'}));await user.click(await screen.findByRole('button',{name:'More conflict revisions'}));expect(conflictRead).toHaveBeenLastCalledWith({conflictId:ID,afterRevision:50,limit:50});
 await user.click(screen.getByRole('button',{name:'Review dependent work for evidence 1'}));await user.click(await screen.findByRole('button',{name:'Open dependent work 1'}));await user.click(await screen.findByRole('button',{name:'More evidence dependencies'}));expect(workRead).toHaveBeenLastCalledWith({work,afterDependencyId:ID,limit:50});
});
it('prefers only an actual conflict member and labels the human preference while preserving both passages',async()=>{
 const user=userEvent.setup(),other='22222222-2222-4222-8222-222222222222';const claim={anchorId:ID,claimId:ID,claimRevision:1 as const,claimHash:'b'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'current' as const},kind:'need' as const,interpretation:'Need',status:'inferred' as const,quote:'Original passage one',source};
 const group={conflictId:ID,revision:1,state:'open',resolution:null,preferredAnchorId:null,decidedAt:'2026-10-09T11:00:00Z',rationale:null,members:[claim,{...claim,anchorId:other,claimId:other,quote:'Original passage two'}],history:[],nextAfterRevision:null};
 const conflictRead=vi.fn().mockResolvedValueOnce(group).mockResolvedValueOnce({...group,revision:2,state:'resolved',resolution:'prefer_claim',preferredAnchorId:other});const resolve=vi.fn(async()=>({conflictId:ID,revision:2}));
 const ports:EvidenceReviewPorts={read:vi.fn(),conflictList:async()=>({conflicts:[{conflictId:ID,revision:1,state:'open'}],nextAfterId:null}),conflictRead,conflictResolve:resolve};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);await user.click(screen.getByRole('button',{name:'Review conflicts for evidence 1'}));await user.click(await screen.findByRole('button',{name:'Open conflict 1'}));await user.click(await screen.findByRole('button',{name:'Prefer interpretation 2'}));
 expect(resolve).toHaveBeenCalledWith({conflictId:ID,expectedConflictRevision:1,resolution:'prefer_claim',preferredAnchorId:other});expect(await screen.findByText('Human preferred interpretation: 2')).toBeTruthy();expect(screen.getByText('Original passage one')).toBeTruthy();expect(screen.getByText('Original passage two')).toBeTruthy();
});
it('labels available historical source event and observation dates separately from the human decision date',async()=>{
 const user=userEvent.setup();const ports:EvidenceReviewPorts={read:vi.fn(),historyList:async()=>({anchors:[{anchorId:ID,currentDecisionRevision:1,basis:'available'}],nextAfterId:null}),historyRead:async()=>({anchorId:ID,sourceId:ID,kind:'selected_note',availability:'available',originalEventAt:'2026-09-01T10:00:00Z',originalObservedAt:'2026-10-09T10:00:00Z',currentDecisionRevision:1,basis:'available',decisions:[{revision:1,action:'confirm',decisionAt:'2026-10-09T11:00:00Z',correctedInterpretation:null,rationale:null,redacted:false}],nextBeforeRevision:null})};
 render(<EvidenceReview sources={[source]} ports={ports} enabled recordId={ID} privacyKey="one"/>);await user.click(screen.getByRole('button',{name:'Review decision history 1'}));await user.click(await screen.findByRole('button',{name:'Open decision history 1'}));expect(await screen.findByText('Recorded original event: 2026-09-01T10:00:00Z')).toBeTruthy();expect(screen.getByText('Recorded source observation: 2026-10-09T10:00:00Z')).toBeTruthy();expect(screen.getByText('Human confirm · 2026-10-09T11:00:00Z · revision 1')).toBeTruthy();
});
