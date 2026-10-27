import {createHash} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {projectProspectPhoneDiscovery,prospectPhoneDiscoveryView} from '../../sourcing/prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from '../../sourcing/prospectPhoneDiscoveryStore.ts';
import type {ProspectPhoneRefusalOriginalInput} from '@fss/contracts';
import {readProspectPhoneRefusalOriginal} from '../../sourcing/prospectPhoneRefusalOriginal.ts';
const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../../sourcing/prospectPhoneDiscovery.ts',()=>({readProspectPhoneDiscoverySnapshot:mocks.read}));
const id='10000000-0000-4000-8000-000000000001',candidateId='10000000-0000-4000-8000-000000000002',observationId='10000000-0000-4000-8000-000000000003';
const now=Date.now(),text='PHONE: Ask our <b>office</b> for help. Whole retained tail.';
const input:ProspectPhoneRefusalOriginalInput={candidateId,expectedRevision:1,runId:id,observationId,blockId:'original',labelStart:0,labelEnd:5,reason:'unattached_label_content'};
const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),{query:async()=>({rows:[{at:new Date(now)}],rowCount:1})} as never);
function fixture(){
 const blocks=[{id:'original',text}],run:PhoneDiscoveryRun={id,candidate_id:candidateId,candidate_revision:1,creator_user_id:id,creator_ref:id,method:'company-public-phone-v1',state:'complete',reason:null,requested_at:new Date(now-1000),deadline_at:new Date(now+1000),checked_at:new Date(now),expires_at:new Date(now+60000),dispatched_at:new Date(now-1000),dispatch_finished_at:new Date(now),content:{website:'https://fixture.example.test/',sourceUrls:['https://fixture.example.test/about'],observations:[{id:observationId,url:'https://fixture.example.test/contact',contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(now-500).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks}]}};
 return {run,view:prospectPhoneDiscoveryView(run,projectProspectPhoneDiscovery(run,now)),now};
}
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockImplementation(async()=>({ok:true,value:fixture()}));});
it('reads one whole original only through the current composed read snapshots, with exact provenance and no channel authority',async()=>{
 const authority=vi.fn(async()=>true),result=await readProspectPhoneRefusalOriginal(ctx,input,authority);
 expect(result).toMatchObject({ok:true,value:{candidateId,candidateRevision:1,text,purpose:'manual_refusal_review',channelAuthority:'not_granted',location:{runId:id,observationId,blockId:'original',label:'PHONE',authority:{kind:'phone_discovery',runId:id},lineage:{kind:'provider_original'}}}});
 expect(mocks.read).toHaveBeenCalledTimes(2);expect(mocks.read).toHaveBeenCalledWith(ctx,{candidateId,expectedRevision:1},authority);
});
it.each([{runId:observationId},{observationId:id},{blockId:'other'},{expectedRevision:2},{labelStart:1},{labelEnd:4},{reason:'unsupported_literal' as const}])('refuses an exact refusal mismatch %j',async change=>{
 expect(await readProspectPhoneRefusalOriginal(ctx,{...input,...change})).toEqual({ok:false,reason:'source_changed'});
});
it.each(['omitted','legacy','label','source','hash','whole','expired','unavailable'] as const)('refuses all text for %s, never a surviving prefix',async change=>{
 const f=fixture();if(f.view.phoneEvidence.state!=='conflicting')throw Error('fixture');
 const location=f.view.phoneEvidence.diagnostics!.entries[0]!;
 if(change==='omitted')f.view.phoneEvidence.diagnostics!.entries=[];
 if(change==='legacy')location.authority={kind:'candidate_source',sourceUrl:location.url};
 if(change==='label')location.label='phone';
 if(change==='source')f.run.content!.observations[0]!.url='https://foreign.example.test/';
 if(change==='hash')f.run.content!.observations[0]!.relevantTextHash='c'.repeat(64);
 if(change==='whole')f.run.content!.observations.push({...f.run.content!.observations[0]!,id,blocks:[{id:'over',text:'x'.repeat(16001)}]});
 if(change==='expired')f.run.expires_at=new Date(now-1);
 if(change==='unavailable')f.run.content=null;
 mocks.read.mockResolvedValue({ok:true,value:f});expect(await readProspectPhoneRefusalOriginal(ctx,input)).toEqual({ok:false,reason:'source_changed'});
});
it.each(['composition','text','principal','missing'] as const)('erases selection after final read wait: %s',async change=>{
 mocks.read.mockResolvedValueOnce({ok:true,value:fixture()});const f=fixture();
 if(change==='composition')f.view.phoneEvidence={state:'not_extracted',reason:'original_not_usable'};
 if(change==='text')f.run.content!.observations[0]!.blocks[0]!.text+=' changed';
 mocks.read.mockResolvedValueOnce(change==='principal'?{ok:false,reason:'authority_changed'}:{ok:true,value:change==='missing'?null:f});
 const result=await readProspectPhoneRefusalOriginal(ctx,input);expect(result).toEqual({ok:false,reason:change==='principal'?'authority_changed':'source_changed'});expect(JSON.stringify(result)).not.toContain(text);
});
it('final clock expiry erases the whole selected original even with unchanged retained snapshots',async()=>{
 mocks.read.mockResolvedValueOnce({ok:true,value:fixture()});const last=fixture();last.now=now+60001;mocks.read.mockResolvedValueOnce({ok:true,value:last});
 expect(await readProspectPhoneRefusalOriginal(ctx,input)).toEqual({ok:false,reason:'source_changed'});
});
