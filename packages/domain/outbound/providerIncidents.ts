import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {openHold,releaseHoldsOfEvent} from '../policy/holds.ts';
import {fenceOf,lockMailboxAtFence,readMailbox,type MailboxFence} from '../mail/mailboxes.ts';

export type ProviderIncidentClass='transient'|'authentication'|'reputation'|'unknown';
export type ProviderIncidentSource='sent_search'|'token_refresh'|'mail_read'|'provider_send'|'admin_report';
export interface ProviderBinding {readonly hash:string|null;readonly fence:MailboxFence}
type IncidentRow={id:string;mailbox_id:string;source_kind:ProviderIncidentSource;source_id:string;classification:ProviderIncidentClass;reason:string;binding_sha256:string|null;observed_at:Date;retry_at:Date|null};
export interface ProviderIncident {id:string;classification:ProviderIncidentClass;reason:string;state:'waiting'|'revalidation_due'|'action_required';retryAt:string|null;observedAt:string;sourceKind:ProviderIncidentSource;sourceId:string}

/** Existing grant generation, token rotation, admin auth evidence and cold authority.
 * Hash only metadata; no credentials or provider body enter an incident record. */
export async function readProviderBinding(ctx:RepositoryContext,mailboxId:string):Promise<ProviderBinding|null>{
 const mailbox=await readMailbox(ctx,mailboxId);if(!mailbox)return null;
 const row=(await ctx.db.query<{safe:boolean;metadata:unknown}>(`SELECT
  m.status='connected' AND wm.status='active' AND m.provider_account_id IS NOT NULL
  AND t.mailbox_id IS NOT NULL AND d.spf_pass AND d.dkim_pass AND d.dmarc_pass
  AND d.postmaster_reviewed_at IS NOT NULL AND d.automated_sending_enabled
  AND (a.mailbox_id IS NULL OR (a.enabled AND a.provider_account_id=m.provider_account_id AND a.email_address=m.email_address AND a.owner_user_id=m.owner_user_id)) AS safe,
  jsonb_build_array(m.generation,m.owner_user_id,m.provider_account_id,m.email_address,
    t.created_at,t.rotated_at,d.id,d.authentication_checked_at,d.postmaster_reviewed_at,
    d.automated_sending_enabled_at,a.revision,a.enabled) AS metadata
 FROM mailboxes m JOIN workspace_memberships wm ON wm.workspace_id=m.workspace_id AND wm.user_id=m.owner_user_id
 LEFT JOIN mailbox_tokens t ON t.workspace_id=m.workspace_id AND t.mailbox_id=m.id
 LEFT JOIN sending_domains d ON d.workspace_id=m.workspace_id AND d.is_primary
 LEFT JOIN gmail_prospecting_authorizations a ON a.workspace_id=m.workspace_id AND a.mailbox_id=m.id
 WHERE m.workspace_id=$1 AND m.id=$2`,[ctx.scope.workspaceId,mailboxId])).rows[0];
 return {fence:fenceOf(mailbox),hash:row?.safe===true?createHash('sha256').update(JSON.stringify(row.metadata)).digest('hex'):null};
}

/** Works in caller-owned worker transactions and standalone outbound calls. */
async function incidentTransaction<T>(ctx:RepositoryContext,work:()=>Promise<T>):Promise<T>{
 let own=false;
 try{await ctx.db.query('SAVEPOINT provider_incident_write');}
 catch(error){if(!(typeof error==='object'&&error!==null&&'code' in error&&error.code==='25P01'))throw error;await ctx.db.query('BEGIN');own=true;}
 try{const value=await work();await ctx.db.query(own?'COMMIT':'RELEASE SAVEPOINT provider_incident_write');return value;}
 catch(error){await ctx.db.query(own?'ROLLBACK':'ROLLBACK TO SAVEPOINT provider_incident_write');if(!own)await ctx.db.query('RELEASE SAVEPOINT provider_incident_write');throw error;}
}

export async function recordProviderIncident(ctx:RepositoryContext,input:{mailboxId:string;sourceKind:ProviderIncidentSource;sourceId:string;classification:ProviderIncidentClass;reason:string;retryAt?:string|null|undefined;binding:ProviderBinding;now:Date}):Promise<void>{
 await incidentTransaction(ctx,async()=>{
  await lockSendGateForStopFact(ctx);
  await lockMailboxAtFence(ctx,{mailboxId:input.mailboxId,fence:input.binding.fence,write:'provider incident'});
  const retry=typeof input.retryAt==='string'&&Number.isFinite(Date.parse(input.retryAt))&&Date.parse(input.retryAt)>input.now.getTime()?new Date(input.retryAt):null;
  const row=(await ctx.db.query<{id:string;hold_id:string|null}>(`INSERT INTO mailbox_provider_incidents
   (workspace_id,mailbox_id,source_kind,source_id,classification,reason,binding_sha256,observed_at,retry_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT(workspace_id,mailbox_id,source_kind,source_id) WHERE resolved_at IS NULL
   DO UPDATE SET retry_at=CASE WHEN mailbox_provider_incidents.classification='transient' AND EXCLUDED.classification='transient'
     AND mailbox_provider_incidents.retry_at IS NOT NULL AND EXCLUDED.retry_at IS NOT NULL THEN greatest(mailbox_provider_incidents.retry_at,EXCLUDED.retry_at) ELSE NULL END,
    classification=CASE WHEN mailbox_provider_incidents.classification='transient' THEN EXCLUDED.classification ELSE mailbox_provider_incidents.classification END,
    reason=CASE WHEN mailbox_provider_incidents.classification='transient' AND EXCLUDED.classification<>'transient' THEN EXCLUDED.reason ELSE mailbox_provider_incidents.reason END
   RETURNING id,hold_id`,[ctx.scope.workspaceId,input.mailboxId,input.sourceKind,input.sourceId,input.classification,input.reason,input.binding.hash,input.now,retry])).rows[0]!;
  if(row.hold_id===null){const holdId=await openHold(ctx,{scopeKind:'mailbox',scopeKey:input.mailboxId,reasonCode:'provider_refusal',blockedActionKinds:['email_send'],sourceEventKind:'provider_incident',sourceEventId:row.id,recoveryAction:'resume_after_review'});
   await ctx.db.query('UPDATE mailbox_provider_incidents SET hold_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,row.id,holdId]);}
 });
}

export async function readProviderIncidents(ctx:RepositoryContext,mailboxId:string,now=new Date()):Promise<readonly ProviderIncident[]>{
 const binding=await readProviderBinding(ctx,mailboxId);
 const rows=(await ctx.db.query<IncidentRow>('SELECT * FROM mailbox_provider_incidents WHERE workspace_id=$1 AND mailbox_id=$2 AND resolved_at IS NULL ORDER BY observed_at,id',[ctx.scope.workspaceId,mailboxId])).rows;
 const incidents:ProviderIncident[]=rows.map(row=>({id:row.id,classification:row.classification,reason:row.reason,
  state:row.classification!=='transient'||row.retry_at===null||row.binding_sha256===null||binding?.hash!==row.binding_sha256?'action_required':row.retry_at.getTime()>now.getTime()?'waiting':'revalidation_due',
  retryAt:row.retry_at?.toISOString()??null,observedAt:row.observed_at.toISOString(),sourceKind:row.source_kind,sourceId:row.source_id}));
 const fences=(await ctx.db.query<{id:string;state:string;dispatch_started_at:Date;created_at:Date}>(`SELECT id,state,dispatch_started_at,created_at FROM outbound_messages
  WHERE workspace_id=$1 AND mailbox_id=$2 AND (state IN ('dispatching','reconciling') OR (state='unknown_terminal' AND admin_resolution IS NULL))
  ORDER BY dispatch_started_at,id LIMIT 100`,[ctx.scope.workspaceId,mailboxId])).rows;
 for(const fence of fences)incidents.push({id:fence.id,classification:'unknown',reason:'unresolved_submission',
  state:fence.state==='unknown_terminal'?'action_required':'revalidation_due',retryAt:null,
  observedAt:(fence.dispatch_started_at??fence.created_at).toISOString(),sourceKind:'provider_send',sourceId:fence.id});
 return incidents;
}

export async function providerIncidentRefusal(ctx:RepositoryContext,mailboxId:string,now:Date):Promise<{reason:'rate_limited'|'provider_refusal';detail:string;retryAt?:string}|null>{
 const incidents=await readProviderIncidents(ctx,mailboxId,now);
 if(incidents.length===0)return null;
 if(incidents.some(i=>i.state==='action_required'))return {reason:'provider_refusal',detail:'provider_incident_requires_review'};
 const waiting=incidents.filter(i=>i.state==='waiting');
 if(waiting.length)return {reason:'rate_limited',detail:'provider_cooldown',retryAt:waiting.map(i=>i.retryAt!).sort().at(-1)!};
 return {reason:'provider_refusal',detail:'provider_incident_revalidation_due'};
}

/** A fresh successful read clears only safe, unchanged incidents whose wait expired. */
export async function resolveProviderIncidentsAfterRead(ctx:RepositoryContext,mailboxId:string,before:ProviderBinding,now:Date,sources:readonly ProviderIncidentSource[]=['sent_search','mail_read','token_refresh','provider_send']):Promise<void>{
 if(before.hash===null)return;
 if((await ctx.db.query(`SELECT 1 FROM mailbox_provider_incidents WHERE workspace_id=$1 AND mailbox_id=$2 AND resolved_at IS NULL
  AND classification='transient' AND source_kind=ANY($3::text[]) LIMIT 1`,[ctx.scope.workspaceId,mailboxId,sources])).rows.length===0)return;
 await incidentTransaction(ctx,async()=>{
  await lockSendGateForStopFact(ctx);
  await lockMailboxAtFence(ctx,{mailboxId,fence:before.fence,write:'provider incident recovery'});
  const current=await readProviderBinding(ctx,mailboxId);
  if(before.hash===null||current?.hash!==before.hash)return;
  const rows=(await ctx.db.query<{id:string}>(`UPDATE mailbox_provider_incidents SET resolved_at=$4,resolution='verified_read'
   WHERE workspace_id=$1 AND mailbox_id=$2 AND binding_sha256=$3 AND classification='transient'
   AND source_kind=ANY($5::text[]) AND retry_at IS NOT NULL AND retry_at<=$4 AND resolved_at IS NULL RETURNING id`,[ctx.scope.workspaceId,mailboxId,before.hash,now,sources])).rows;
  for(const row of rows)await releaseHoldsOfEvent(ctx,{sourceEventId:row.id,reasonCode:'provider_refusal'});
 });
}

/** Only established explicit grant/permission/auth commands call this. They may
 * refresh a transient binding, but never erase its provider deadline. Revoked
 * grants require the successful OAuth reconnect; reputation/unknown stay held. */
export async function revalidateProviderIncidentConfiguration(ctx:RepositoryContext,mailboxId:string,basis:'oauth_reconnected'|'permission_revalidated'|'domain_authentication_checked',now:Date):Promise<void>{
 if(ctx.scope.actor.kind!=='user'||(basis!=='oauth_reconnected'&&ctx.scope.actor.role!=='admin'))return;
 const current=await readProviderBinding(ctx,mailboxId);if(current===null)return;
 if(current.hash!==null)await ctx.db.query(`UPDATE mailbox_provider_incidents SET binding_sha256=$3
  WHERE workspace_id=$1 AND mailbox_id=$2 AND classification='transient' AND resolved_at IS NULL`,[ctx.scope.workspaceId,mailboxId,current.hash]);
 if(basis!=='oauth_reconnected')return;
 const rows=(await ctx.db.query<{id:string}>(`UPDATE mailbox_provider_incidents i SET resolved_at=$3,resolution='human_revalidated'
  FROM mailboxes m WHERE i.workspace_id=$1 AND i.mailbox_id=$2 AND m.workspace_id=i.workspace_id AND m.id=i.mailbox_id
  AND i.classification='authentication' AND i.resolved_at IS NULL AND m.connected_at>=i.observed_at
  AND m.status='connected' AND EXISTS(SELECT 1 FROM mailbox_tokens t WHERE t.workspace_id=m.workspace_id AND t.mailbox_id=m.id)
  AND EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id=m.workspace_id AND wm.user_id=m.owner_user_id AND wm.status='active')
  RETURNING i.id`,[ctx.scope.workspaceId,mailboxId,now])).rows;
 for(const row of rows)await releaseHoldsOfEvent(ctx,{sourceEventId:row.id,reasonCode:'provider_refusal'});
}
