import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
import {insertManualActivity,manualActivityRow} from './manualProspectActivityCases.ts';

type Fixture={session:SessionQueryable;seeded:TwoWorkspaces};
type Row=Record<string,unknown>;
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
const absent='00000000-0000-4000-8000-000000000138';
const workspace=(f:Fixture)=>f.seeded.alpha.workspaceId;
const admin=(f:Fixture)=>f.seeded.alpha.admin.userId;
const salesperson=(f:Fixture)=>f.seeded.alpha.salesperson.userId;

/** Existing Calling identity cases extracted unchanged from the catalog hotspot. */
export const CALLING_IDENTITY_CONSTRAINT_CASES:readonly Case[]=[
 {constraint:'calling_identities_pkey',run:async f=>{
  const created=await f.session.query<{id:string}>("INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550200') RETURNING id",[workspace(f),admin(f)]);
  return f.session.query("INSERT INTO calling_identities (workspace_id, id, owner_user_id, e164) VALUES ($1, $2, $3, '+14015550201')",[workspace(f),created.rows[0]?.id,admin(f)]);
 }},
 {constraint:'calling_identities_number_unique',run:async f=>{
  await f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",[workspace(f),admin(f)]);
  return f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",[workspace(f),salesperson(f)]);
 }},
 {constraint:'calling_identities_owner_fkey',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550203')",[workspace(f),f.seeded.beta.admin.userId])},
 {constraint:'calling_identities_workspace_id_fkey',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, e164) VALUES ('00000000-0000-4000-8000-000000000000', '+14015550204')")},
 {constraint:'calling_identities_e164_shape',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '401-555-0205')",[workspace(f),admin(f)])},
 {constraint:'calling_identities_verification_known',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status) VALUES ($1, $2, '+14015550206', 'probably')",[workspace(f),admin(f)])},
 {constraint:'calling_identities_shared_line_disabled',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled, verified_at, verified_by_user_id, verification_method) VALUES ($1, NULL, '+14015550207', 'verified', true, now(), $2, 'admin_attestation')",[workspace(f),admin(f)])},
 {constraint:'calling_identities_verification_method_known',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled, verified_at, verified_by_user_id, verification_method) VALUES ($1, $2, '+14015550210', 'verified', true, now(), $2, 'caller_id_looked_right')",[workspace(f),admin(f)])},
 {constraint:'calling_identities_verified_by_fkey',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled, verified_at, verified_by_user_id, verification_method) VALUES ($1, $2, '+14015550211', 'verified', true, now(), $3, 'admin_attestation')",[workspace(f),admin(f),f.seeded.beta.admin.userId])},
 {constraint:'calling_identities_disabled_by_fkey',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, disabled_at, disabled_by_user_id) VALUES ($1, $2, '+14015550212', now(), $3)",[workspace(f),admin(f),f.seeded.beta.admin.userId])},
 {constraint:'calling_identities_disable_recorded',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, disabled_at) VALUES ($1, $2, '+14015550213', now())",[workspace(f),admin(f)])},
 {constraint:'calling_identities_label_shape',run:async f=>f.session.query("INSERT INTO calling_identities (workspace_id, owner_user_id, e164, label) VALUES ($1, $2, '+14015550214', '')",[workspace(f),admin(f)])},
];

/** Valid terminal fences need no retained source witness or private content. */
function candidate(f:Fixture):Row{return {workspace_id:workspace(f),id:randomUUID(),creator_user_id:admin(f),creator_ref:admin(f),source_kind:'candidate',candidate_id:randomUUID(),candidate_revision:1,attempt_id:randomUUID(),content:null,reason:'withdrawn'};}
function firm(f:Fixture):Row{return {workspace_id:workspace(f),id:randomUUID(),creator_user_id:admin(f),creator_ref:admin(f),source_kind:'firm',firm_id:randomUUID(),call_log_id:randomUUID(),content:null,reason:'withdrawn'};}
async function insert(f:Fixture,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO calling_follow_up_drafts(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
const invalid=(constraint:string,patch:Row):Case=>({constraint,run:async f=>insert(f,{...candidate(f),...patch})});

/** Every new migration0138 catalog entry has a real refused insert, rolled back by the harness. */
export const CALLING_DRAFT_CONSTRAINT_CASES:readonly Case[]=[
 {constraint:'calling_follow_up_drafts_pkey',run:async f=>{const row=candidate(f);await insert(f,row);return insert(f,{...row,attempt_id:randomUUID()});}},
 {constraint:'calling_draft_attempt_once',run:async f=>{const row=candidate(f);await insert(f,row);return insert(f,{...row,id:randomUUID()});}},
 {constraint:'calling_draft_call_once',run:async f=>{const row=firm(f);await insert(f,row);return insert(f,{...row,id:randomUUID()});}},
 invalid('calling_follow_up_drafts_revision_check',{revision:0}),
 invalid('calling_follow_up_drafts_candidate_revision_check',{candidate_revision:0}),
 invalid('calling_follow_up_drafts_reason_check',{reason:'sent'}),
 invalid('calling_follow_up_drafts_check',{created_at:'2026-10-26T12:00:00Z',updated_at:'2026-10-26T11:00:00Z'}),
 invalid('calling_draft_source_shape',{firm_id:absent}),
 invalid('calling_draft_content_shape',{content:'{}',reason:null,attempt_ref:absent}),
 {constraint:'calling_follow_up_drafts_source_kind_check',run:async f=>{
  // source_shape also rejects unknown branches. Isolate this declarative check only
  // inside the privileged transaction the harness always rolls back, never whitelist it.
  await f.session.query('ALTER TABLE calling_follow_up_drafts DROP CONSTRAINT calling_draft_source_shape');
  return insert(f,{...candidate(f),source_kind:'email'});
 }},
 invalid('calling_follow_up_drafts_workspace_id_creator_ref_fkey',{creator_ref:absent}),
 {constraint:'calling_follow_up_drafts_workspace_id_attempt_ref_candidat_fkey',run:async f=>{
  const source=await manualActivityRow(f);await insertManualActivity(f,source);
  // Existing attempt, wrong exact candidate revision, not merely an absent UUID.
  return insert(f,{...candidate(f),candidate_id:source.candidate_id,candidate_revision:2,attempt_id:source.id,attempt_ref:source.id});
 }},
 {constraint:'calling_follow_up_drafts_workspace_id_call_log_ref_firm_id_fkey',run:async f=>{
  const sourceFirm=(await f.session.query<{id:string}>('INSERT INTO firms(workspace_id,name) VALUES($1,$2) RETURNING id',[workspace(f),'Synthetic catalog Firm'])).rows[0]!.id;
  const log=(await f.session.query<{id:string}>("INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,actor_user_id) VALUES($1,$2,'not_interested','none',now(),$3) RETURNING id",[workspace(f),sourceFirm,admin(f)])).rows[0]!.id;
  // Existing log, wrong Firm witness. Terminal shape remains valid.
  return insert(f,{...firm(f),call_log_id:log,call_log_ref:log});
 }},
];
