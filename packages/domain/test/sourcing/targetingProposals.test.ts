import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveTargetingProposal,applyTargetingProposal,readTargetingPolicy} from '../../sourcing/targetingProposals.ts';
import {runDiscovery} from '../../sourcing/discovery.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
const change={id:'dfw-need',query:'Dallas maintenance coordinator property management',locality:'Dallas',region:'TX' as const};
const ranks:Array<'help_request'|'operational_burden'|'investigation'|'fit_only'>=['help_request','operational_burden','investigation','fit_only'];
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
it('keeps proposals inactive until explicit approval and rejects a stale approval',async()=>{
 const policy=await tx(()=>readTargetingPolicy(ctx()));
 const proposal=await tx(()=>saveTargetingProposal(ctx(),{basePolicyVersion:policy.version,queryChanges:[change],rankOrder:ranks,evidenceIds:[],rationale:'Explore coordinator recruitment as a hypothesis; no conversion claim.'}));if(!proposal.ok)throw new Error(proposal.reason);
 expect((await tx(()=>readTargetingPolicy(ctx()))).version).toBe(policy.version);
 const approved=await tx(()=>applyTargetingProposal(ctx(),{id:proposal.value.id,expectedRevision:1}));expect(approved.ok).toBe(true);
 expect((await tx(()=>readTargetingPolicy(ctx()))).queries.some(q=>q.id===change.id)).toBe(true);
 expect(await tx(()=>applyTargetingProposal(ctx(),{id:proposal.value.id,expectedRevision:1}))).toMatchObject({ok:false,reason:'proposal_changed'});
});
it('refuses cross-workspace application and invalid ranks without changing settings',async()=>{
 const policy=await tx(()=>readTargetingPolicy(ctx()));
 expect(await tx(()=>saveTargetingProposal(ctx(),{basePolicyVersion:policy.version,queryChanges:[],rankOrder:['anything' as never],evidenceIds:[],rationale:'No'}))).toMatchObject({ok:false,reason:'invalid_input'});
 const other=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),db.session);
 expect(await tx(()=>applyTargetingProposal(other,{id:'11111111-1111-4111-8111-111111111111',expectedRevision:1}))).toMatchObject({ok:false,reason:'not_found'});
});
it('freezes the query version and location before the provider call even if policy changes during it',async()=>{
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 await db.session.query('UPDATE sourcing_discovery_settings SET enabled=true,next_run_at=now() WHERE workspace_id=$1',[seeded.alpha.workspaceId]);
 const before=await tx(()=>readTargetingPolicy(ctx()));
 const draft=await tx(()=>saveTargetingProposal(ctx(),{basePolicyVersion:before.version,queryChanges:[{...before.queries[0]!,locality:'Different city',region:'MA'}],rankOrder:ranks,evidenceIds:[],rationale:'Explicit test policy change.'}));if(!draft.ok)throw new Error(draft.reason);
 await runDiscovery(ctx(),{providerKey:'tavily_basic',discover:async()=>{
  expect((await tx(()=>applyTargetingProposal(ctx(),{id:draft.value.id,expectedRevision:1}))).ok).toBe(true);
  return {ok:true,credits:1,requestId:'policy-race',hits:[{url:'https://frozen-policy.example.test/',title:'PM',snippet:'Source excerpt'}]};
 }});
 expect((await db.session.query('SELECT policy_version,query_id FROM sourcing_discovery_attempts WHERE workspace_id=$1',[seeded.alpha.workspaceId])).rows[0]).toMatchObject({policy_version:before.version,query_id:before.queries[0]!.id});
 expect((await db.session.query("SELECT payload FROM sourcing_candidates WHERE payload->>'website'='https://frozen-policy.example.test/'")).rows[0]).toMatchObject({payload:{locality:before.queries[0]!.locality,region:before.queries[0]!.region}});
});
