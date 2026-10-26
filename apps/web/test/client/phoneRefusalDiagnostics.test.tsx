// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {manualProspectPhoneEvidenceSchema,manualProspectSchema} from '@fss/contracts';
import {RetainedPhoneEvidence} from '../../src/client/RetainedPhoneEvidence.tsx';
import {ManualProspectCard} from '../../src/client/ManualProspectCard.tsx';
const runId='00000000-0000-4000-8000-000000000001';
const entry={reason:'unattached_label_content',runId,observationId:'00000000-0000-4000-8000-000000000002',blockId:'contact',url:'https://phone.example.test/contact',retrievedAt:'2026-10-25T12:34:56.000Z',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',label:'Phone',labelStart:3,labelEnd:8,authority:{kind:'phone_discovery',runId,expiresAt:'2026-10-26T20:00:01.000Z'},lineage:{kind:'provider_original'}};
function evidence(entries=[entry],truncated=false){return manualProspectPhoneEvidenceSchema.parse({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries,truncated}});}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('mounts exact zero-literal explanation as plain text with no prose, endpoint, fetch or retry action',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const fetch=vi.fn(()=>{throw Error('No acquisition or replay permitted');});vi.stubGlobal('fetch',fetch);
 const {container}=render(<RetainedPhoneEvidence evidence={evidence()}/>);
 expect(screen.getByText(/Unattached label content/u)).toBeTruthy();
 expect(screen.getByText(/explanation, not evidence of competing numbers/u)).toBeTruthy();
 expect(container.textContent).toContain('Label Phone · UTF-16 [3, 8)');expect(container.textContent).toContain(entry.url);expect(container.textContent).toContain(entry.retrievedAt);expect(container.textContent).toContain(entry.blockId);
 expect(container.querySelector('a')).toBeNull();expect(container.querySelector('button')).toBeNull();expect(container.textContent).not.toContain('+1214');
 expect(fetch).not.toHaveBeenCalled();
});
it('clears whole mixed evidence at earliest diagnostic-only dependency without network or resurrection',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const phone=evidence([{...entry,authority:{...entry.authority,expiresAt:'2026-10-26T20:00:05.000Z'}},entry]);
 const view=render(<RetainedPhoneEvidence evidence={phone}/>);
 expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(view.container.textContent).not.toContain(entry.url);expect(view.container.textContent).not.toContain('Unattached label content');
 view.rerender(<RetainedPhoneEvidence evidence={undefined}/>);view.rerender(<RetainedPhoneEvidence evidence={phone}/>);
 expect(view.container.textContent).not.toContain(entry.url);
});
it('selection replacement and unmount discard old timers and diagnostics',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const view=render(<RetainedPhoneEvidence evidence={evidence()}/>);
 view.rerender(<RetainedPhoneEvidence evidence={undefined}/>);expect(view.container.textContent).not.toContain(entry.url);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 view.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('earliest diagnostic expires the entire enrichment including a still-current literal source',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const {reason:_reason,...location}=entry;
 const phone=manualProspectPhoneEvidenceSchema.parse({state:'conflicting',reason:'retained_source_ambiguous',sources:[{...location,method:'retained_original_literal',literal:'2145550123',start:10,end:20,normalizedValue:'+12145550123',normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{...entry.authority,expiresAt:'2026-10-26T20:00:05.000Z'}}],diagnostics:{entries:[entry],truncated:false}});
 const view=render(<RetainedPhoneEvidence evidence={phone}/>);
 expect(screen.getByRole('link',{name:entry.url})).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(screen.queryByRole('link')).toBeNull();expect(view.container.textContent).not.toContain(entry.url);
});
it('overflow explicitly disclaims complete explanation and renders hostile retained labels only as text',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const label='<img src=x onerror=alert(1)>',view=render(<RetainedPhoneEvidence evidence={evidence([{...entry,label,labelStart:0,labelEnd:label.length}],true)}/>);
 expect(screen.getByText(/Additional refusal locations were omitted/u)).toBeTruthy();expect(view.container.querySelector('img')).toBeNull();expect(view.container.textContent).toContain(label);
});
it('aggregate expiry clears an empty truncated explanation in the actual inspector without changing feedback',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
 const phone=manualProspectPhoneEvidenceSchema.parse({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[],truncated:true,expiresAt:entry.authority.expiresAt}});
 const prospect=manualProspectSchema.parse({candidateId:runId,revision:1,observedName:'FICTIONAL retained company',website:null,locality:null,region:null,observedPhone:null,phoneBasis:'unknown',phoneEvidence:phone,sources:[{label:'Retained source',url:'https://source.example.test/',observedAt:null}],sourceNotices:[],retainedAt:entry.retrievedAt,state:'new',unknowns:[],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
 const feedback=vi.fn(),view=render(<ManualProspectCard prospect={prospect} disabled={false} feedback={feedback}/>);
 expect(screen.getByText(/Additional refusal locations were omitted/u)).toBeTruthy();expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(screen.queryByText(/Additional refusal/u)).toBeNull();expect(view.container.textContent).not.toContain('unresolved retained literal');
 expect(screen.getByRole('button',{name:'Keep'})).toBeTruthy();expect(feedback).not.toHaveBeenCalled();
 view.rerender(<ManualProspectCard prospect={prospect} disabled={false} feedback={feedback}/>);expect(screen.queryByText(/Additional refusal/u)).toBeNull();
});
