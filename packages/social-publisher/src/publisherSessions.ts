import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {SOCIAL_BROWSER_ADAPTER,type SocialPublisherBinding} from '@fss/contracts';
import type {Queryable} from '@fss/domain/db/queryable.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';

export interface PublisherOwner {workspaceId:string;ownerUserId:string}
export type PublisherExecutionSide='api'|'worker';
export interface PublisherSessionStore {
 read(binding:SocialPublisherBinding):Promise<string|null>;
 save(owner:PublisherOwner,accountId:string,identity:{externalId:string;displayName:string},state:string,authority:()=>Promise<void>):Promise<SocialPublisherBinding>;
 disconnect(owner:PublisherOwner,accountId:string,authority:()=>Promise<void>):Promise<void>;
 heartbeat(executionSide:PublisherExecutionSide,chromiumVersion:string):Promise<void>;
}
/** AAD prevents swapping encrypted browser credentials across owners/accounts/revisions. */
export function sealPublisherSession(key:Buffer,binding:SocialPublisherBinding,state:string):Buffer {
 if(key.length!==32||Buffer.byteLength(state)>500000)throw new Error('publisher_session_invalid');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(Buffer.from([binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision,binding.sessionId,binding.sessionRevision,binding.externalId].join('\n')));
 const encrypted=Buffer.concat([cipher.update(state,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
}
export function openPublisherSession(key:Buffer,binding:SocialPublisherBinding,sealed:Buffer):string {
 if(key.length!==32||sealed.length<29||sealed.length>524288)throw new Error('publisher_session_invalid');
 const cipher=createDecipheriv('aes-256-gcm',key,sealed.subarray(0,12));
 cipher.setAAD(Buffer.from([binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision,binding.sessionId,binding.sessionRevision,binding.externalId].join('\n')));cipher.setAuthTag(sealed.subarray(12,28));
 return Buffer.concat([cipher.update(sealed.subarray(28)),cipher.final()]).toString('utf8');
}
export function postgresPublisherSessions(db:Queryable,key:Buffer):PublisherSessionStore {
 if(key.length!==32)throw new Error('publisher_session_key_invalid');
 return {
  async read(binding){
   const row=(await db.query<{encrypted_state:Buffer}>(`SELECT s.encrypted_state FROM social_publisher_sessions s JOIN social_accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id
    WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.account_id=$3 AND s.id=$4 AND s.revision=$5 AND s.account_revision=$6 AND s.external_id=$7
    AND s.state='usable' AND s.expires_at>clock_timestamp() AND a.revision=s.account_revision AND a.state='connected' AND a.external_id=s.external_id AND m.status='active' AND m.role='admin'`,[binding.workspaceId,binding.ownerUserId,binding.accountId,binding.sessionId,binding.sessionRevision,binding.accountRevision,binding.externalId])).rows[0];
   if(!row)return null;
   try{return openPublisherSession(key,binding,row.encrypted_state);}catch{return null;}
  },
  async save(owner,accountId,identity,state,authority){
   return withTransaction(db,async()=>{
    const active=await db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[owner.workspaceId,owner.ownerUserId]);
    if(active.rows.length!==1)throw new Error('publisher_owner_unavailable');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${owner.workspaceId}:${owner.ownerUserId}`]);
    const old=(await db.query<{owner_user_id:string;external_id:string;platform:string;account_kind:string;revision:number}>('SELECT owner_user_id,external_id,platform,account_kind,revision FROM social_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[owner.workspaceId,accountId])).rows[0];
    if(old&&(old.owner_user_id!==owner.ownerUserId||old.external_id!==identity.externalId||old.platform!=='linkedin'||old.account_kind!=='profile'))throw new Error('publisher_account_mismatch');
    if(!old){
     const count=(await db.query<{count:number}>('SELECT count(*)::integer AS count FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2',[owner.workspaceId,owner.ownerUserId])).rows[0]?.count;
     if(count===undefined||count>=30)throw new Error('publisher_account_limit');
    }
    const duplicate=await db.query('SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND external_id=$3 AND platform=\'linkedin\' AND id<>$4',[owner.workspaceId,owner.ownerUserId,identity.externalId,accountId]);
    if(duplicate.rows.length)throw new Error('publisher_account_already_connected');
    const revision=(old?.revision??0)+1;
    await authority();
    await db.query(`INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,revision,adapter_version,verified_at,max_schedule_days)
     VALUES($1,$2,$3,'linkedin',$4,$5,'profile','connected',$6,$7,clock_timestamp(),30)
     ON CONFLICT(workspace_id,id) DO UPDATE SET state='connected',revision=$6,display_name=$5,adapter_version=$7,verified_at=clock_timestamp(),max_schedule_days=30`,[owner.workspaceId,accountId,owner.ownerUserId,identity.externalId,identity.displayName,revision,SOCIAL_BROWSER_ADAPTER]);
    const binding:SocialPublisherBinding={workspaceId:owner.workspaceId,ownerUserId:owner.ownerUserId,accountId,accountRevision:revision,sessionId:randomUUID(),sessionRevision:1,externalId:identity.externalId};
    await db.query(`INSERT INTO social_publisher_sessions(workspace_id,id,owner_user_id,account_id,account_revision,revision,external_id,encrypted_state,state,verified_at,expires_at)
     VALUES($1,$2,$3,$4,$5,1,$6,$7,'usable',clock_timestamp(),clock_timestamp()+interval '7 days')
     ON CONFLICT(workspace_id,account_id) DO UPDATE SET id=$2,account_revision=$5,revision=1,external_id=$6,encrypted_state=$7,state='usable',verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days'`,[owner.workspaceId,binding.sessionId,owner.ownerUserId,accountId,revision,identity.externalId,sealPublisherSession(key,binding,state)]);
    await authority();return binding;
   });
  },
  async disconnect(owner,accountId,authority){await withTransaction(db,async()=>{
   await db.query("UPDATE social_accounts SET state='disconnected',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3",[owner.workspaceId,accountId,owner.ownerUserId]);
   await db.query("UPDATE social_publisher_sessions SET state='disconnected',encrypted_state=NULL,revision=revision+1 WHERE workspace_id=$1 AND account_id=$2 AND owner_user_id=$3",[owner.workspaceId,accountId,owner.ownerUserId]);
   await authority();
  });},
  async heartbeat(executionSide,version){
   // Saving an observation must not extend its ninety-second freshness window.
   await db.query(`WITH instant AS MATERIALIZED(SELECT clock_timestamp() AS at)
    INSERT INTO social_publisher_runtime(id,execution_side,observed_at,expires_at,chromium_version)
    SELECT $1,$2,at,at+interval '90 seconds',$3 FROM instant WHERE true
    ON CONFLICT(id,execution_side) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,chromium_version=EXCLUDED.chromium_version`,[SOCIAL_BROWSER_ADAPTER,executionSide,version]);
  },
 };
}
