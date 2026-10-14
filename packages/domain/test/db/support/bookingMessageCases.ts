import {randomUUID} from 'node:crypto';
import type {OutboundCaseFixture} from './outboundCases.ts';
type Fixture=OutboundCaseFixture;
interface Case {constraint:string;run:(fixture:Fixture)=>Promise<unknown>}
const table='booking_message_requests';
async function conversation(f:Fixture,workspaceId=f.seeded.alpha.workspaceId,owner=f.seeded.alpha.admin.userId){
 const interpretation=(await f.session.query<{id:string}>(`INSERT INTO crm_booking_interpretations(workspace_id,requested_by,source_refs,source_fingerprint,state) VALUES($1,$2,$3::jsonb,$4,'unavailable') RETURNING id`,[workspaceId,owner,JSON.stringify([{sourceId:randomUUID(),sourceRevision:1,contentHash:'a'.repeat(64)}]),'a'.repeat(64)])).rows[0]!;
 return (await f.session.query<{id:string}>(`INSERT INTO booking_conversations(workspace_id,owner_user_id,interpretation_request_id,policy_revision,binding_key,source_fingerprint,source_refs,state) VALUES($1,$2,$3,1,$4,$4,$5::jsonb,'awaiting_time') RETURNING id`,[workspaceId,owner,interpretation.id,'a'.repeat(64),JSON.stringify([{sourceId:randomUUID(),sourceRevision:1,contentHash:'a'.repeat(64)}])])).rows[0]!.id;
}
async function insert(f:Fixture,patch:Record<string,unknown>={}){
 const row:Record<string,unknown>={id:randomUUID(),workspace_id:f.seeded.alpha.workspaceId,conversation_id:await conversation(f),owner_user_id:f.seeded.alpha.admin.userId,kind:'approved_link',policy_revision:1,source_fingerprint:'a'.repeat(64),...patch},keys=Object.keys(row);
 return (await f.session.query<{id:string}>(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id`,keys.map(key=>row[key]))).rows[0]!.id;
}
async function cloneFence(f:Fixture,patch:Record<string,unknown>={}){
 const id=randomUUID();
 await f.session.query(`INSERT INTO outbound_messages SELECT (jsonb_populate_record(NULL::outbound_messages,to_jsonb(o)||$3::jsonb)).* FROM outbound_messages o WHERE o.workspace_id=$1 AND o.id=$2`,[f.seeded.alpha.workspaceId,f.outbound.alpha.preparedFenceId,JSON.stringify({id,draft_id:randomUUID(),origin_kind:'standing_booking',step_execution_id:null,enrollment_id:null,provider_message_id_header:`<${id}@sending.example.test>`,...patch})]);
 return id;
}
export const BOOKING_MESSAGE_CONSTRAINT_CASES:readonly Case[]=[
 ...([['kind_check',{kind:'substantive_reply'}],['policy_revision_check',{policy_revision:0}],['source_fingerprint_check',{source_fingerprint:'not-a-version'}],['check',{consumed_at:new Date()}]] as const).map(([suffix,patch])=>({constraint:`${table}_${suffix}`,run:(f:Fixture)=>insert(f,patch)})),
 {constraint:`${table}_workspace_id_fkey`,run:f=>insert(f,{workspace_id:randomUUID()})},
 {constraint:`${table}_owner_user_id_fkey`,run:f=>insert(f,{owner_user_id:randomUUID()})},
 {constraint:`${table}_workspace_id_conversation_id_fkey`,run:f=>insert(f,{conversation_id:randomUUID()})},
 {constraint:`${table}_workspace_id_outbound_message_id_fkey`,run:f=>insert(f,{outbound_message_id:randomUUID()})},
 {constraint:`${table}_workspace_id_conversation_id_fkey`,run:async f=>insert(f,{conversation_id:await conversation(f,f.seeded.beta.workspaceId,f.seeded.beta.admin.userId)})},
 {constraint:`${table}_workspace_id_outbound_message_id_fkey`,run:f=>insert(f,{outbound_message_id:f.outbound.beta.preparedFenceId})},
 {constraint:`${table}_pkey`,run:async f=>{const id=randomUUID();await insert(f,{id});return insert(f,{id});}},
 {constraint:`${table}_workspace_id_id_key`,run:async f=>{const id=randomUUID();await insert(f,{id});await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);return insert(f,{id});}},
 {constraint:'booking_message_source_kind',run:async f=>{const conversation_id=await conversation(f);await insert(f,{conversation_id});return insert(f,{conversation_id});}},
 ...['kind','policy_revision','source_fingerprint','owner_user_id','conversation_id','created_at','id'].map(column=>({constraint:'booking_message_identity_immutable',run:async(f:Fixture)=>{const id=await insert(f),values:Record<string,unknown>={kind:'nudge_3',policy_revision:2,source_fingerprint:'b'.repeat(64),owner_user_id:f.seeded.beta.admin.userId,conversation_id:await conversation(f),created_at:'2026-01-01T00:00:00Z',id:randomUUID()};return f.session.query(`UPDATE ${table} SET ${column}=$3 WHERE workspace_id=$1 AND id=$2`,[f.seeded.alpha.workspaceId,id,values[column]]);}})),
 {constraint:'booking_message_identity_immutable',run:async f=>{const id=await insert(f,{outbound_message_id:f.outbound.alpha.preparedFenceId,consumed_at:new Date()});return f.session.query(`UPDATE ${table} SET consumed_at=NULL WHERE workspace_id=$1 AND id=$2`,[f.seeded.alpha.workspaceId,id]);}},
 {constraint:'booking_message_identity_immutable',run:async f=>{const id=await insert(f,{outbound_message_id:f.outbound.alpha.preparedFenceId});return f.session.query(`UPDATE ${table} SET outbound_message_id=NULL WHERE workspace_id=$1 AND id=$2`,[f.seeded.alpha.workspaceId,id]);}},
 {constraint:'outbound_messages_origin_kind_known',run:f=>cloneFence(f,{origin_kind:'generic_automatic_reply'})},
 {constraint:'outbound_messages_exactly_one_origin',run:f=>cloneFence(f,{draft_id:null})},
 {constraint:'outbound_messages_origin_kind_matches',run:f=>cloneFence(f,{origin_kind:'step_execution'})},
];
