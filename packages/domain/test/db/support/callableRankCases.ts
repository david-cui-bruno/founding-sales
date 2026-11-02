import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';

type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Row=Record<string,unknown>;
const missing='00000000-0000-4000-8000-000000000159';
async function row(f:Fixture):Promise<Row>{
 const candidate=randomUUID(),run=randomUUID();
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 await f.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,state,reason,observations,facts,finished_at)
  VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','none','unavailable','invalid_evidence','[]','[]',clock_timestamp())`,[f.seeded.alpha.workspaceId,run,candidate,run.replaceAll('-','').padEnd(64,'0')]);
 return {workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidate,candidate_revision:1,run_id:run,rank:3,company_host:'cedar.example.test',
  computed_at:'2026-11-02T00:00:00.000Z',expires_at:'2026-11-03T00:00:00.000Z'};
}
function insert(f:Fixture,value:Row){
 const columns=Object.keys(value);
 return f.session.query(`INSERT INTO sourcing_callable_ranks(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
}
const bad=(constraint:string,patch:Row)=>({constraint:`sourcing_callable_ranks_${constraint}`,run:async(f:Fixture)=>insert(f,{...await row(f),...patch})});

/** Current159 catalog only. Each case executes actual rejected DML against the named CHECK/FK/primary key. */
export const CALLABLE_RANK_CONSTRAINT_CASES=[
 bad('candidate_revision_check',{candidate_revision:0}),
 bad('rank_check',{rank:16}),
 bad('company_host_check',{company_host:''}),
 bad('company_host_check',{company_host:'x'.repeat(254)}),
 bad('check',{expires_at:'2026-11-02T00:00:00.000Z'}),
 bad('check',{expires_at:'2026-11-11T00:00:00.000Z'}),
 bad('workspace_id_candidate_id_fkey',{candidate_id:missing}),
 bad('workspace_id_candidate_id_run_id_fkey',{run_id:missing}),
 {constraint:'sourcing_callable_ranks_pkey',run:async(f:Fixture)=>{const value=await row(f);await insert(f,value);return insert(f,value);}},
];
