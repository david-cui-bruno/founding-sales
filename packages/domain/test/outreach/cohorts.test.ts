import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
let phoneSerial=100;
async function qualified(name:string,options:{locality?:string;website?:string;need?:string;phone?:string}={}){
 const locality=options.locality??'Dallas',website=options.website??`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:name,website,locality,region:'TX',signal:'fit_only',evidence:'Maintenance work',sourceUrl:website,observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),date=new Date().toISOString().slice(0,10);
 const blocks=[{id:'firm',text:`${name} is a residential property management company in ${locality}, Texas.`},{id:'phone',text:`Contact ${name} at ${options.phone??`(214) 555-${String(phoneSerial++).padStart(4,'0')}`}.`},{id:'email',text:`${name} ${locality} TX office info@${new URL(website).hostname}`},{id:'need',text:options.need??'Our team is overwhelmed by maintenance calls.'},{id:'date',text:`Published ${date}`}];
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_phone','phone'],['business_email','email'],['operational_burden','need']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 const finished=await tx(()=>finishQualification(ctx(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:`${date}T00:00:00Z`,publishedAtBlockId:'date',firstParty:true,truncated:false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
 await tx(()=>evaluateQualification(ctx(),{runId:request.value.runId}));
 return {candidateId:candidate.value.id,expectedRevision:1,qualificationRunId:request.value.runId,mode:'reviewed' as const};
}


it('previews without enrollment, refuses a changed preview, then activates only selected firms',async()=>{
 const {previewOutreachCohort,enableOutreachCohort}=await import('../../outreach/cohorts.ts');
 const {setProspectingAuthorization}=await import('../../outreach/authorization.ts');
 const {seedSequences}=await import('../sequences/support/sequenceFixtures.ts');
 const sequences=await seedSequences(db.session,seeded);
 const mailbox=(await db.session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','fixture-owner','connected') RETURNING id",[seeded.alpha.workspaceId,seeded.alpha.admin.userId])).rows[0]!.id;
 await tx(()=>setProspectingAuthorization(ctx(),{mailboxId:mailbox,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
 async function sequence(channels:string[]){
  const seq=(await db.session.query<{id:string}>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id',[seeded.alpha.workspaceId,randomUUID(),seeded.alpha.admin.userId])).rows[0]!.id;
  const version=(await db.session.query<{id:string}>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id',[seeded.alpha.workspaceId,seq])).rows[0]!.id;
  for(let i=0;i<channels.length;i++)await db.session.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id,on_no_answer) VALUES($1,$2,$3,$4,'elapsed',0,$5,$6)",[seeded.alpha.workspaceId,version,i+1,channels[i],channels[i]==='email'?sequences.alpha.template.templateVersionId:null,channels[i]==='call_task'?'retry_call':null]);
  await db.session.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$2 WHERE id=$1",[version,seeded.alpha.admin.userId]);return version;
 }
 const email=await sequence(Array<string>(5).fill('email')),call=await sequence(['call_task','email','call_task','email','call_task','email','call_task','email']);
 for(const lane of ['email_first','call_first']){
  const c=await qualified(lane==='email_first'?'Selected Email PM':'Selected Call PM',{phone:lane==='email_first'?'unknown':'(214) 555-0888'});
  const input={mailboxId:mailbox,candidateIds:[c.candidateId],emailSequenceVersionId:email,callSequenceVersionId:call};
  const before=(await db.session.query('SELECT id FROM sequence_enrollments')).rows.length;
  const preview=await previewOutreachCohort(ctx(),input);expect(preview.ok,JSON.stringify(preview)).toBe(true);if(!preview.ok)throw new Error(preview.reason);
  expect(preview.value.rows[0]).toMatchObject({lane,reason:null});
  expect((await db.session.query('SELECT id FROM sequence_enrollments')).rows).toHaveLength(before);
  expect(await tx(()=>enableOutreachCohort(ctx(),{...input,expectedHash:'0'.repeat(64),reviewed:true}))).toEqual({ok:false,reason:'preview_changed'});
  const enabled=await tx(()=>enableOutreachCohort(ctx(),{...input,expectedHash:preview.value.hash,reviewed:true}));expect(enabled.ok,JSON.stringify(enabled)).toBe(true);
  expect((await db.session.query('SELECT id FROM sequence_enrollments')).rows).toHaveLength(before+1);
  const again=await previewOutreachCohort(ctx(),input);expect(again).toMatchObject({ok:true,value:{rows:[{reason:'firm_already_enrolled'}]}});
 }
 expect((await db.session.query('SELECT id FROM opportunities')).rows).toHaveLength(0);
 expect((await db.session.query('SELECT id FROM phone_routes')).rows).toHaveLength(1);
 expect((await db.session.query("SELECT id FROM sending_domains WHERE automated_sending_enabled")).rows).toHaveLength(0);
});
