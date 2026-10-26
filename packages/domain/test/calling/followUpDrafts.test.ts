import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {callingWrapCommandSchema} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
import {saveManualProspectActivity} from '../../sourcing/manualProspectActivity.ts';
import {wrapCalling} from '../../calling/wrap.ts';
import {listCallingDrafts,readCallingDraft,saveCallingDraft} from '../../calling/followUpDrafts.ts';
import {sweepCallingDrafts} from '../../calling/followUpDraftLifecycle.ts';
let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces;
const authority=async()=>true,journal={append:async()=>{}};
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const run=<T>(work:()=>Promise<T>)=>withTransaction(runtime,work);
async function parent(index:number){const saved=await run(()=>saveCandidate(ctx(),manualOrdinaryFixture(index)));if(!saved.ok)throw Error(saved.reason);return saved.value.id;}
function input(candidateId:string){return callingWrapCommandSchema.parse({kind:'candidate',candidateId,expectedCandidateRevision:1,attemptId:randomUUID(),report:{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'conversation',note:'PRIVATE synthetic manual note',callback:null},promisedEmail:{draftId:randomUUID(),nextAction:'promised_email',subject:'Independent synthetic subject',body:'Independent synthetic body'},commandId:randomUUID(),clientVersion:'1.4.0'});}
beforeAll(async()=>{db=await createTestDatabase();console.info('Calling owned DB metadata',{database:db.name,template:process.env['FSS_TEST_TEMPLATE_DATABASE'],port:new URL(process.env['FSS_TEST_CLUSTER_URL']!).port});seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
it('actual raw wrap/current read/edit/withdraw uses creator-only current content and metadata-only history',async()=>{
 const command=input(await parent(79010));if(command.kind!=='candidate'||!command.promisedEmail)throw Error('Raw draft required');expect(await run(()=>wrapCalling(ctx(),command,authority,journal))).toMatchObject({ok:true,value:{followUp:{state:'queued_for_review'}}});
 const id=command.promisedEmail.draftId,read={draftId:id,expectedRevision:1};expect(await run(()=>readCallingDraft(ctx(),read,authority))).toMatchObject({content:{subject:command.promisedEmail.subject,body:command.promisedEmail.body},recipient:'unresolved',sendAuthority:'not_granted'});
 const list=await run(()=>listCallingDrafts(ctx(),{},authority));expect(list.drafts).toHaveLength(1);expect(JSON.stringify(list)).not.toMatch(/Independent|PRIVATE/u);
 const other=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),runtime);expect(await run(()=>readCallingDraft(other,read,authority))).toBeNull();
 expect(await run(()=>saveCallingDraft(ctx(),{operation:'update',...read,subject:'Edited once',body:'Edited current body'},authority))).toMatchObject({ok:true,value:{revision:2}});expect(await run(()=>saveCallingDraft(ctx(),{operation:'withdraw',...read},authority))).toMatchObject({ok:false,reason:'stale_revision'});expect(await run(()=>saveCallingDraft(ctx(),{operation:'withdraw',draftId:id,expectedRevision:2},authority))).toMatchObject({ok:true,value:{revision:3}});expect(await run(()=>readCallingDraft(ctx(),{draftId:id,expectedRevision:3},authority))).toMatchObject({availability:'withdrawn'});
 expect((await runtime.query('SELECT content FROM calling_follow_up_drafts WHERE id=$1',[id])).rows).toEqual([{content:null}]);expect((await runtime.query('SELECT count(*)::int n FROM call_logs')).rows[0]?.['n']).toBe(0);
});
it('existing manual report withdrawal physically erases independent promised text in the same transaction',async()=>{
 const command=input(await parent(79011));if(command.kind!=='candidate'||!command.promisedEmail)throw Error('Raw draft required');await run(()=>wrapCalling(ctx(),command,authority,journal));expect(await run(()=>saveManualProspectActivity(ctx(),{operation:'withdraw',candidateId:command.candidateId,expectedCandidateRevision:1,attemptId:command.attemptId,expectedActivityRevision:1},authority))).toMatchObject({ok:true});expect((await runtime.query('SELECT content,reason FROM calling_follow_up_drafts WHERE id=$1',[command.promisedEmail.draftId])).rows).toEqual([{content:null,reason:'source_changed_or_unavailable'}]);
});
it('source expiry sweep clears private draft without an arbitrary content-age horizon',async()=>{
 const command=input(await parent(79012));if(command.kind!=='candidate'||!command.promisedEmail)throw Error('Raw draft required');await run(()=>wrapCalling(ctx(),command,authority,journal));
 const firm=(await db.session.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'Synthetic retention fixture parent',seed.alpha.admin.userId])).rows[0]!.id;
 await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,clock_timestamp()-interval '1 second')`,[seed.alpha.workspaceId,firm,manualOrdinaryFixture(79012).sourceUrl,'d'.repeat(64)]);
 expect(await run(()=>sweepCallingDrafts(ctx(),{limit:20}))).toBe(1);expect((await runtime.query('SELECT content,reason FROM calling_follow_up_drafts WHERE id=$1',[command.promisedEmail.draftId])).rows).toEqual([{content:null,reason:'source_changed_or_unavailable'}]);
});
it('final current-principal refusal after report insertion rolls back report/draft/audit together',async()=>{
 const command=input(await parent(79013));if(command.kind!=='candidate'||!command.promisedEmail)throw Error('Raw draft required');let checks=0;await expect(run(()=>wrapCalling(ctx(),command,async()=>++checks<3,journal))).rejects.toThrow();for(const [table,column,value] of [['sourcing_manual_prospect_attempts','id',command.attemptId],['calling_follow_up_drafts','id',command.promisedEmail.draftId],['audit_events','subject_id',command.attemptId]])expect((await runtime.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[value])).rows).toEqual([]);
});
