import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {crmProcessingResultSchema,todayActionsResponseSchema} from '@fss/contracts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('keeps a bounded 50-promise Today page and unrelated unanswered work with truthful overflow',async()=>{
 const fixture=await createAuthFixture();try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const options={session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},options);
  const get=(path:string)=>dispatch({method:'GET',path,body:null,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},options);
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const personId=((await post('/crm/people/create',command({fullName:'Bounded promises'}))).body as {result:{personId:string}}).result.personId;
  const quotes=Array.from({length:51},(_,index)=>`I will prepare item ${index+1} by October 12.`);
  const batches=[quotes.slice(0,50),quotes.slice(50)];
  for(const [index,batch] of batches.entries())expect((await post('/crm/people/source/add',command({personId,sourceKey:`bounded-${index}`,excerpt:batch.join('\n'),occurredAt:'2026-10-01T14:00:00Z'}))).status).toBe(200);
  const sources=((await post('/crm/people/read',{personId})).body as {sources:{sourceId:string;workspaceId:string;revision:number;contentHash:string;excerpt:string}[]}).sources;
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'bounded-eval',modelVersion:'bounded-v1',accessGrantVersion:'fixture',dataHandlingVersion:'fixture',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{ allowControlledEvaluation:true,adapter:{endpointId:'bounded-eval',modelVersion:'bounded-v1',accessGrantVersion:'fixture',dataHandlingVersion:'fixture',providerKey:'fixture.bounded',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async({text})=>({acceptance:'accepted',usage:{inputTokens:1,outputTokens:1},claims:text.split('\n').map(quote=>({kind:'commitment',status:'stated',interpretation:'A human must attest the promise',quote,locator:`text:${text.indexOf(quote)}:${text.indexOf(quote)+quote.length}`}))})}}});
  for(const row of sources){
   const source={workspaceId:row.workspaceId,sourceId:row.sourceId,kind:'selected_note' as const,revision:row.revision,contentHash:row.contentHash,locator:null};
   expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
   await runOnce(fixture.db,{registry,owner:'bounded-extract',limit:20});
   const processed=crmProcessingResultSchema.parse((await post('/crm/processing/read',{source})).body);if(!('generationId' in processed)||processed.state!=='complete')throw new Error('controlled extraction missing');
   for(const claim of processed.claims)expect((await post('/crm/commitments/review',command({source,claimId:claim.claimId,claimRevision:1,claimHash:claim.claimHash,contextHash:processed.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:'internal_promise',actor:'self',actionLabel:claim.quote,due:{kind:'date',date:'2026-10-12',zone:'UTC',expression:'by October 12'}}))).status).toBe(200);
   for(let pass=0;pass<3;pass++)await runOnce(fixture.db,{registry,owner:'bounded-project',limit:20});
  }
  const ws=fixture.alpha.workspaceId,owner=fixture.alpha.admin.userId;
  const firm=(await fixture.db.query<{id:string}>("INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,'Unrelated reply firm',$2) RETURNING id",[ws,owner])).rows[0]!;
  const opportunity=(await fixture.db.query<{id:string}>("INSERT INTO opportunities(workspace_id,firm_id,status,stage_id,control_mode_changed_at) VALUES($1,$2,'open',(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id",[ws,firm.id])).rows[0]!;
  const mailbox=(await fixture.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address) VALUES($1,$2,'bounded@example.test') RETURNING id",[ws,owner])).rows[0]!;
  const message=(await fixture.db.query<{id:string}>("INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date) VALUES($1,$2,$3,'unanswered','incoming',now()-interval '4 days') RETURNING id",[ws,mailbox.id,randomUUID()])).rows[0]!;
  await fixture.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[ws,message.id]);
  await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread')",[ws,message.id,firm.id,opportunity.id]);
  const legacy=todayActionsResponseSchema.parse((await get('/today/actions')).body);expect(legacy.actions.some(action=>action.target.kind==='reply'&&action.target.messageId===message.id)).toBe(true);
  const answer=await get('/today/actions/v2');expect(answer.status).toBe(200);
  const body=answer.body as {actions:{kind:string}[];promiseCoverage:{scope:string;truncated:boolean;nextAfterId:string|null}};
  expect(body.actions.filter(action=>action.kind==='promise')).toHaveLength(50);
  expect(body.actions[0]?.kind).toBe('reply');
  expect(body.promiseCoverage).toEqual({scope:'current_authorized_work',truncated:true,nextAfterId:expect.any(String)});
 }finally{await fixture.stop();}
},90_000);
