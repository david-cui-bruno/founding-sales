import type {SessionQueryable} from '../../../db/queryable.ts';
interface Fixture {session:SessionQueryable;seeded:{alpha:{workspaceId:string}}}
const insert=(f:Fixture,overrides:Record<string,unknown>={})=>{
 const row={workspace_id:f.seeded.alpha.workspaceId,id:'55555555-5555-4555-8555-555555555555',identity_key:'a'.repeat(64),payload:'{}',status:'needs_review',revision:1,...overrides};
 return f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload,status,revision) VALUES($1,$2,$3,$4::jsonb,$5,$6)',Object.values(row));
};
export const SOURCING_CONSTRAINT_CASES=[
 {constraint:'sourcing_monitoring_status',run:async(f:Fixture)=>{await insert(f);return f.session.query("UPDATE sourcing_candidates SET next_source_check_at=now() WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_candidates_source_check_shape',run:async(f:Fixture)=>{await insert(f);return f.session.query("UPDATE sourcing_candidates SET source_check='[]'::jsonb WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_candidates_source_check_shape',run:async(f:Fixture)=>{await insert(f);return f.session.query('UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE workspace_id=$1',[f.seeded.alpha.workspaceId,JSON.stringify({text:'a'.repeat(16001)})]);}},
 {constraint:'sourcing_candidates_workspace_id_fkey',run:async(f:Fixture)=>insert(f,{workspace_id:'99999999-9999-4999-8999-999999999999'})},
 {constraint:'sourcing_candidates_identity_key_check',run:async(f:Fixture)=>insert(f,{identity_key:'short'})},
 {constraint:'sourcing_candidates_payload_check',run:async(f:Fixture)=>insert(f,{payload:'[]'})},
 {constraint:'sourcing_candidates_payload_check',run:async(f:Fixture)=>insert(f,{payload:JSON.stringify({text:'a'.repeat(20001)})})},
 {constraint:'sourcing_candidates_status_check',run:async(f:Fixture)=>insert(f,{status:'verified'})},
 {constraint:'sourcing_candidates_revision_check',run:async(f:Fixture)=>insert(f,{revision:0})},
 {constraint:'sourcing_candidates_pkey',run:async(f:Fixture)=>{await insert(f);return insert(f,{identity_key:'b'.repeat(64)});}},
 {constraint:'sourcing_candidates_workspace_id_identity_key_key',run:async(f:Fixture)=>{await insert(f);return insert(f,{id:'66666666-6666-4666-8666-666666666666'});}},
];
