import {randomUUID} from 'node:crypto';
import type {OutboundCase,OutboundCaseFixture} from './outboundCases.ts';

async function insert(f:OutboundCaseFixture,changes:Record<string,unknown>={}){
 const row={workspace_id:f.seeded.alpha.workspaceId,message_id:randomUUID(),outbound_message_id:f.outbound.alpha.sentFenceId,user_id:f.seeded.alpha.salesperson.userId,role:'salesperson',session_id:randomUUID(),device_id:f.seeded.alpha.salesperson.deviceId,command_id:randomUUID(),expires_at:'2026-10-08T15:00:00Z',source_revision:'a'.repeat(64),draft_revision:'b'.repeat(64),fact_refs:'[]',envelope:JSON.stringify({to:['recipient@example.test'],cc:[]}),provider_thread_id:'thread',in_reply_to:'incoming@example.test',reference_ids:'[]',author_address:'owner@example.test',...changes};
 return f.session.query(`INSERT INTO human_reply_send_intents(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
export const HUMAN_REPLY_CONSTRAINT_CASES:readonly OutboundCase[]=[
 {constraint:'human_reply_send_intents_pkey',run:async f=>{const message_id=randomUUID();await insert(f,{message_id});return insert(f,{message_id,outbound_message_id:f.outbound.alpha.preparedFenceId});}},
 {constraint:'human_reply_send_intents_workspace_id_outbound_message_id_key',run:async f=>{await insert(f);return insert(f);}},
 {constraint:'human_reply_send_intents_workspace_id_fkey',run:f=>insert(f,{workspace_id:randomUUID()})},
 {constraint:'human_reply_send_intents_workspace_id_outbound_message_id_fkey',run:f=>insert(f,{outbound_message_id:f.outbound.beta.sentFenceId})},
 ...([
  ['role','operator'],['revision',0],['source_revision','body'],['draft_revision','body'],['fact_refs','{}'],
  ['envelope',JSON.stringify({to:[],cc:[],body:'forbidden'})],['provider_thread_id',''],['in_reply_to',''],['reference_ids','{}'],['author_address','bad address'],['refusal','raw private prose']
 ] as const).map(([column,value]):OutboundCase=>({constraint:`human_reply_send_intents_${column}_check`,run:f=>insert(f,{[column]:value,...(column==='refusal'?{authorized:false}:{})})})),
 {constraint:'human_reply_send_intents_check',run:f=>insert(f,{authorized:true,refusal:'send_refused'})},
];
