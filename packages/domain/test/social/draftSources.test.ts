import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveAnswerBlock,approveAnswerBlock} from '../../outreach/facts.ts';
import {readSocialDraftSources} from '../../social/draftSources.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(beta=false)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
it('binds selected public evidence and approved facts to exact current revisions',async()=>{
 const id=randomUUID();await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,id,'a'.repeat(64),JSON.stringify({brief:'After-hours maintenance support for a small team.',firm_name:'PRIVATE FIRM'})]);
 const fact=await withTransaction(db.session,()=>saveAnswerBlock(ctx(),{kind:'product',text:'Callie integrates with AppFolio.'}));if(!fact.ok)throw new Error(fact.reason);
 await withTransaction(db.session,()=>approveAnswerBlock(ctx(),{id:fact.value.id,version:1}));
 const input={sourceRefs:[{kind:'public' as const,id,revision:1}],factBlocks:[{id:fact.value.id,version:1}]};
 const result=await readSocialDraftSources(ctx(),input);expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.reason);
 expect(JSON.stringify(result.value.input)).not.toContain('PRIVATE FIRM');expect(result.value.hash).toMatch(/^[a-f0-9]{64}$/);
 expect((await readSocialDraftSources(ctx(true),input)).ok).toBe(false);
 await db.session.query('UPDATE sourcing_candidates SET revision=2 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,id]);
 expect(await readSocialDraftSources(ctx(),input)).toEqual({ok:false,reason:'source_changed_or_unavailable'});
});
it('rejects empty selection and unavailable sources without accepting renderer-supplied text',async()=>{
 expect((await readSocialDraftSources(ctx(),{sourceRefs:[],factBlocks:[]})).ok).toBe(false);
 expect((await readSocialDraftSources(ctx(),{sourceRefs:[{kind:'call',id:randomUUID(),revision:1}],factBlocks:[]})).ok).toBe(false);
});
it('reads only the callers own transcript and emits no spoken identifying text',async()=>{
 const {createApplyWorld}=await import('../calls/support/applyWorld.ts');const {lines}=await import('../calls/analysisFixtures.ts');const world=await createApplyWorld();
 try{const firm=await world.newFirm();const call=await world.placeCall(firm,lines(['T','John at 51 Oak Street needs after-hours maintenance support.']));
  const request={sourceRefs:[{kind:'call' as const,id:call.sessionId,revision:1}],factBlocks:[]};
  const result=await readSocialDraftSources(world.salesperson(),request);expect(result.ok).toBe(true);
  if(result.ok){expect(JSON.stringify(result.value.input)).not.toContain('John');expect(result.value.input.themes).toContain('after_hours');}
  expect((await readSocialDraftSources(world.admin(),request)).ok).toBe(false);
 }finally{await world.drop();}
});
it('requires the assigned meeting owner and latest transcript version',async()=>{
 const {meetingTranscriptionFixture}=await import('../meetings/support/meetingTranscriptionFixture.ts');const f=await meetingTranscriptionFixture();
 try{const meeting=await f.meeting(),recording=await f.recording(meeting),transcript=await f.transcript(recording);
  await f.db.session.query('UPDATE meeting_transcripts SET utterances=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.workspace,transcript,JSON.stringify([{text:'We manually enter maintenance requests and chase vendor follow-ups.'}])]);
  const request={sourceRefs:[{kind:'meeting' as const,id:transcript,revision:1}],factBlocks:[]};
  const owner=repositoryContext(workspaceScope(f.workspace,{kind:'user',userId:f.seeded.alpha.salesperson.userId,role:'salesperson'}),f.db.session);
  expect((await readSocialDraftSources(owner,request)).ok).toBe(true);expect((await readSocialDraftSources(f.context,request)).ok).toBe(false);
  await f.db.session.query("INSERT INTO meeting_transcripts(workspace_id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$2,2,100,'en-US','[]'::jsonb)",[f.workspace,recording]);
  expect((await readSocialDraftSources(owner,request)).ok).toBe(false);
 }finally{await f.db.drop();}
});
it('lets only the worker resolve a durable owners sources and rechecks active membership',async()=>{
 const id=randomUUID();await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,id,'b'.repeat(64),JSON.stringify({brief:'After-hours maintenance support.'})]);
 const request={sourceRefs:[{kind:'public' as const,id,revision:1}],factBlocks:[]};
 const worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
 const {readSocialDraftSourcesForWorker}=await import('../../social/draftSources.ts');
 expect((await readSocialDraftSourcesForWorker(worker,seed.alpha.salesperson.userId,request)).ok).toBe(true);
 expect((await readSocialDraftSourcesForWorker(ctx(),seed.alpha.salesperson.userId,request)).ok).toBe(false);
 expect((await readSocialDraftSourcesForWorker(worker,seed.beta.admin.userId,request)).ok).toBe(false);
 expect((await readSocialDraftSources(worker,request)).ok).toBe(false);
 await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 try{expect(await readSocialDraftSourcesForWorker(worker,seed.alpha.salesperson.userId,request)).toEqual({ok:false,reason:'owner_unavailable'});
 expect(await readSocialDraftSources(repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session),request)).toEqual({ok:false,reason:'owner_unavailable'});
 }finally{await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);}
});
