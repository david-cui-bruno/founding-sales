import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';

type Fixture={session:SessionQueryable;seeded:TwoWorkspaces};
type PublisherTable='social_publisher_sessions'|'social_publisher_runtime';
async function insert(fixture:Fixture,table:PublisherTable,row:Record<string,unknown>){
 const keys=Object.keys(row);
 return fixture.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index)=>`$${index+1}`).join(',')})`,Object.values(row));
}
async function sessionRow(fixture:Fixture){
 const accountId=randomUUID(),externalId=`https://www.linkedin.com/in/fixture-${accountId}`;
 await fixture.session.query(`INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state)
  VALUES($1,$2,$3,'linkedin',$4,'Fictional constraint fixture','profile','unsupported')`,[fixture.seeded.alpha.workspaceId,accountId,fixture.seeded.alpha.admin.userId,externalId]);
 const verifiedAt=new Date();
 return {workspace_id:fixture.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:fixture.seeded.alpha.admin.userId,account_id:accountId,account_revision:1,revision:1,external_id:externalId,encrypted_state:Buffer.alloc(29),state:'usable',verified_at:verifiedAt,expires_at:new Date(verifiedAt.getTime()+7*86400000)};
}
const invalidSession=(constraint:string,patch:Record<string,unknown>)=>({
 constraint,run:async(fixture:Fixture)=>insert(fixture,'social_publisher_sessions',{...await sessionRow(fixture),...patch}),
});
function runtimeRow(){
 const observedAt=new Date();
 return {id:'linkedin-web-chromium-v1',execution_side:'worker',observed_at:observedAt,expires_at:new Date(observedAt.getTime()+90000),chromium_version:'controlled-fixture-version'};
}
const invalidRuntime=(constraint:string,patch:Record<string,unknown>)=>({
 constraint,run:async(fixture:Fixture)=>insert(fixture,'social_publisher_runtime',{...runtimeRow(),...patch}),
});

export const SOCIAL_PUBLISHER_CONSTRAINT_CASES=[
 invalidSession('social_publisher_sessions_account_revision_check',{account_revision:0}),
 invalidSession('social_publisher_sessions_revision_check',{revision:0}),
 invalidSession('social_publisher_sessions_external_id_check',{external_id:''}),
 invalidSession('social_publisher_sessions_external_id_check',{external_id:'x'.repeat(301)}),
 invalidSession('social_publisher_sessions_state_check',{state:'connected',encrypted_state:null}),
 invalidSession('social_publisher_sessions_credentials_shape',{state:'disconnected'}),
 invalidSession('social_publisher_sessions_credentials_shape',{encrypted_state:null}),
 invalidSession('social_publisher_sessions_encrypted_state_size',{encrypted_state:Buffer.alloc(28)}),
 invalidSession('social_publisher_sessions_encrypted_state_size',{encrypted_state:Buffer.alloc(524289)}),
 invalidSession('social_publisher_sessions_workspace_id_account_id_fkey',{account_id:'00000000-0000-4000-8000-000000000165'}),
 {
  constraint:'social_publisher_sessions_pkey',
  run:async(fixture:Fixture)=>{
   const row=await sessionRow(fixture);await insert(fixture,'social_publisher_sessions',row);
   return insert(fixture,'social_publisher_sessions',{...await sessionRow(fixture),id:row.id});
  },
 },
 {
  constraint:'social_publisher_sessions_workspace_id_account_id_key',
  run:async(fixture:Fixture)=>{
   const row=await sessionRow(fixture);await insert(fixture,'social_publisher_sessions',row);
   return insert(fixture,'social_publisher_sessions',{...row,id:randomUUID()});
  },
 },
 {
  constraint:'social_publisher_sessions_expiry',
  run:async(fixture:Fixture)=>{
   const row=await sessionRow(fixture);
   return insert(fixture,'social_publisher_sessions',{...row,expires_at:row.verified_at});
  },
 },
 {
  constraint:'social_publisher_sessions_expiry',
  run:async(fixture:Fixture)=>{
   const row=await sessionRow(fixture);
   return insert(fixture,'social_publisher_sessions',{...row,expires_at:new Date(row.verified_at.getTime()+30*86400000+1)});
  },
 },
 invalidRuntime('social_publisher_runtime_id_check',{id:'configured-but-unimplemented-runner'}),
 invalidRuntime('social_publisher_runtime_execution_side_check',{execution_side:'web-configured-runner'}),
 invalidRuntime('social_publisher_runtime_chromium_version_check',{chromium_version:''}),
 invalidRuntime('social_publisher_runtime_chromium_version_check',{chromium_version:'x'.repeat(101)}),
 {
  constraint:'social_publisher_runtime_pkey',
  run:async(fixture:Fixture)=>{
   const row=runtimeRow();await insert(fixture,'social_publisher_runtime',row);
   return insert(fixture,'social_publisher_runtime',row);
  },
 },
 {
  constraint:'social_publisher_runtime_expiry',
  run:async(fixture:Fixture)=>{
   const row=runtimeRow();return insert(fixture,'social_publisher_runtime',{...row,expires_at:row.observed_at});
  },
 },
 {
  constraint:'social_publisher_runtime_expiry',
  run:async(fixture:Fixture)=>{
   const row=runtimeRow();return insert(fixture,'social_publisher_runtime',{...row,expires_at:new Date(row.observed_at.getTime()+300001)});
  },
 },
];
