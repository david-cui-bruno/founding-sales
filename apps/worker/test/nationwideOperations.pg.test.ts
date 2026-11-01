import {afterEach,beforeEach,expect,it} from 'vitest';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {seedCrm} from '@fss/domain/test/db/support/crmFixtures.ts';
import {beginFirmResearch} from '@fss/domain/research/enrichment.ts';
import {recordProviderCall} from '@fss/domain/research/ledger.ts';
import {ensureTargetingPolicy,readTargetingPolicy} from '@fss/domain/sourcing/targetingProposals.ts';
import {readResearchSettings,updateResearchSettings} from '@fss/domain/research/settings.ts';
import {targetingConfigureCommand} from '../src/tools/fss/targetingConfigure.ts';
import {researchSetCeilingsCommand} from '../src/tools/fss/researchSetCeilings.ts';
import {researchStatusCommand} from '../src/tools/fss/researchStatus.ts';
let db:Awaited<ReturnType<typeof createTestDatabase>>,seed:Awaited<ReturnType<typeof seedTwoWorkspaces>>,ctx:ReturnType<typeof repositoryContext>;
const launch={launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/fixture'};
const common=()=>({'--workspace-id':seed.alpha.workspaceId,'--owner-user-id':seed.alpha.admin.userId});
const researchOptions=()=>({...common(),'--daily-cents':'1000','--monthly-cents':'20000'});
async function targetingOptions(){const p=await readTargetingPolicy(ctx);return {...common(),'--proposal-json-base64':Buffer.from(JSON.stringify({basePolicyVersion:p.version,
 queryChanges:Array.from({length:48},(_,i)=>({id:`national-fixture-${i}`,query:`Fictional city ${i} residential property management`,locality:`City ${i}`,region:'CA'})),
 rankOrder:p.rankOrder,evidenceIds:[],rationale:'Fictional capacity operation fixture.'})).toString('base64')};}
async function snapshot(){
 const result:Record<string,unknown>={};
 for(const table of ['sourcing_targeting_versions','sourcing_targeting_proposals','sourcing_discovery_settings','research_settings','audit_events','workspace_settings','sourcing_discovery_attempts','sourcing_search_account','provider_reservations','jobs'])
  result[table]=(await ctx.db.query(`SELECT to_jsonb(t)::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
}
beforeEach(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),await db.appRuntimeSession());
 await withTransaction(ctx.db,()=>ensureTargetingPolicy(ctx));
 await withTransaction(ctx.db,()=>updateResearchSettings(ctx,{enabled:false,dailyFirmCeiling:400,dailyCostCeilingCents:4000,monthlyCostCeilingCents:38750,maxPagesPerFirm:4,maxPageBytes:1000000,modelName:'claude-haiku-4-5'}));
 await ctx.db.query("UPDATE sourcing_discovery_settings SET enabled=false,query_cursor=11,last_result='unknown',next_run_at='2026-11-01T12:34:56Z' WHERE workspace_id=$1",[seed.alpha.workspaceId]);
 await ctx.db.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,7,123)');
});
afterEach(async()=>db?.drop());
it.each(['targeting','research'] as const)('requires an audited ECS launcher for %s before any mutation',async kind=>{
 const before=await snapshot(),result=kind==='targeting'?await targetingConfigureCommand({session:ctx.db,options:await targetingOptions()}):await researchSetCeilingsCommand({session:ctx.db,options:researchOptions()});
 expect(result).toMatchObject({ok:false,reason:'launcher_unknown'});expect(await snapshot()).toEqual(before);
});
it.each(['foreign','salesperson','inactive'] as const)('requires the explicitly selected current active ADMIN, refusing %s',async mode=>{
 const owner=mode==='foreign'?seed.beta.admin.userId:mode==='salesperson'?seed.alpha.salesperson.userId:seed.alpha.admin.userId;
 if(mode==='inactive'){
  await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
  await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,owner]);
 }
 const before=await snapshot();
 expect(await targetingConfigureCommand({session:ctx.db,launch,options:{...(await targetingOptions()),'--owner-user-id':owner}})).toMatchObject({ok:false,reason:'owner_inactive'});
 expect(await researchSetCeilingsCommand({session:ctx.db,launch,options:{...researchOptions(),'--owner-user-id':owner}})).toMatchObject({ok:false,reason:'owner_inactive'});expect(await snapshot()).toEqual(before);
});
it('lowers only daily/monthly money while preserving research model/scope/enabled and all search/sending flags, with launcher audit',async()=>{
 const before=await readResearchSettings(ctx),controls=await snapshot();
 expect(await researchSetCeilingsCommand({session:ctx.db,launch,options:researchOptions()})).toEqual({ok:true,value:{dailyCents:1000,monthlyCents:20000,dailyFirms:400}});
 const after=await readResearchSettings(ctx);expect(after).toMatchObject({enabled:before.enabled,dailyFirmCeiling:before.dailyFirmCeiling,maxPagesPerFirm:before.maxPagesPerFirm,maxPageBytes:before.maxPageBytes,modelName:before.modelName,dailyCostCeilingCents:1000,monthlyCostCeilingCents:20000});
 const updated=await snapshot();for(const table of Object.keys(controls).filter(t=>!['research_settings','audit_events'].includes(t)))expect(updated[table]).toEqual(controls[table]);
 const audit=(await ctx.db.query<{detail:unknown;actor_user_id:string}>("SELECT detail,actor_user_id FROM audit_events WHERE action='research.ceilings_set'")).rows[0];
 expect(audit).toMatchObject({actor_user_id:seed.alpha.admin.userId,detail:{...launch,approvalRef:null,before:{dailyCents:4000,monthlyCents:38750,dailyFirms:400},after:{dailyCents:1000,monthlyCents:20000,dailyFirms:400}}});
 expect(await researchSetCeilingsCommand({session:ctx.db,launch,options:researchOptions()})).toMatchObject({ok:true});
});
it.each([['4001','20000',{}],['1000','38751',{}],['1000','20000',{'--daily-firms':'401'}]])('refuses any unapproved increase daily=%s/monthly=%s %o atomically',async(daily,monthly,extra)=>{
 const before=await snapshot();expect(await researchSetCeilingsCommand({session:ctx.db,launch,options:{...researchOptions(),'--daily-cents':daily,'--monthly-cents':monthly,...extra}})).toMatchObject({ok:false,reason:'ceiling_increase_unapproved'});expect(await snapshot()).toEqual(before);
});
it('raises money and firm ceilings only with an approval reference, auditing before/after, approval and launcher',async()=>{
 const before=await readResearchSettings(ctx),controls=await snapshot();
 const options={...researchOptions(),'--daily-cents':'5000','--monthly-cents':'60000','--daily-firms':'450','--approval-ref':'David approval 2026-11-01 supply raise'};
 expect(await researchSetCeilingsCommand({session:ctx.db,launch,options})).toEqual({ok:true,value:{dailyCents:5000,monthlyCents:60000,dailyFirms:450}});
 expect(await readResearchSettings(ctx)).toMatchObject({enabled:before.enabled,modelName:before.modelName,maxPagesPerFirm:before.maxPagesPerFirm,maxPageBytes:before.maxPageBytes,dailyCostCeilingCents:5000,monthlyCostCeilingCents:60000,dailyFirmCeiling:450});
 const updated=await snapshot();for(const table of Object.keys(controls).filter(t=>!['research_settings','audit_events'].includes(t)))expect(updated[table]).toEqual(controls[table]);
 expect((await ctx.db.query("SELECT detail,actor_user_id FROM audit_events WHERE action='research.ceilings_set'")).rows).toMatchObject([{actor_user_id:seed.alpha.admin.userId,
  detail:{...launch,approvalRef:'David approval 2026-11-01 supply raise',ownerUserId:seed.alpha.admin.userId,before:{dailyCents:4000,monthlyCents:38750,dailyFirms:400},after:{dailyCents:5000,monthlyCents:60000,dailyFirms:450}}}]);
});
it('reports research settings, spend, firm runs, worst-case run cost, discovery and search account read-only, without a launcher',async()=>{
 await ctx.db.query('UPDATE sourcing_discovery_settings SET searches_per_day=3 WHERE workspace_id=$1',[seed.alpha.workspaceId]);
 const before=await snapshot();
 const status=await researchStatusCommand({session:ctx.db,options:{'--workspace-id':seed.alpha.workspaceId},environment:{FSS_MODEL_TRANSPORT:'bedrock'}});
 expect(status).toMatchObject({ok:true,value:{transport:'bedrock',
  research:{configured:true,enabled:false,modelName:'claude-haiku-4-5',dailyFirmCeiling:400,firmRunsToday:0,dailyCostCeilingCents:4000,monthlyCostCeilingCents:38750,spend:{todayCents:0,monthToDateCents:0}},
  discovery:{enabled:false,searches_per_day:3,last_result:'unknown',qualification_wait_reason:null},searchAccount:{halted:true,daily_used:7,monthly_used:123}}});
 expect(status.ok&&(status.value as {research:{worstCaseRunCents:number}}).research.worstCaseRunCents).toBeGreaterThan(0);
 expect(await snapshot()).toEqual(before);
 expect(await researchStatusCommand({session:ctx.db,options:{'--workspace-id':seed.beta.workspaceId,'--unknown':'x'},environment:{}})).toMatchObject({ok:false,reason:'invalid_options'});
 expect(await researchStatusCommand({session:ctx.db,options:{'--workspace-id':'99999999-9999-4999-8999-999999999999'},environment:{}})).toMatchObject({ok:false,reason:'workspace_unknown'});
});
it('refuses unconfigured settings without initializing defaults or changing audits',async()=>{
 await db.session.query('DELETE FROM research_settings WHERE workspace_id=$1',[seed.alpha.workspaceId]);
 const before=await snapshot();
 expect(await researchSetCeilingsCommand({session:ctx.db,launch,options:{...researchOptions(),'--daily-cents':'0','--monthly-cents':'0'}})).toMatchObject({ok:false,reason:'settings_unconfigured'});
 expect(await snapshot()).toEqual(before);
});
it('an actual queued Firm claim reads the committed lower ceiling and creates no reservation',async()=>{
 const crm=await seedCrm(db.session,seed),at='2026-10-29T14:00:00Z';
 await withTransaction(ctx.db,async()=>{
  await updateResearchSettings(ctx,{enabled:true});
  await recordProviderCall(ctx,{at,providerKey:'aws_bedrock.extraction',costCents:1000,businessTimeZone:'America/New_York'});
 });
 let signalCommit!:()=>void,releaseCommit!:()=>void;
 const reachedCommit=new Promise<void>(resolve=>{signalCommit=resolve;}),allowCommit=new Promise<void>(resolve=>{releaseCommit=resolve;});
 const delayed:SessionQueryable={query:async(sql,values)=>{
  if(sql==='COMMIT'){signalCommit();await allowCommit;}
  return ctx.db.query(sql,values);
 }};
 const claiming=await db.appRuntimeSession(),worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),claiming);
 const pid=(await claiming.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const lowering=researchSetCeilingsCommand({session:delayed,launch,options:researchOptions()});
 let claim:ReturnType<typeof beginFirmResearch>|undefined;
 try{
  await reachedCommit;
  claim=withTransaction(claiming,()=>beginFirmResearch(worker,{firmId:crm.alpha.firmId,revision:1,trigger:'sweep',at,providerKey:'aws_bedrock.extraction'}));
  let waiting=false;
  for(let n=0;n<200;n++){
   waiting=(await db.session.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
   if(waiting)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(waiting).toBe(true);
 }finally{releaseCommit();}
 expect(await lowering).toMatchObject({ok:true});
 expect(await claim).toMatchObject({ok:false,reason:'daily_cost_ceiling'});
 expect((await ctx.db.query('SELECT id FROM provider_reservations')).rows).toEqual([]);
 expect(await readResearchSettings(ctx)).toMatchObject({dailyCostCeilingCents:1000,monthlyCostCeilingCents:20000});
});
it('configures60 selectors through existing CAS owners, preserves the original12 and refuses replay as stale',async()=>{
 const before=await readTargetingPolicy(ctx),controls=await snapshot(),options=await targetingOptions();
 const result=await targetingConfigureCommand({session:ctx.db,options,launch});expect(result).toMatchObject({ok:true,value:{queryCount:60}});
 const current=await readTargetingPolicy(ctx);expect(current.queries).toHaveLength(60);expect(current.queries.slice(0,12)).toEqual(before.queries);expect(current.rankOrder).toEqual(before.rankOrder);
 const after=await snapshot();for(const table of ['research_settings','workspace_settings','sourcing_discovery_attempts','sourcing_search_account','provider_reservations','jobs'])expect(after[table]).toEqual(controls[table]);
 expect((await ctx.db.query<{detail:unknown;actor_user_id:string}>("SELECT detail,actor_user_id FROM audit_events WHERE action='sourcing.targeting_configured'")).rows[0]).toMatchObject({actor_user_id:seed.alpha.admin.userId,detail:{...launch,queryCount:60}});
 expect(await targetingConfigureCommand({session:ctx.db,options,launch})).toMatchObject({ok:false,reason:'policy_changed'});expect(await snapshot()).toEqual(after);
});
it('an actual stored-proposal apply refusal rolls back the saved proposal and domain audits together',async()=>{
 // Controlled database fault: the returned proposal ID is real, but stored body CAS
 // differs before the normal apply owner reads it. Never changes production code.
 await db.session.query(`CREATE FUNCTION fixture_change_proposal_body() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.changes=jsonb_set(NEW.changes,'{basePolicyVersion}','"fictional-mismatch"'::jsonb);RETURN NEW;END $$`);
 await db.session.query('CREATE TRIGGER fixture_change_proposal_body BEFORE INSERT ON sourcing_targeting_proposals FOR EACH ROW EXECUTE FUNCTION fixture_change_proposal_body()');
 const before=await snapshot();expect(await targetingConfigureCommand({session:ctx.db,options:await targetingOptions(),launch})).toMatchObject({ok:false,reason:'invalid_input'});expect(await snapshot()).toEqual(before);
});
