import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {CandidateInput,SourceObservation} from '@fss/contracts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import {originalAuthorities} from '../../sourcing/manualProspectOriginalAuthority.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {buildPreparedCapture,PREPARED_CAPTURE_V1} from '../../sourcing/preparedCapture.ts';

const candidateId='10000000-0000-4000-8000-000000000001',observationId='10000000-0000-4000-8000-000000000002',runId='10000000-0000-4000-8000-000000000003';
function fixture(){
 const now=Date.parse('2026-10-30T23:00:00Z'),sourceUrl='https://cedar.example.test/residential-management',url=sourceUrl+'/';
 const payload:CandidateInput={firmName:'Home | Cedar',website:'https://cedar.example.test/',sourceUrl,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Retained discovery label',observedOn:'2026-10-30',preparedBy:'Fictional capture acceptance'};
 const blocks=[{id:'business',text:'Our property management team manages residential homes for owners and coordinates tenant maintenance requests.'}];
 const source:SourceObservation={id:observationId,url,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};
 const row:ManualProspectRow={id:candidateId,revision:1,payload,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
 const manifest={version:'prepared-source-association-v1',candidateId,candidateRevision:1,sourceUrl,pages:[{observationId,url,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,retrievedAt:source.retrievedAt,redirectUrls:[sourceUrl,url]}]};
 const snapshot:ManualPhoneSnapshot={id:runId,candidate_id:candidateId,candidate_revision:1,payload,origins:[],observations:[source],facts:[],permitted_urls:[url],capture_policy_version:'prepared-source-association-v1',capture_state:'unavailable',prepared_capture:manifest};
 const read=()=>projectPreparedProspect(row,snapshot,{id:runId,candidate_revision:1},now);
 return {now,sourceUrl,url,payload,source,row,manifest,snapshot,read};
}

it('prepares intact company context reached through its actually recorded authorized slash redirect without broadening legacy authority',()=>{
 const f=fixture();
 expect(originalAuthorities(f.snapshot).authorities).toEqual({});
 expect(f.read()).toMatchObject({state:'prepared',coverage:'complete_retained_pages',contactAuthority:'not_granted',passages:[expect.objectContaining({observationId,url:f.url,quote:f.source.blocks[0]!.text})]});
});

it('does not invent a redirect or promote existing same-host/path-similar retained pages',()=>{
 const f=fixture();f.snapshot['prepared_capture']=null;
 expect(f.read()).toMatchObject({state:'needs_research',passages:[]});
});

it.each([
 ['legacy pin',(f:ReturnType<typeof fixture>)=>{f.snapshot['capture_policy_version']='legacy';}],
 ['pending capture',(f:ReturnType<typeof fixture>)=>{f.snapshot['capture_state']='pending';}],
 ['wrong candidate',(f:ReturnType<typeof fixture>)=>{f.manifest.candidateId=runId;}],
 ['wrong revision',(f:ReturnType<typeof fixture>)=>{f.manifest.candidateRevision=2;}],
 ['different source anchor',(f:ReturnType<typeof fixture>)=>{f.manifest.sourceUrl=f.sourceUrl+'/other';}],
 ['unrecorded direct request',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.redirectUrls=[f.url];}],
 ['unrelated same-host page',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.redirectUrls=[f.sourceUrl,'https://cedar.example.test/other',f.url];}],
 ['host alias',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.redirectUrls=[f.sourceUrl,'https://www.cedar.example.test/residential-management/',f.url];}],
 ['repeated hop',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.redirectUrls=[f.sourceUrl,f.url,f.sourceUrl,f.url];}],
 ['wrong content hash',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.contentHash='b'.repeat(64);}],
 ['wrong capture time',(f:ReturnType<typeof fixture>)=>{f.manifest.pages[0]!.retrievedAt=new Date(f.now-2000).toISOString();}],
 ['duplicate association',(f:ReturnType<typeof fixture>)=>{f.manifest.pages.push({...f.manifest.pages[0]!});}],
 ['changed original blocks',(f:ReturnType<typeof fixture>)=>{f.source.blocks[0]!.text+=' Mutated original.';}],
 ['lost source permission',(f:ReturnType<typeof fixture>)=>{f.snapshot.permitted_urls=[];}],
 ['third-party source',(f:ReturnType<typeof fixture>)=>{f.source.firstParty=false;}],
] as const)('refuses the new grant for %s',(_name,change)=>{
 const f=fixture();change(f);expect(f.read()).toMatchObject({state:'needs_research',passages:[],contactAuthority:'not_granted'});
});

it('builds associations only from a newly paired adapter trace, outside the model observation',()=>{
 const f=fixture(),binding={candidateId,candidateRevision:1,sourceUrl:f.sourceUrl};
 expect(buildPreparedCapture(binding,[{source:f.source,trace:undefined}],PREPARED_CAPTURE_V1)).toBeNull();
 expect(buildPreparedCapture(binding,[{source:f.source,trace:{version:'page-redirect-trace-v1',urls:[f.sourceUrl,f.url]}}],PREPARED_CAPTURE_V1)).toEqual(f.manifest);
 expect(Object.keys(f.source)).not.toContain('redirectTrace');expect(Object.keys(f.source)).not.toContain('prepared_capture');
});
