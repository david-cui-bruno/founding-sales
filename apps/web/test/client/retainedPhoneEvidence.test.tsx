// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {manualProspectPhoneEvidenceSchema} from '@fss/contracts';
import {RetainedPhoneEvidence} from '../../src/client/RetainedPhoneEvidence.tsx';

const value='+12145550123';
const source={runId:'00000000-0000-4000-8000-000000000001',observationId:'00000000-0000-4000-8000-000000000002',blockId:'contact',url:'https://phone.example.test/contact',retrievedAt:'2026-10-25T12:34:56.000Z'};
const literal={...source,method:'retained_original_literal',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',literal:'214-555-0123',start:8,end:20,label:'Office',labelStart:0,labelEnd:6,normalizedValue:value,normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{kind:'candidate_source',sourceUrl:source.url},lineage:{kind:'provider_original'}};
const coverage={parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1};
afterEach(()=>{cleanup();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');vi.useRealTimers();vi.unstubAllGlobals();});
// jsdom has no modal dialog; this supplies only the open/close state the platform would.
function dialogs(){
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});
}
it('retained phone literal renders exact source label, URL and retrieval time without claiming type or verification',()=>{
 const evidence=manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[literal],coverage});
 const {container}=render(<RetainedPhoneEvidence evidence={evidence}/>);
 expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 expect(screen.getByText(/Source label: Office/u)).toBeTruthy();
 expect(screen.getByText(/Phone type unknown\. Ownership/u)).toBeTruthy();
 const link=screen.getByRole('link',{name:source.url});
 expect(link.getAttribute('href')).toBe(source.url);expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
 expect(container.querySelector('time')?.getAttribute('datetime')).toBe(source.retrievedAt);
 expect(screen.getByText(/Not a fresh check or phone verification/u)).toBeTruthy();
 expect(container.querySelector('a[href^="tel:"]')).toBeNull();expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();
});
it('retained phone legacy fact keeps unknown type and is never relabelled literal extraction',()=>{
 render(<RetainedPhoneEvidence evidence={manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[source]})}/>);
 expect(screen.getByText(/retained business_phone fact, not literal extraction/u)).toBeTruthy();
 expect(screen.queryByText(/Source label:/u)).toBeNull();expect(screen.getByRole('link').getAttribute('href')).toBe(source.url);
});
it.each(['javascript:alert(1)','data:text/html,test','https://user:secret@example.test/','tel:+12145550123'])('retained phone refuses unsafe source link %s',url=>{
 render(<RetainedPhoneEvidence evidence={manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[{...source,url}]})}/>);
 expect(screen.queryByRole('link')).toBeNull();expect(screen.getByText('Source URL unavailable or unsafe.')).toBeTruthy();expect(screen.queryByText(url)).toBeNull();
});
it.each([
 {state:'not_extracted',reason:'optional_source_changed',coverage:{...coverage,state:'changed'}},
 {state:'not_extracted',reason:'bounded_scan_incomplete',coverage:{...coverage,state:'bounded'}},
 {state:'not_extracted',reason:'original_not_usable',coverage:{...coverage,state:'unavailable'}},
 {state:'absent',basis:'retained_source_declares_absent'},
 {state:'conflicting',reason:'unresolved_retained_literal',sources:[literal],coverage},
])('retained phone preserves $state and never selects an alternate',input=>{
 const evidence=manualProspectPhoneEvidenceSchema.parse(input);
 const {container}=render(<RetainedPhoneEvidence evidence={evidence}/>);
 if(evidence.state==='conflicting'){
  expect(screen.getByText(`Retained literal: ${literal.literal}`)).toBeTruthy();
  expect(screen.getByText(`Supported normalized alternative: ${value}. Not selected or verified.`)).toBeTruthy();
  expect(evidence).not.toHaveProperty('value');
  expect(container.querySelector('a[href^="tel:"]')).toBeNull();expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();
 }else expect(container.textContent).not.toContain(value);
 expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
 if(evidence.state==='conflicting'){expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();expect(screen.getByRole('link',{name:source.url})).toBeTruthy();}
 else if(evidence.state==='absent')expect(screen.getByText(/Phone absent · retained source explicitly declares absent/u)).toBeTruthy();
 else expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
});
it('retained phone legacy missing evidence stays unknown and compact mode exposes no sources or interactions',()=>{
 const view=render(<RetainedPhoneEvidence evidence={undefined}/>);expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 view.rerender(<RetainedPhoneEvidence compact evidence={manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[literal],coverage})}/>);
 expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 expect(screen.queryByRole('link')).toBeNull();expect(screen.queryByText(/Source label:/u)).toBeNull();expect(view.container.querySelector('details')).toBeNull();
});
it('offers a Calling choice for a labelled or standalone number from a phone discovery or prepared page, and only those',()=>{
 const v2={...coverage,parser:'manual-literal-phone-v2'};
 const discovery={kind:'phone_discovery',runId:source.runId,expiresAt:'2099-01-01T00:00:00.000Z'};
 const prepared={kind:'prepared_capture',sourceUrl:source.url,expiresAt:'2099-01-01T00:00:00.000Z'};
 const labelled={...literal,parser:'manual-literal-phone-v2',authority:discovery};
 const standalone={...labelled,literal:'(214) 555-0123',start:0,end:14,label:'(214) 555-0123',labelStart:0,labelEnd:14};
 const choose=()=>undefined;
 const show=(sources:unknown[],cover=v2)=>manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources,coverage:cover});
 const view=render(<RetainedPhoneEvidence evidence={show([labelled])} onPhoneChoice={choose}/>);
 expect(screen.getByRole('button',{name:`Keep ${value} in Calling`})).toBeTruthy();
 view.rerender(<RetainedPhoneEvidence evidence={show([standalone])} onPhoneChoice={choose}/>);
 expect(screen.getByRole('button',{name:`Keep ${value} in Calling`})).toBeTruthy();expect(screen.getByText('Standalone published number; its own text is the label.')).toBeTruthy();
 view.rerender(<RetainedPhoneEvidence evidence={show([{...standalone,authority:prepared}],{...v2,state:'partial'})} onPhoneChoice={choose}/>);
 expect(screen.getByRole('button',{name:`Keep ${value} in Calling`})).toBeTruthy();
 expect(screen.getByText(/Read from this company's own retained pages as the prepared brief cites them\. Other pages and passages are not covered/u)).toBeTruthy();
 view.rerender(<RetainedPhoneEvidence evidence={show([{...labelled,authority:{kind:'candidate_source',sourceUrl:source.url}}])} onPhoneChoice={choose}/>);
 expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();
 view.rerender(<RetainedPhoneEvidence evidence={show([{...labelled,authority:prepared}])}/>);
 expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();
});
it('erases prepared phone evidence once its prepared source deadline passes',()=>{
 const prepared={kind:'prepared_capture',sourceUrl:source.url,expiresAt:'2000-01-01T00:00:00.000Z'};
 render(<RetainedPhoneEvidence evidence={manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[{...literal,parser:'manual-literal-phone-v2',authority:prepared}],coverage:{...coverage,parser:'manual-literal-phone-v2',state:'partial'}})} onPhoneChoice={()=>undefined}/>);
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();
});
it.each(['phone_discovery','prepared_capture'] as const)('an open phone diagnostics dialog erases every literal, URL and lineage id when its %s source expires',async kind=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));dialogs();
 const expiresAt='2026-10-26T20:00:05.000Z';
 const authority=kind==='phone_discovery'?{kind,runId:source.runId,expiresAt}:{kind,sourceUrl:source.url,expiresAt};
 const evidence=manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[{...literal,parser:'manual-literal-phone-v2',authority}],coverage:{...coverage,parser:'manual-literal-phone-v2'}});
 const fetcher=vi.fn(()=>{throw Error('Expiry is local erasure; no read or replay is permitted');});vi.stubGlobal('fetch',fetcher);
 const view=render(<RetainedPhoneEvidence evidence={evidence}/>);
 fireEvent.click(screen.getByRole('button',{name:'Phone diagnostics'}));
 const dialog=screen.getByRole('dialog',{name:'Phone diagnostics'});
 // While current, the technical lineage is exactly this source's.
 expect(dialog.textContent).toContain(source.runId);expect(dialog.textContent).toContain(source.observationId);expect(view.container.textContent).toContain(literal.literal);
 await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
 const remaining=document.body.textContent??'';
 for(const secret of [value,literal.literal,source.url,source.runId,source.observationId])expect(remaining).not.toContain(secret);
 expect(view.container.querySelector('a')).toBeNull();expect(screen.queryByRole('button',{name:/^Keep /u})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});
