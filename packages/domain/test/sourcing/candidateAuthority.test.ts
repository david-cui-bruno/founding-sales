import {beforeEach,expect,it} from 'vitest';
import type {CandidateInput} from '@fss/contracts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {readCandidateAuthority} from '../../sourcing/candidateAuthority.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';
const id='00000000-0000-4000-8000-000000000001',owner='00000000-0000-4000-8000-000000000002',attempt='00000000-0000-4000-8000-000000000003';
const candidate:CandidateInput={firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',sourceUrl:'https://harbor.example.test/',locality:'Arlington',region:'TX',signal:'fit_only',evidence:'Private unverified search prose',preparedBy:'Tavily Basic search · not verified',observedOn:'2026-10-22',discoveryQuery:'Arlington Texas residential property management'};
function fixture(){return {
 candidate:{revision:1,payload:{...candidate},status:'needs_review',qualification_blocked:false},
 policy:{version:'targeting-v1',queries:[{id:'arlington',query:candidate.discoveryQuery,locality:'Arlington',region:'TX'}],rank_order:[]},
 hits:[{attempt_id:attempt,source_url:candidate.website,native_result:{url:candidate.website},query_id:'arlington',query:candidate.discoveryQuery,policy_version:'targeting-v1',state:'complete'}],
 origins:[] as Record<string,unknown>[],
 settings:{owner_user_id:owner,auto_admission_enabled:true,qualification_evaluation:{verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:1,falseEligible:0}},
 member:{role:'admin',status:'active'},actor:{role:'admin',status:'active'},
 research:[] as Record<string,unknown>[],holds:[] as Record<string,unknown>[],version:1,
};}
let f:ReturnType<typeof fixture>,ctx:RepositoryContext,queries:{sql:string;args:readonly unknown[]}[],snapshotCount:number,change:(()=>void)|null;
beforeEach(()=>{
 f=fixture();queries=[];snapshotCount=0;change=null;
 ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),{query:async<Row,>(sql:string,args:readonly unknown[]=[])=>{
  queries.push({sql,args});expect(sql.trim().startsWith('SELECT')).toBe(true);
  expect(args[0]===id||sql.includes('clock_timestamp')).toBe(true);
  let rows:unknown[]=[];
  if(sql.startsWith('SELECT jsonb_build_object')){
   snapshotCount++;if(snapshotCount===2)change?.();
   rows=[{snapshot:structuredClone({...f,candidate:args[1]===id?f.candidate:null})}];
  }else if(sql.includes('clock_timestamp()'))rows=[{now:new Date('2026-10-23T16:00:00.000Z')}];
  else if(sql.includes('SELECT s.owner_user_id'))rows=f.settings.auto_admission_enabled&&f.member.status==='active'?[f.settings]:[];
  else if(sql.includes('workspace_memberships'))rows=[args[1]===owner?f.member:f.actor];
  else if(sql.includes('SELECT v.version'))rows=[f.policy];
  else if(sql.includes('FROM sourcing_discovery_hits'))rows=f.hits.filter(h=>h.state==='complete'&&h.source_url===args[2]);
  else if(sql.includes('FROM sourcing_apollo_candidate_origins'))rows=f.origins.filter(o=>o['state']==='complete'&&Number(o['candidate_revision'])<=Number(args[2]));
  else if(sql.includes('FROM research_settings'))rows=f.research;
  else if(sql.includes('FROM active_holds')){expect(args).toEqual([id,'research',null,null,owner,null,null,'research']);rows=f.holds;}
  else throw new Error(`Unexpected SQL: ${sql}`);
  return {rows:rows as Row[],rowCount:rows.length};
 }});
});
const read=()=>readCandidateAuthority(ctx,{candidateId:id,expectedRevision:1});
it('uses actual source, owner attestation, default settings and hold readers without qualification or mutation',async()=>{
 const result=await read();expect(result).toEqual({ok:true,value:{candidateId:id,candidateRevision:1,checkedAt:'2026-10-23T16:00:00.000Z',source:{status:'matched',kind:'search_hit',attemptId:attempt},owner:'current_admin',researchEnabled:true,holds:'clear',authority:'not_granted'}});
 expect(snapshotCount).toBe(2);expect(JSON.stringify(result)).not.toMatch(/harbor|Private|reportSha|owner_user_id|binding|sourceUrl/u);
 expect(queries.some(q=>/qualification_runs|INSERT|UPDATE|DELETE|audit|jobs|counters/u.test(q.sql))).toBe(false);
});
it('observes an attested current admin independently of research OFF and holds',async()=>{
 f.research=[{enabled:false,updated_at:null}];
 f.holds=[{id:attempt,scope_kind:'owner',scope_key:owner,reason_code:'owner_paused',blocked_action_kinds:['research'],source_event_kind:'test',source_event_id:null,owner_user_id:owner,started_at:new Date('2026-10-22T00:00:00Z'),recovery_action:null}];
 expect(await read()).toMatchObject({ok:true,value:{owner:'current_admin',researchEnabled:false,holds:'held',authority:'not_granted'}});
});
it.each(['disabled','bad_attestation','inactive','salesperson'] as const)('unavailable owner %s keeps holds unknown, not clear',async kind=>{
 if(kind==='disabled')f.settings.auto_admission_enabled=false;
 if(kind==='bad_attestation')f.settings.qualification_evaluation.reportSha256='invalid';
 if(kind==='inactive')f.member.status='revoked';
 if(kind==='salesperson')f.member.role='salesperson';
 expect(await read()).toMatchObject({ok:true,value:{owner:'unavailable',holds:'unknown'}});
 expect(queries.some(q=>q.sql.includes('FROM active_holds')&&!q.sql.startsWith('SELECT jsonb_build_object'))).toBe(false);
});
it.each(['label_only','failed','wrong_query','wrong_policy','wrong_native_url','ambiguous','geography'] as const)('source %s is unavailable, never inferred from labels/budget',async kind=>{
 if(kind==='label_only')f.hits=[];
 if(kind==='failed')f.hits[0]!.state='failed';
 if(kind==='wrong_query')f.hits[0]!.query='other';
 if(kind==='wrong_policy')f.hits[0]!.policy_version='old';
 if(kind==='wrong_native_url')f.hits[0]!.native_result.url='https://other.example.test/';
 if(kind==='ambiguous')f.hits.push({...f.hits[0]!,attempt_id:owner});
 if(kind==='geography')f.candidate.payload.locality='Boston';
 expect(await read()).toMatchObject({ok:true,value:{source:{status:'unavailable'},authority:'not_granted'}});
});
it('recognizes completed exact Apollo lineage and refuses mismatched organization',async()=>{
 f.hits=[];f.origins=[{state:'complete',attempt_id:attempt,candidate_revision:1,organization_name:candidate.firmName,domain:'harbor.example.test',hq_city:'Arlington',hq_state:'TX',region:'TX'}];
 expect(await read()).toMatchObject({ok:true,value:{source:{status:'matched',kind:'apollo_organization',attemptId:attempt}}});
 f.origins[0]!['organization_name']='Other Firm';expect(await read()).toMatchObject({ok:true,value:{source:{status:'unavailable'}}});
});
it.each(['dismissed','blocked','stale','format'] as const)('refuses %s candidate without evidence reads',async kind=>{
 if(kind==='dismissed')f.candidate.status='dismissed';
 if(kind==='blocked')f.candidate.qualification_blocked=true;
 if(kind==='stale')f.candidate.revision=2;
 if(kind==='format')f.candidate.payload={kind:'discovery-v1'} as unknown as CandidateInput;
 expect(await read()).toEqual({ok:false,reason:'candidate_unavailable'});expect(snapshotCount).toBe(1);
});
it('refuses missing/foreign candidate and nonadmin/inactive callers',async()=>{
 expect(await readCandidateAuthority(ctx,{candidateId:attempt,expectedRevision:1})).toEqual({ok:false,reason:'candidate_unavailable'});
 f.actor.status='revoked';expect(await read()).toEqual({ok:false,reason:'admin_only'});
 ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'salesperson'}),ctx.db);expect(await read()).toEqual({ok:false,reason:'admin_only'});
});
it.each(['candidate','source','owner','settings','holds','targeting','same_value_rewrite'] as const)('refuses concurrent %s changes with exactly two snapshots and no retries',async kind=>{
 change=()=>{
  if(kind==='candidate')f.candidate.status='dismissed';
  if(kind==='source')f.hits=[];
  if(kind==='owner')f.member.status='revoked';
  if(kind==='settings')f.research=[{enabled:false}];
  if(kind==='holds')f.holds=[{id:attempt}];
  if(kind==='targeting')f.policy.version='new';
  if(kind==='same_value_rewrite')f.version++;
 };
 expect(await read()).toEqual({ok:false,reason:'authority_changed'});expect(snapshotCount).toBe(2);
});
