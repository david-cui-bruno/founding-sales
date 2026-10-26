// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {manualProspectPhoneEvidenceSchema} from '@fss/contracts';
import {RetainedPhoneEvidence} from '../../src/client/RetainedPhoneEvidence.tsx';

const value='+12145550123';
const source={runId:'00000000-0000-4000-8000-000000000001',observationId:'00000000-0000-4000-8000-000000000002',blockId:'contact',url:'https://phone.example.test/contact',retrievedAt:'2026-10-25T12:34:56.000Z'};
const literal={...source,method:'retained_original_literal',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',literal:'214-555-0123',start:8,end:20,label:'Office',labelStart:0,labelEnd:6,normalizedValue:value,normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{kind:'candidate_source',sourceUrl:source.url},lineage:{kind:'provider_original'}};
const coverage={parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1};
afterEach(cleanup);
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
 expect(screen.getByText(/Coverage is limited to permitted retained inputs/u)).toBeTruthy();
 expect(container.querySelector('a[href^="tel:"]')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
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
 expect(container.textContent).not.toContain(value);
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
