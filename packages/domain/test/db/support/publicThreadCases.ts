import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
import {publicThreadFixture} from '../../social/publicThreadFixture.ts';
import {publicThreadSHA256} from '../../../social/publicThreadValidation.ts';
type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string;admin:{userId:string}}}};
type Row=Record<string,unknown>;
async function row(f:Fixture):Promise<Row>{
 const now=(await f.session.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now;
 const input=publicThreadFixture(new Date(now.getTime()-1000).toISOString());
 return {workspace_id:f.seeded.alpha.workspaceId,id:input.threadId,owner_user_id:f.seeded.alpha.admin.userId,captured_at:input.capturedAt,
  expires_at:new Date(now.getTime()+86400000).toISOString(),source_url:input.snapshot.url,payload:JSON.stringify(input.snapshot),payload_sha256:publicThreadSHA256(JSON.stringify(input.snapshot)),coverage:'partial',message_count:2};
}
async function insert(f:Fixture,value:Row){const keys=Object.keys(value);return f.session.query(`INSERT INTO social_public_threads(${keys.join(',')}) VALUES(${keys.map((_,index)=>`$${index+1}`).join(',')})`,Object.values(value));}
const bad=(constraint:string,patch:Row)=>({constraint,run:async(f:Fixture)=>insert(f,{...await row(f),...patch})});
/** Every label is a real rejecting FK/CHECK/constraint-trigger catalog entry. */
export const SOCIAL_PUBLIC_THREAD_CONSTRAINT_CASES=[
 bad('social_public_threads_workspace_id_fkey',{workspace_id:'00000000-0000-4000-8000-000000000148'}),
 bad('social_public_thread_revision',{revision:0}),
 {constraint:'social_public_thread_lifetime',run:async(f:Fixture)=>{const value=await row(f);return insert(f,{...value,expires_at:new Date(Date.parse(String(value['captured_at']))+31*86400000).toISOString()});}},
 bad('social_public_thread_reason',{revision:2,reason:'published',source_url:null,payload:null,payload_sha256:null,coverage:null,message_count:null}),
 {constraint:'social_public_thread_url',run:async(f:Fixture)=>{const value=await row(f),payload=JSON.parse(String(value['payload']));payload.url='https://www.linkedin.com/groups/123/';return insert(f,{...value,source_url:payload.url,payload:JSON.stringify(payload)});}},
 bad('social_public_thread_hash',{payload_sha256:'invalid'}),
 bad('social_public_thread_payload',{payload:'{}'}),
 bad('social_public_thread_live_shape',{reason:'removed',revision:2}),
 bad('social_public_thread_owner_active',{owner_user_id:'00000000-0000-4000-8000-000000000148'}),
 {constraint:'social_public_thread_immutable',run:async(f:Fixture)=>{const value=await row(f);await insert(f,value);return f.session.query('UPDATE social_public_threads SET id=$2 WHERE workspace_id=$1 AND id=$3',[value['workspace_id'],randomUUID(),value['id']]);}},
 {constraint:'social_public_threads_pkey',run:async(f:Fixture)=>{const value=await row(f);await insert(f,value);return insert(f,value);}},
];
