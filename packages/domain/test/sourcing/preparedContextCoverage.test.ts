import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {preparedProspectBriefSchema,type CandidateInput,type SourceObservation} from '@fss/contracts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';

const candidateId='10000000-0000-4000-8000-000000000001',observationId='10000000-0000-4000-8000-000000000002',runId='10000000-0000-4000-8000-000000000003';
const maintenance='All maintenance is taken care of promptly to support resident satisfaction and tenant retention.';
function fixture(texts:string[],website='https://cedar.example.test/'){
 const now=Date.parse('2026-10-30T23:00:00Z');
 const payload:CandidateInput={firmName:'Home | Cedar',website,sourceUrl:website,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional retained discovery context',observedOn:'2026-10-30',preparedBy:'Controlled context coverage'};
 const blocks=texts.map((text,index)=>({id:'passage-'+index,text}));
 const source:SourceObservation={id:observationId,url:website,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};
 const row:ManualProspectRow={id:candidateId,revision:1,payload,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:runId,candidate_id:candidateId,candidate_revision:1,payload,origins:[],observations:[source],facts:[],permitted_urls:[website]};
 const read=()=>preparedProspectBriefSchema.parse(projectPreparedProspect(row,snapshot,{id:runId,candidate_revision:1},now));
 return {source,row,snapshot,read};
}

it('prepares substantive maintenance context while residential fit and company identity remain unknown',()=>{
 const f=fixture([maintenance,'Office: 42 Fictional Street, Boston MA 02108. General office: (617) 555-0123.']);
 const brief=f.read();expect(brief).toMatchObject({state:'prepared',contactAuthority:'not_granted'});
 expect(brief.passages).toContainEqual(expect.objectContaining({kind:'workflow',quote:maintenance,observationId,url:f.source.url}));
 expect(brief.unknowns.join(' ')).toMatch(/residential.*(?:unknown|not established|unverified)/iu);
 expect(brief.unknowns.join(' ')).toMatch(/publisher.*identity.*(?:not|unverified)/iu);
});

it('attributes directory-profile context to its retained site without claiming company first-party publication',()=>{
 const f=fixture(['Cedar Property Management manages residential homes for owners across Boston, Massachusetts.'],'https://directory.example.test/property-managers/cedar');
 const brief=f.read();expect(brief.state).toBe('prepared');
 expect(brief.summary).not.toMatch(/first.party|company.s own/iu);
 expect(brief.summary).toMatch(/(?:retained|source|site).*context/iu);
 expect(brief.unknowns.join(' ')).toMatch(/publisher.*identity.*(?:not|unverified)/iu);
 expect(brief.passages[0]?.url).toBe(f.source.url);
});

it.each([
 maintenance,
 'Our tenants submit maintenance requests through the portal.',
 'Our team coordinates maintenance requests and repairs for residents.',
 'Our team tracks tenant maintenance requests using software built for our staff.',
])('prepares concise genuine operational context: %s',text=>{
 const brief=fixture([text]).read();expect(brief.state).toBe('prepared');
 expect(brief.passages).toContainEqual(expect.objectContaining({kind:'workflow',quote:text}));
 expect(brief.unknowns.join(' ')).toMatch(/residential.*unknown/iu);
});

it.each([
 'Emergency maintenance hotline: (617) 555-0123. Call our office for all after-hours emergencies.',
 'Emergency maintenance requests are handled by calling our office at (617) 555-0123.',
 'Our office is located at 42 Fictional Street, Boston MA 02108. Call (617) 555-0123 for tenant maintenance questions.',
 'Maintenance requests and repair services for tenants and property owners',
 'Tenant maintenance office | Copyright 2026 Cedar | 42 Fictional Street | (617) 555-0123',
 'Our platform automates maintenance requests and tenant communication for property managers.',
 'Our team tracks tenant maintenance requests using the software platform we sell to property managers.',
 'Maintenance requests are processed by our software platform to keep every property manager informed.',
 'Our maintenance solutions are designed to handle repair requests and tenant communication efficiently.',
 'Our team is available around the clock for maintenance requests and tenant questions.',
 'Our team processes customer support requests and responds to software users within one business day.',
 'Customer review: Our tenants submit maintenance requests through the portal and the team handles them promptly.',
 'Our team does not handle maintenance requests or coordinate repairs for residents.',
])('does not promote endpoint noise, promotional or attributed text: %s',text=>{
 expect(fixture([text]).read()).toMatchObject({state:'needs_research',contactAuthority:'not_granted'});
});

it('keeps a substantive operational passage visible ahead of generic workflow headings',()=>{
 const f=fixture(['Maintenance requests and service information for residents','Tenant maintenance contact information and service menu','After-hours repair requests and emergency telephone directory',maintenance]);
 expect(f.read()).toMatchObject({state:'prepared',passages:expect.arrayContaining([expect.objectContaining({kind:'workflow',quote:maintenance})])});
});

it.each([false,true])('retains contrary refusal alongside operational context, oversized=%s',oversized=>{
 const denial='We do not manage residential homes. '+(oversized?'Retained scope context. '.repeat(100):'Our business serves commercial owners only.');
 const brief=fixture([maintenance,denial]).read();expect(brief.state).toBe('needs_research');
 expect(brief.unknowns.join(' ')).toMatch(/contrary/iu);
});
