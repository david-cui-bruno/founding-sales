import {randomUUID} from 'node:crypto';
import type {OutboundCaseFixture} from './outboundCases.ts';
type Fixture=OutboundCaseFixture;
interface Case {constraint:string;run:(fixture:Fixture)=>Promise<unknown>}
const table='booking_conversations';
async function interpretation(f:Fixture,workspaceId=f.seeded.alpha.workspaceId,owner=f.seeded.alpha.admin.userId){return (await f.session.query<{id:string}>("INSERT INTO crm_booking_interpretations(workspace_id,requested_by,source_refs,source_fingerprint,state) VALUES($1,$2,$3::jsonb,$4,'unavailable') RETURNING id",[workspaceId,owner,JSON.stringify([{sourceId:randomUUID(),sourceRevision:1,contentHash:'a'.repeat(64)}]),'a'.repeat(64)])).rows[0]!.id;}
async function insert(f:Fixture,patch:Record<string,unknown>={}){
 const row:Record<string,unknown>={id:randomUUID(),workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,interpretation_request_id:await interpretation(f),policy_revision:1,binding_key:'a'.repeat(64),source_fingerprint:'a'.repeat(64),source_refs:JSON.stringify([{sourceId:randomUUID(),sourceRevision:1,contentHash:'a'.repeat(64)}]),state:'pending',...patch},keys=Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>row[key]));
}
export const BOOKING_CONVERSATION_CONSTRAINT_CASES:readonly Case[]=[
 ...([['policy_revision_check',{policy_revision:0}],['source_fingerprint_check',{source_fingerprint:'invalid'}],['source_refs_check',{source_refs:'[]'}],['source_refs_check',{source_refs:'{}'}],['source_refs_check',{source_refs:JSON.stringify(Array(5).fill({sourceId:randomUUID()}))}],['source_refs_check',{source_refs:JSON.stringify([{text:'x'.repeat(2100)}])}],['state_check',{state:'live_enabled'}],['target_booking_uid_check',{target_booking_uid:'invalid.uid',target_meeting_id:randomUUID()}],['handoff_action_check',{handoff_action:'send_sales_reply'}],['nudge_count_check',{nudge_count:3}],['nudge_count_check',{nudge_count:-1}],['target_pair',{target_booking_uid:'booking-without-meeting'}]] as const).map(([suffix,patch])=>({constraint:suffix==='target_pair'?'booking_conversation_target_pair':`${table}_${suffix}`,run:(f:Fixture)=>insert(f,patch)})),
 {constraint:`${table}_workspace_id_fkey`,run:f=>insert(f,{workspace_id:randomUUID()})},
 {constraint:`${table}_workspace_id_owner_user_id_fkey`,run:f=>insert(f,{owner_user_id:randomUUID()})},
 {constraint:`${table}_workspace_id_owner_user_id_fkey`,run:f=>insert(f,{owner_user_id:f.seeded.beta.admin.userId})},
 ...['source_conversation_id','create_submission_id','change_submission_id','target_meeting_id'].map(column=>({constraint:`${table}_workspace_id_${column}_fkey`,run:(f:Fixture)=>insert(f,{[column]:randomUUID(),...(column==='target_meeting_id'?{target_booking_uid:'target'}:{})})})),
 {constraint:'booking_conversation_interpretation',run:f=>insert(f,{interpretation_request_id:randomUUID()})},
 {constraint:'booking_conversation_interpretation',run:async f=>insert(f,{interpretation_request_id:await interpretation(f,f.seeded.beta.workspaceId,f.seeded.beta.admin.userId)})},
 {constraint:`${table}_pkey`,run:async f=>{const id=randomUUID();await insert(f,{id});return insert(f,{id});}},
 {constraint:'booking_conversation_owner_interpretation',run:async f=>{const interpretation_request_id=await interpretation(f);await insert(f,{interpretation_request_id});return insert(f,{interpretation_request_id});}},
 {constraint:'booking_conversation_owner_source_episode',run:async f=>{const source_refs=JSON.stringify([{sourceId:randomUUID(),sourceRevision:1,contentHash:'a'.repeat(64)}]);await insert(f,{source_refs});return insert(f,{source_refs});}},
 {constraint:'booking_conversation_target_pair',run:f=>insert(f,{target_meeting_id:randomUUID()})},
];
