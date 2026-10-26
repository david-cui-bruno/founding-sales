import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {manualProspectPhoneEvidenceSchema} from '@fss/contracts';
import {projectManualPhone,type ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {scanManualLiteralPhones,type LiteralInput} from '../../sourcing/manualProspectLiteralPhone.ts';
import {composeProspectPhoneDiscovery,projectProspectPhoneDiscovery,prospectPhoneDiscoveryView} from '../../sourcing/prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from '../../sourcing/prospectPhoneDiscoveryStore.ts';
import {projectManualProspect} from '../../sourcing/manualProspectProjection.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualLiteralPhoneFixture} from './support/manualPhoneFixture.ts';
const now=Date.parse('2026-10-26T20:00:00.000Z');
function fixture(texts=['🏡 Phone: unavailable']){
 const original=manualLiteralPhoneFixture('https://source.example.test/phone',texts),source=original.observations[0]!;
 source.retrievedAt=new Date(now-1000).toISOString();
 const payload={...manualOrdinaryFixture(775),sourceUrl:source.url,website:'https://source.example.test/'};
 const snapshot:ManualPhoneSnapshot={id:randomUUID(),candidate_id:randomUUID(),candidate_revision:1,...original,payload,permitted_urls:[source.url]};
 const input:LiteralInput={runId:snapshot.id,observations:original.observations,website:payload.website,authorities:{[source.id]:{kind:'candidate_source',sourceUrl:source.url}},lineage:{kind:'provider_original'},now};
 return {snapshot,input,source,payload};
}
function discovery(texts=['Phone: unavailable']):PhoneDiscoveryRun{
 const f=fixture(texts);
 return {id:randomUUID(),candidate_id:f.snapshot.candidate_id,candidate_revision:1,creator_user_id:randomUUID(),creator_ref:'fixture',method:'company-public-phone-v1',state:'complete',reason:null,requested_at:new Date(now-2000),deadline_at:new Date(now+10000),checked_at:new Date(now),expires_at:new Date(now+5000),dispatched_at:new Date(now-1500),dispatch_finished_at:new Date(now),content:{website:f.payload.website,sourceUrls:[f.source.url],observations:[f.source]}};
}
it('zero-literal veto survives parser, strict schema, discovery view and ordinary row projector without an endpoint',()=>{
 const f=fixture(),evidence=manualProspectPhoneEvidenceSchema.parse(projectManualPhone(f.snapshot,now));
 const scan=scanManualLiteralPhones(f.input);
 expect(scan.diagnostics?.entries.every(entry=>f.source.blocks[0]!.text.slice(entry.labelStart,entry.labelEnd)===entry.label)).toBe(true);
 expect(evidence).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{truncated:false,entries:[{reason:'unattached_label_content',runId:f.snapshot.id,observationId:f.source.id,blockId:f.source.blocks[0]!.id,url:f.source.url,retrievedAt:f.source.retrievedAt,contentHash:f.source.contentHash,relevantTextHash:f.source.relevantTextHash,label:'Phone',labelStart:3,labelEnd:8,authority:f.input.authorities[f.source.id],lineage:f.input.lineage}]}});
 const row=projectManualProspect({id:f.snapshot.candidate_id,revision:1,payload:f.payload,origins:[],created_at:new Date(now),manual_state:'new',duplicate_count:0},evidence);
 expect(row).toMatchObject({observedPhone:null,phoneEvidence:evidence});
 const run=discovery(),phone=projectProspectPhoneDiscovery(run,now);
 expect(prospectPhoneDiscoveryView(run,phone).phoneEvidence).toMatchObject({state:'conflicting',sources:[],diagnostics:{entries:[{authority:{kind:'phone_discovery',runId:run.id,expiresAt:run.expires_at.toISOString()}}]}});
});
it.each([['Phone: 555-0123','unsupported_literal'],['Mobile phone: 2145550123','ambiguous_context'],['Phone: unavailable','unattached_label_content']])('explains %s without changing refusal classifier',(text,reason)=>{
 const f=fixture([text]);expect(manualProspectPhoneEvidenceSchema.parse(projectManualPhone(f.snapshot,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',diagnostics:{entries:[{reason}]}});
});
it('preserves two-number reason, source order and exact literal spans without inventing diagnostics',()=>{
 const f=fixture(['Phone: 2145550123','Phone: 2145550124']);
 expect(projectManualPhone(f.snapshot,now)).toMatchObject({state:'conflicting',reason:'multiple_retained_numbers',sources:[{literal:'2145550123'},{literal:'2145550124'}]});
 expect(projectManualPhone(f.snapshot,now)).not.toHaveProperty('diagnostics');
});
it('bounds diagnostics independently and deterministically with explicit incomplete explanation',()=>{
 const f=fixture(Array.from({length:20},()=> 'Phone: unavailable'));
 const a=projectManualPhone(f.snapshot,now),b=projectManualPhone(f.snapshot,now);
 expect(a).toEqual(b);expect(a).toMatchObject({state:'conflicting',sources:[],diagnostics:{truncated:true}});
 if(a.state!=='conflicting')throw Error('Expected refusal');
 expect(a.diagnostics?.entries).toHaveLength(16);expect(a.diagnostics?.entries.map(e=>e.blockId)).toEqual(f.source.blocks.slice(0,16).map(b=>b.id));
});
it.each(['hash','denied','future','malformed','truncated','bounds','changed'] as const)('clears all diagnostic prefixes and literal sources on %s',mode=>{
 const f=fixture(['Phone: unavailable','Phone: 2145550123']);
 if(mode==='hash')f.source.relevantTextHash='b'.repeat(64);
 if(mode==='denied')f.snapshot.permitted_urls=[];
 if(mode==='future')f.source.retrievedAt=new Date(now+1).toISOString();
 if(mode==='malformed')f.snapshot.observations={};
 if(mode==='truncated')f.source.truncated=true;
 if(mode==='bounds'){
  f.source.blocks=Array.from({length:18},(_,i)=>({id:`b${i}`,text:i===0?'Phone: unavailable':'Phone: 2145550123'}));
  f.source.relevantTextHash=createHash('sha256').update(JSON.stringify(f.source.blocks)).digest('hex');
 }
 if(mode==='changed')f.snapshot.dependency_changed=true;
 const evidence=projectManualPhone(f.snapshot,now);expect(evidence.state).toBe('not_extracted');expect(evidence).not.toHaveProperty('diagnostics');expect(evidence).not.toHaveProperty('sources');
});
it('drops earlier diagnostic metadata if a later observation loses authority',()=>{
 const f=fixture(),other=fixture();f.input.observations=[f.source,other.source];
 expect(scanManualLiteralPhones(f.input)).toMatchObject({sources:[],coverage:{state:'unavailable'}});
 expect(scanManualLiteralPhones(f.input)).not.toHaveProperty('diagnostics');
});
it('composes mixed-source refusals with max16 diagnostic entries and overflow, never a surviving winner',()=>{
 const legacy=projectManualPhone(fixture(Array.from({length:10},()=> 'Phone: unavailable')).snapshot,now);
 const run=discovery(Array.from({length:10},()=> 'Phone: unavailable')),phone=projectProspectPhoneDiscovery(run,now);
 const combined=manualProspectPhoneEvidenceSchema.parse(composeProspectPhoneDiscovery(legacy,phone));
 expect(combined).toMatchObject({state:'conflicting',sources:[],diagnostics:{truncated:true}});
 if(combined.state!=='conflicting')throw Error('Expected refusal');
 expect(combined.diagnostics?.entries).toHaveLength(16);expect(combined.diagnostics?.entries[10]?.authority).toMatchObject({kind:'phone_discovery'});
 const observed=projectManualPhone(fixture(['Phone: 2145550123']).snapshot,now);
 expect(composeProspectPhoneDiscovery(observed,phone)).toMatchObject({state:'conflicting',diagnostics:{entries:expect.any(Array)}});
 expect(composeProspectPhoneDiscovery(combined,projectProspectPhoneDiscovery({...run,content:null,state:'unavailable'},now))).not.toHaveProperty('diagnostics');
});
it('carries omitted discovery expiry when all16 retained entries are legacy, without a source-bound prefix',()=>{
 const full=projectManualPhone(fixture(Array.from({length:16},()=> 'Phone: unavailable')).snapshot,now);
 const run=discovery(),phone=projectProspectPhoneDiscovery(run,now),combined=manualProspectPhoneEvidenceSchema.parse(composeProspectPhoneDiscovery(full,phone));
 expect(combined).toMatchObject({state:'conflicting',sources:[],diagnostics:{truncated:true,expiresAt:run.expires_at.toISOString()}});
 if(combined.state!=='conflicting')throw Error('Expected refusal');
 expect(combined.diagnostics?.entries).toHaveLength(16);expect(combined.diagnostics?.entries.every(entry=>entry.authority.kind!=='phone_discovery')).toBe(true);
 const a=projectManualPhone(fixture(Array.from({length:10},()=> 'Phone: 2145550123')).snapshot,now);
 const b=projectProspectPhoneDiscovery(discovery(Array.from({length:10},()=> 'Phone: 2145550124')),now);
 expect(composeProspectPhoneDiscovery(a,b)).toEqual({state:'not_extracted',reason:'bounded_scan_incomplete'});
});
it('omits over200 zero-literal labels without changing refusal or losing diagnostic-only expiry',()=>{
 const text=`Office${' '.repeat(210)}phone: unavailable`,f=fixture([text]);
 expect(manualProspectPhoneEvidenceSchema.parse(projectManualPhone(f.snapshot,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[],truncated:true}});
 const run=discovery([text]);
 expect(manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[],truncated:true,expiresAt:run.expires_at.toISOString()}});
 expect(projectManualPhone(fixture([text.replace('unavailable','2145550123')]).snapshot,now)).toMatchObject({state:'not_extracted',reason:'bounded_scan_incomplete'});
});
it('scan count overflow keeps earliest expiry even when its location is beyond the16-entry bound',()=>{
 const a=fixture(Array.from({length:16},()=> 'Phone: unavailable')),b=fixture();
 const later=new Date(now+5000).toISOString(),earlier=new Date(now+1000).toISOString();
 a.input.observations=[a.source,b.source];a.input.authorities={[a.source.id]:{kind:'phone_discovery',runId:a.input.runId,expiresAt:later},[b.source.id]:{kind:'phone_discovery',runId:b.input.runId,expiresAt:earlier}};
 const scan=scanManualLiteralPhones(a.input);expect(scan).toMatchObject({unresolved:true,sources:[],diagnostics:{truncated:true,expiresAt:earlier}});
 expect(scan.diagnostics?.entries).toHaveLength(16);expect(scan.diagnostics?.entries.every(entry=>entry.observationId===a.source.id)).toBe(true);
});
it('clears expired discovery-only diagnostics and unavailable content without history fallback',()=>{
 const run=discovery();
 expect(projectProspectPhoneDiscovery(run,now+5000)).toEqual({state:'not_extracted',reason:'no_current_permitted_phone_evidence'});
 expect(projectProspectPhoneDiscovery({...run,state:'unavailable',content:null},now)).not.toHaveProperty('diagnostics');
});
it('keeps exact existing evidence authority and retained interpretation lineage, then clears lost ancestry',()=>{
 const f=fixture(),s=f.snapshot;
 s.payload={...f.payload,sourceUrl:'https://source.example.test/different'};
 const evidenceId=randomUUID();s.evidence_authorities=[{id:evidenceId,url:f.source.url,contentHash:f.source.contentHash,retrievedAt:f.source.retrievedAt}];
 Object.assign(s,{retained_identity_decision_id:randomUUID(),original_run_id:randomUUID(),original_revision:1,result_revision:1,ancestor_revision:1,decision_candidate_id:s.candidate_id,original_candidate_id:s.candidate_id,original_observations:structuredClone(s.observations),decision_observation_id:f.source.id,decision_block_id:f.source.blocks[0]!.id,decision_content_hash:f.source.contentHash,decision_text_hash:f.source.relevantTextHash});
 expect(projectManualPhone(s,now)).toMatchObject({state:'conflicting',diagnostics:{entries:[{authority:{kind:'retained_evidence',evidenceId},lineage:{kind:'retained_interpretation',decisionId:s.retained_identity_decision_id,originalRunId:s.original_run_id,originalRevision:1,resultRevision:1}}]}});
 s.original_observations=[];expect(projectManualPhone(s,now)).not.toHaveProperty('diagnostics');
});
it.each(['Phone;','Phone ,'])('P2 punctuation-only zero-literal veto preserves location and deadline: %s',text=>{
 const f=fixture([text]),run=discovery([text]);
 expect(manualProspectPhoneEvidenceSchema.parse(projectManualPhone(f.snapshot,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{truncated:false,entries:[{reason:'unattached_label_content',label:'Phone',labelStart:0,labelEnd:5}]}});
 expect(manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{truncated:false,expiresAt:run.expires_at.toISOString(),entries:[{reason:'unattached_label_content'}]}});
});
it('P2 oversized punctuation label omits only its location without losing existing conflict or expiry',()=>{
 const text=`Office${' '.repeat(210)}phone;`,run=discovery([text]);
 expect(manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run,now))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[],truncated:true,expiresAt:run.expires_at.toISOString()}});
});
it('P2 punctuation veto composes with an observed legacy endpoint without discarding expiry or selecting survivor',()=>{
 const legacy=manualProspectPhoneEvidenceSchema.parse({state:'observed',value:'+12145550123',sources:[{runId:randomUUID(),observationId:randomUUID(),blockId:'legacy',url:'https://source.example.test/legacy',retrievedAt:new Date(now-1000).toISOString()}]});
 if(legacy.state!=='observed')throw Error('Expected observed legacy fixture');
 const run=discovery(['Phone ,']),combined=manualProspectPhoneEvidenceSchema.parse(composeProspectPhoneDiscovery(legacy,projectProspectPhoneDiscovery(run,now)));
 expect(combined).toMatchObject({state:'conflicting',reason:'retained_source_ambiguous',sources:legacy.sources,diagnostics:{expiresAt:run.expires_at.toISOString(),entries:[{reason:'unattached_label_content'}]}});
});
