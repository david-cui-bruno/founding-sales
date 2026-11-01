import {createHash,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualProspectListSchema,type ManualPhoneChoice,type ManualProspect} from '@fss/contracts';

let f:AuthFixture,admin:string;
const read='/sourcing/candidates/prospects/list',feedback='/sourcing/candidates/prospects/feedback';
const website='https://pm-capture.example.test/',sourceUrl=website+'old',middle='https://www.pm-capture.example.test/new',final='https://www.pm-capture.example.test/contact';
const labelled='Office phone: (614) 725-3059',standalone='(614) 725-3059';
async function request(path:string,body:unknown){
 return dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${admin}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
/** A candidate with a completed v2 prepared source association over a retained own-site page. */
async function prepared(index:number,text:string){
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const saved=await withTransaction(f.db,()=>saveCandidate(ctx,{firmName:`Capture Property Management ${index}`,website,sourceUrl:sourceUrl+index,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional search label only',observedOn:'2026-10-30',preparedBy:'Fixture'}));
 if(!saved.ok)throw Error(saved.reason);
 const candidate=saved.value.id,run=randomUUID(),observationId=randomUUID(),blocks=[{id:'b1',text:'Our company manages residential homes and coordinates tenant maintenance requests for owners.'},{id:'b2',text}];
 const page={id:observationId,url:final,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-60_000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 await f.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version)
  VALUES($1,$2,$3,1,repeat('a',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5','prepared-source-association-v2')`,[f.alpha.workspaceId,run,candidate]);
 const manifest={version:'prepared-source-association-v2',candidateId:candidate,candidateRevision:1,sourceUrl:sourceUrl+index,pages:[{observationId,url:final,contentHash:page.contentHash,relevantTextHash:page.relevantTextHash,retrievedAt:page.retrievedAt,redirectUrls:[sourceUrl+index,middle,final]}]};
 await f.db.query("UPDATE sourcing_qualification_runs SET state='review',observations=$3::jsonb,prepared_capture=$4::jsonb WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,run,JSON.stringify([page]),JSON.stringify(manifest)]);
 return candidate;
}
const exact=async(id:string)=>{
 const answer=await request(read,{state:'all',offset:0,candidateId:id,expectedRevision:1,includeManualPhone:true});expect(answer.status).toBe(200);
 return manualProspectListSchema.parse(answer.body).prospects.find(p=>p.candidateId===id)!;
};
const choiceOf=(p:ManualProspect):ManualPhoneChoice=>{
 const evidence=p.phoneEvidence;if(evidence?.state!=='observed')throw Error('phone not observed');
 const s=evidence.sources[0];if(!s||!('method' in s))throw Error('literal missing');
 return {runId:s.runId,observationId:s.observationId,blockId:s.blockId,labelStart:s.labelStart,labelEnd:s.labelEnd,start:s.start,end:s.end,contentHash:s.contentHash,relevantTextHash:s.relevantTextHash};
};
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
it.each([['labelled',labelled],['standalone',standalone]])('shows and keeps a prepared own-site %s phone for the exact candidate through the authenticated API',async(_name,text)=>{
 const id=await prepared(text===labelled?1:2,text),p=await exact(id);
 expect(p.phoneEvidence).toMatchObject({state:'observed',value:'+16147253059',sources:[{url:final,authority:{kind:'prepared_capture'}}]});
 const choice=choiceOf(p),counts=async()=>(await f.db.query<{n:number}>('SELECT (SELECT count(*) FROM calling_preparations)::int+(SELECT count(*) FROM firms)::int+(SELECT count(*) FROM phone_routes)::int+(SELECT count(*) FROM dial_tickets)::int+(SELECT count(*) FROM jobs)::int AS n')).rows[0]!.n;
 const before=await counts();
 const kept=await request(feedback,{candidateId:id,expectedRevision:1,state:'kept',phoneChoice:choice,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 expect(kept.body).toMatchObject({status:'accepted',result:{candidateId:id,state:'kept',phoneChoice:choice}});
 expect((await exact(id)).manualPhone).toMatchObject({value:'+16147253059',choice,sourceUrl:final});
 // Choosing never prepares a company, route, ticket or job; Calling preparation keeps its own checks and refuses this source.
 const prep=await request('/calling/preparation/read',{candidateId:id,expectedCandidateRevision:1,choice});
 expect(prep.body).toMatchObject({state:'refused',reason:'source_withdrawn'});
 expect(await counts()).toBe(before);
});
it('refuses a stale prepared choice with the existing refusal and keeps nothing',async()=>{
 const id=await prepared(3,labelled),choice=choiceOf(await exact(id));
 const stale=await request(feedback,{candidateId:id,expectedRevision:1,state:'kept',phoneChoice:{...choice,contentHash:'b'.repeat(64)},commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 expect(stale.body).toMatchObject({status:'refused',reason:'phone_source_changed'});
 expect((await f.db.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1 AND manual_phone_choice IS NOT NULL',[id])).rows).toEqual([]);
});
