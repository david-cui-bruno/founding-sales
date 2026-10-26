import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../db/queryable.ts';
import type {TwoWorkspaces} from './support/fixtures.ts';
type Fixture={session:SessionQueryable;seeded:TwoWorkspaces};
type Row=Record<string,unknown>;
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
const table='sourcing_prospect_phone_discoveries';
/** Declarative constraints isolated only inside the privileged catalog transaction.
 * Actual app_runtime lifecycle/trigger behavior is exercised without alteration in
 * prospectPhoneDiscoveryMigration.test.ts and the domain workflow tests. */
async function parent(f:Fixture):Promise<Row>{
 await f.session.query(`ALTER TABLE ${table} DISABLE TRIGGER prospect_phone_run_fence`);
 const id=randomUUID();
 await f.session.query("INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,'{}')",[f.seeded.alpha.workspaceId,id,randomUUID().replaceAll('-','').repeat(2)]);
 return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),candidate_id:id,candidate_revision:1,creator_user_id:f.seeded.alpha.admin.userId,creator_ref:f.seeded.alpha.admin.userId,method:'company-public-phone-v1',state:'unavailable',reason:'source_unavailable',requested_at:'2026-10-26T01:00:00Z',deadline_at:'2026-10-26T01:30:00Z',expires_at:'2026-10-27T01:00:00Z',checked_at:'2026-10-26T01:01:00Z',dispatched_at:null,dispatch_finished_at:null,content:null};
}
async function insert(f:Fixture,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
const checks:Readonly<Record<string,Row>>={
 prospect_phone_revision_positive:{candidate_revision:0},
 prospect_phone_method_known:{method:'qualification'},
 prospect_phone_state_known:{state:'retry'},
 prospect_phone_reason_known:{reason:'sent'},
 prospect_phone_times_finite:{requested_at:'-infinity'},
 prospect_phone_deadline_bounded:{deadline_at:'2026-10-26T01:31:00Z'},
 prospect_phone_expiry_bounded:{expires_at:'2026-11-03T01:00:00Z'},
 prospect_phone_dispatch_ordered:{dispatched_at:'2026-10-26T00:59:00Z'},
 prospect_phone_finish_ordered:{dispatch_finished_at:'2026-10-26T01:01:00Z'},
 prospect_phone_content_shape:{content:'{}'},
 prospect_phone_lifecycle_shape:{state:'running'},
};
export const PROSPECT_PHONE_DISCOVERY_CONSTRAINT_CASES:readonly Case[]=[
 ...Object.entries(checks).map(([constraint,patch])=>({constraint,run:async(f:Fixture)=>{
  const row=await parent(f);
  for(const other of Object.keys(checks))if(other!==constraint)await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${other}`);
  return insert(f,{...row,...patch});
 }})),
 {constraint:'prospect_phone_pkey',run:async f=>{const row=await parent(f);await insert(f,row);return insert(f,{...row,candidate_revision:2});}},
 {constraint:'prospect_phone_revision_once',run:async f=>{const row=await parent(f);await insert(f,row);return insert(f,{...row,id:randomUUID()});}},
 {constraint:'prospect_phone_candidate_fkey',run:async f=>insert(f,{...await parent(f),candidate_id:randomUUID()})},
 {constraint:'prospect_phone_creator_fkey',run:async f=>insert(f,{...await parent(f),creator_ref:f.seeded.beta.admin.userId})},
];
