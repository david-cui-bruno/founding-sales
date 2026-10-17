import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
interface Fixture {session:SessionQueryable;seeded:{alpha:{workspaceId:string;admin:{userId:string}}}}
interface Case {constraint:string;run:(fixture:Fixture)=>Promise<unknown>}
const table='booking_create_submissions';
async function insert(f:Fixture,changes:Record<string,unknown>={}){const row:Record<string,unknown>={id:randomUUID(),workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,policy_revision:1,binding_key:'a'.repeat(64),provider_account_id:9,event_type_id:7,request_hash:randomUUID().replaceAll('-','').repeat(2),source_fingerprint:'b'.repeat(64),payload:{agreement:{sourceId:randomUUID()},attendeeRouteId:randomUUID()},starts_at:'2026-10-14T14:00:00Z',buffer_ends_at:'2026-10-14T14:30:00Z',state:'pending',...changes};const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index)=>`$${index+1}`).join(',')})`,keys.map(key=>key==='payload'?JSON.stringify(row[key]):row[key]));}
const checks:[string,Record<string,unknown>][]=[
 ['policy_revision_check',{policy_revision:0}],['binding_key_check',{binding_key:''}],['provider_account_id_check',{provider_account_id:0}],['event_type_id_check',{event_type_id:0}],['request_hash_check',{request_hash:'bad'}],['source_fingerprint_check',{source_fingerprint:'bad'}],['payload_check',{payload:[]}],['provenance_state_check',{provenance_state:'unknown'}],['state_check',{state:'replay'}],['provider_booking_uid_check',{provider_booking_uid:'private uid'}],['reason_check',{reason:'Private description'}],
];
export const BOOKING_CREATE_CONSTRAINT_CASES:readonly Case[]=[
 ...checks.map(([suffix,changes])=>({constraint:`${table}_${suffix}`,run:async(f:Fixture)=>{if(suffix==='payload_check'||suffix==='provenance_state_check')await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT booking_create_provenance_shape`);return insert(f,changes);}})),
 {constraint:`${table}_workspace_id_fkey`,run:f=>insert(f,{workspace_id:randomUUID()})},
 {constraint:`${table}_owner_user_id_fkey`,run:f=>insert(f,{owner_user_id:randomUUID()})},
 {constraint:'booking_create_meeting',run:f=>insert(f,{meeting_id:randomUUID()})},
 {constraint:'booking_create_provenance_shape',run:f=>insert(f,{provenance_state:'redacted'})},
 {constraint:'booking_create_window',run:f=>insert(f,{buffer_ends_at:'2026-10-14T14:20:00Z'})},
 {constraint:'booking_create_accepted_evidence',run:f=>insert(f,{state:'accepted'})},
 {constraint:'booking_create_unknown_dispatch',run:f=>insert(f,{state:'unknown'})},
 {constraint:'booking_create_identity',run:async f=>{const request_hash='d'.repeat(64);await insert(f,{request_hash});return insert(f,{request_hash});}},
 {constraint:`${table}_pkey`,run:async f=>{const id=randomUUID();await insert(f,{id});return insert(f,{id});}},
 {constraint:'booking_create_workspace_id',run:async f=>{const id=randomUUID();await insert(f,{id});await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);return insert(f,{id});}},
];
