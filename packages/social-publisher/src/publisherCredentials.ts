import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {SOCIAL_PUBLISHER_ADAPTER,type SocialPublisherBinding} from '@fss/contracts';
import type {Queryable} from '@fss/domain/db/queryable.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {PublisherRefusal} from './publisherBuffer.ts';
export interface PublisherOwner {workspaceId:string;ownerUserId:string}
export type PublisherExecutionSide='api'|'worker';
export interface PublisherIdentity {organizationId:string;channelId:string;externalId:string;displayName:string}
export interface PublisherCredentialStore {
 read(binding:SocialPublisherBinding):Promise<string|null>;
 save(owner:PublisherOwner,accountId:string,identity:PublisherIdentity,apiKey:string,authority:()=>Promise<void>):Promise<SocialPublisherBinding>;
 disconnect(owner:PublisherOwner,accountId:string,authority:()=>Promise<void>):Promise<void>;
 heartbeat(executionSide:PublisherExecutionSide):Promise<void>;
}
const aad=(binding:SocialPublisherBinding)=>Buffer.from([binding.adapter,binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision,binding.credentialId,binding.credentialRevision,binding.organizationId,binding.channelId,binding.externalId].join('\n'));
function payload(state:string):string {const parsed:unknown=JSON.parse(state);if(!parsed||typeof parsed!=='object'||Object.keys(parsed).sort().join(',')!=='apiKey,provider'||!('provider' in parsed)||parsed.provider!==SOCIAL_PUBLISHER_ADAPTER||!('apiKey' in parsed)||typeof parsed.apiKey!=='string'||!parsed.apiKey||parsed.apiKey.length>4096||!/^[!-~]+$/u.test(parsed.apiKey))throw new Error('publisher_credential_invalid');return parsed.apiKey;}
export function sealPublisherCredential(key:Buffer,binding:SocialPublisherBinding,apiKey:string):Buffer {
 const state=JSON.stringify({provider:SOCIAL_PUBLISHER_ADAPTER,apiKey});payload(state);
 if(key.length!==32)throw new Error('publisher_credential_invalid');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(binding));
 const encrypted=Buffer.concat([cipher.update(state,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
}
export function openPublisherCredential(key:Buffer,binding:SocialPublisherBinding,sealed:Buffer):string {
 if(key.length!==32||sealed.length<29||sealed.length>8192)throw new Error('publisher_credential_invalid');
 const cipher=createDecipheriv('aes-256-gcm',key,sealed.subarray(0,12));cipher.setAAD(aad(binding));cipher.setAuthTag(sealed.subarray(12,28));return payload(Buffer.concat([cipher.update(sealed.subarray(28)),cipher.final()]).toString('utf8'));
}
export function postgresPublisherCredentials(db:Queryable,key:Buffer):PublisherCredentialStore {
 if(key.length!==32)throw new Error('publisher_credential_key_invalid');
 return {
  async read(binding){
   if(binding.adapter!==SOCIAL_PUBLISHER_ADAPTER)return null;
   const row=(await db.query<{encrypted_state:Buffer}>(`SELECT c.encrypted_state FROM social_publisher_credentials c JOIN social_accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id JOIN workspace_memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
    WHERE c.workspace_id=$1 AND c.owner_user_id=$2 AND c.account_id=$3 AND c.id=$4 AND c.revision=$5 AND c.account_revision=$6 AND c.external_id=$7 AND c.organization_id=$8 AND c.channel_id=$9 AND c.adapter=$10
    AND c.state='usable' AND a.owner_user_id=c.owner_user_id AND a.revision=c.account_revision AND a.state='connected' AND a.external_id=c.external_id AND a.adapter_version=c.adapter AND m.status='active' AND m.role='admin'`,[binding.workspaceId,binding.ownerUserId,binding.accountId,binding.credentialId,binding.credentialRevision,binding.accountRevision,binding.externalId,binding.organizationId,binding.channelId,binding.adapter])).rows[0];
   if(!row)return null;try{return openPublisherCredential(key,binding,row.encrypted_state);}catch{return null;}
  },
  async save(owner,accountId,identity,apiKey,authority){return withTransaction(db,async()=>{
   const active=await db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[owner.workspaceId,owner.ownerUserId]);if(active.rows.length!==1)throw new PublisherRefusal('publisher_owner_unavailable');
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${owner.workspaceId}:${owner.ownerUserId}`]);
   const old=(await db.query<{owner_user_id:string;external_id:string;platform:string;account_kind:string;revision:number}>('SELECT owner_user_id,external_id,platform,account_kind,revision FROM social_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[owner.workspaceId,accountId])).rows[0];
   if(old&&(old.owner_user_id!==owner.ownerUserId||old.external_id!==identity.externalId||old.platform!=='linkedin'||old.account_kind!=='profile'))throw new PublisherRefusal('publisher_account_mismatch');
   if(!old){const count=(await db.query<{count:number}>('SELECT count(*)::integer AS count FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2',[owner.workspaceId,owner.ownerUserId])).rows[0]?.count;if(count===undefined||count>=30)throw new PublisherRefusal('publisher_account_limit');}
   if((await db.query("SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND external_id=$3 AND platform='linkedin' AND id<>$4",[owner.workspaceId,owner.ownerUserId,identity.externalId,accountId])).rows.length)throw new PublisherRefusal('publisher_account_already_connected');
   const revision=(old?.revision??0)+1;await authority();
   await db.query(`INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,revision,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin',$4,$5,'profile','connected',$6,$7,clock_timestamp(),30)
    ON CONFLICT(workspace_id,id) DO UPDATE SET state='connected',revision=$6,display_name=$5,adapter_version=$7,verified_at=clock_timestamp(),max_schedule_days=30`,[owner.workspaceId,accountId,owner.ownerUserId,identity.externalId,identity.displayName,revision,SOCIAL_PUBLISHER_ADAPTER]);
   const binding:SocialPublisherBinding={...owner,adapter:SOCIAL_PUBLISHER_ADAPTER,accountId,accountRevision:revision,credentialId:randomUUID(),credentialRevision:1,organizationId:identity.organizationId,channelId:identity.channelId,externalId:identity.externalId};
   await db.query(`INSERT INTO social_publisher_credentials(workspace_id,id,owner_user_id,account_id,account_revision,revision,adapter,organization_id,channel_id,external_id,encrypted_state,state,verified_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,'usable',clock_timestamp())
    ON CONFLICT(workspace_id,account_id) DO UPDATE SET id=$2,account_revision=$5,revision=1,adapter=$6,organization_id=$7,channel_id=$8,external_id=$9,encrypted_state=$10,state='usable',verified_at=clock_timestamp()`,[owner.workspaceId,binding.credentialId,owner.ownerUserId,accountId,revision,SOCIAL_PUBLISHER_ADAPTER,identity.organizationId,identity.channelId,identity.externalId,sealPublisherCredential(key,binding,apiKey)]);await authority();return binding;
  });},
  async disconnect(owner,accountId,authority){await withTransaction(db,async()=>{await db.query("UPDATE social_accounts SET state='disconnected',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3",[owner.workspaceId,accountId,owner.ownerUserId]);await db.query("UPDATE social_publisher_credentials SET state='disconnected',encrypted_state=NULL,revision=revision+1 WHERE workspace_id=$1 AND account_id=$2 AND owner_user_id=$3",[owner.workspaceId,accountId,owner.ownerUserId]);await authority();});},
  async heartbeat(side){await db.query(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at) INSERT INTO social_buffer_publisher_runtime(id,execution_side,observed_at,expires_at) SELECT $1,$2,at,at+interval '90 seconds' FROM instant WHERE true ON CONFLICT(id,execution_side) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at`,[SOCIAL_PUBLISHER_ADAPTER,side]);},
 };
}
