// @vitest-environment jsdom
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,within} from '@testing-library/react';
import {manualProspectPhoneEvidenceSchema} from '@fss/contracts';
import {projectProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from '@fss/domain/sourcing/prospectPhoneDiscoveryStore.ts';
import {projectManualProspect} from '@fss/domain/sourcing/manualProspectProjection.ts';
import {RetainedPhoneEvidence} from '../../src/client/RetainedPhoneEvidence.tsx';
const runId='00000000-0000-4000-8000-000000000001';
const now=Date.parse('2026-10-27T01:00:00.000Z');
const url='https://supply.example.test/contact';
function evidence(texts:string[]){
 const blocks=texts.map((text,index)=>({id:`b${index+1}`,text}));
 const run:PhoneDiscoveryRun={id:runId,candidate_id:runId,candidate_revision:1,creator_user_id:runId,creator_ref:runId,method:'company-public-phone-v1',state:'complete',reason:null,requested_at:new Date(now-2000),deadline_at:new Date(now+10000),checked_at:new Date(now),expires_at:new Date(now+1000),dispatched_at:new Date(now-1500),dispatch_finished_at:new Date(now),content:{website:'https://supply.example.test/',sourceUrls:[url],observations:[{id:'00000000-0000-4000-8000-000000000002',url,retrievedAt:new Date(now-1000).toISOString(),contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks}]}};
 return manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run,now));
}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('shows all supported retained alternatives without choosing a canonical phone or making network calls',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const fetch=vi.fn(()=>{throw Error('No acquisition');});vi.stubGlobal('fetch',fetch);
 const phone=evidence(['Office phone: (214) 555-0123','Main phone: 214-555-0124']);
 expect(phone.state).toBe('conflicting');expect(phone).not.toHaveProperty('value');
 const prospect=projectManualProspect({id:runId,revision:1,created_at:new Date(now),manual_state:'new',duplicate_count:0,origins:[],payload:{firmName:'FICTIONAL supply boundary',website:'https://supply.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Sanitized controlled retained observation.',sourceUrl:url,observedOn:'2026-10-27',preparedBy:'Controlled supply fixture'}},phone);
 expect(prospect).toMatchObject({observedPhone:null,phoneBasis:'unknown',qualification:'unverified',contactAuthority:'not_granted'});
 const original=JSON.stringify(phone),view=render(<RetainedPhoneEvidence evidence={phone}/>);
 expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();
 expect(screen.getByText(/Retained alternatives are for manual source review only/u)).toBeTruthy();
 expect(screen.getByText(/source restrictions and contact permission still apply/u)).toBeTruthy();
 const sources=screen.getByRole('list',{name:'Phone-specific sources'});
 const entries=within(sources).getAllByRole('listitem');expect(entries).toHaveLength(2);
 for(const [index,literal,normalized,label] of [[0,'(214) 555-0123','+12145550123','Office phone'],[1,'214-555-0124','+12145550124','Main phone']] as const){
  expect(within(entries[index]!).getByText(`Retained literal: ${literal}`)).toBeTruthy();
  expect(within(entries[index]!).getByText(`Supported normalized alternative: ${normalized}. Not selected or verified.`)).toBeTruthy();
  expect(within(entries[index]!).getByText(new RegExp(`Source label: ${label}`,'u'))).toBeTruthy();
  expect(within(entries[index]!).getByRole('link',{name:url}).getAttribute('href')).toBe(url);
  expect(entries[index]!.querySelector('time')?.getAttribute('datetime')).toBe(new Date(now-1000).toISOString());
 }
 expect(view.container.querySelector('a[href^="tel:"]')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
 expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(phone)).toBe(original);
});
it('keeps supported alternatives beside unresolved labels, but never turns unsupported personal/fax literals into alternatives',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const phone=evidence(['Office phone: 214-555-0123','Phone;','Fax: 214-555-0124','Personal phone: 214-555-0125']);
 expect(phone).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal'});
 const view=render(<RetainedPhoneEvidence evidence={phone}/>);
 expect(screen.getByText('Supported normalized alternative: +12145550123. Not selected or verified.')).toBeTruthy();
 expect(screen.getByText('Retained literal: 214-555-0124')).toBeTruthy();expect(screen.getByText('Retained literal: 214-555-0125')).toBeTruthy();
 expect(screen.getAllByText('Unsupported or ambiguous literal. No normalized alternative.')).toHaveLength(2);
 expect(view.container.textContent).not.toContain('+12145550124');expect(view.container.textContent).not.toContain('+12145550125');
 expect(screen.getByText(/Unattached label content:/u)).toBeTruthy();expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
});
it('erases every displayed alternative on expiry or source replacement instead of selecting a survivor',async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const phone=evidence(['Phone: 214-555-0123','Phone: 214-555-0124']);
 const view=render(<RetainedPhoneEvidence evidence={phone}/>);
 expect(view.container.textContent).toContain('+12145550123');
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(view.container.textContent).not.toContain('214');expect(screen.queryByRole('link')).toBeNull();
 view.rerender(<RetainedPhoneEvidence evidence={undefined}/>);view.rerender(<RetainedPhoneEvidence evidence={phone}/>);
 expect(view.container.textContent).not.toContain('214');
});
it('clears current alternatives immediately when the current source becomes unavailable without choosing another value',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const view=render(<RetainedPhoneEvidence evidence={evidence(['Phone: 214-555-0123','Phone: 214-555-0124'])}/>);
 expect(view.container.textContent).toContain('+12145550123');
 view.rerender(<RetainedPhoneEvidence evidence={manualProspectPhoneEvidenceSchema.parse({state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}})}/>);
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 expect(view.container.textContent).not.toContain('214');expect(screen.queryByRole('link')).toBeNull();
});
it('does not expose alternatives in compact summary or fabricate a literal from legacy facts',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const phone=evidence(['Phone: 214-555-0123','Phone: 214-555-0124']);
 const view=render(<RetainedPhoneEvidence compact evidence={phone}/>);
 expect(view.container.textContent).toBe('Phone conflicting · no number selected');
 const legacy=manualProspectPhoneEvidenceSchema.parse({state:'conflicting',reason:'retained_source_ambiguous',sources:[{runId,observationId:runId,blockId:'b1',url,retrievedAt:new Date(now).toISOString()}]});
 view.rerender(<RetainedPhoneEvidence evidence={legacy}/>);
 expect(screen.queryByText(/Retained literal:/u)).toBeNull();expect(screen.queryByText(/Supported normalized alternative:/u)).toBeNull();
});
it('keeps an observed normalized value distinct from unselected alternatives',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 render(<RetainedPhoneEvidence evidence={evidence(['Office phone: 214-555-0123'])}/>);
 expect(screen.getByText('Phone +12145550123 · observed, not call-ready')).toBeTruthy();
 expect(screen.getByText('Normalized retained value: +12145550123. Formatting, not verification.')).toBeTruthy();
 expect(screen.queryByText(/Supported normalized alternative:/u)).toBeNull();
});
it('renders unsupported literals only as escaped retained text without HTML or dial controls',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const phone=evidence(['Phone: 214-555-0123','Phone: 214-555-0124']);
 if(phone.state!=='conflicting')throw Error('Expected competing retained literals');
 const source=phone.sources[0]!;
 if(!('method' in source))throw Error('Expected literal');
 const literal='<img src=x onerror=alert(1)>',hostile=manualProspectPhoneEvidenceSchema.parse({...phone,sources:[{...source,literal,end:source.start+literal.length,normalizedValue:null,normalizationBasis:'unsupported'}]});
 const view=render(<RetainedPhoneEvidence evidence={hostile}/>);
 expect(screen.getByText(`Retained literal: ${literal}`)).toBeTruthy();expect(view.container.querySelector('img')).toBeNull();
 expect(screen.getByText('Unsupported or ambiguous literal. No normalized alternative.')).toBeTruthy();expect(screen.queryByText(/Supported normalized alternative:/u)).toBeNull();
 expect(view.container.querySelector('a[href^="tel:"]')).toBeNull();
});
