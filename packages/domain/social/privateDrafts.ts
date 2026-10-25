import {socialPrivateDraftSaveInputSchema,socialPrivateDraftViewSchema,type SocialPrivateDraftSaveInput,type SocialPrivateDraftView,type SocialPrivateDraftMetadata,type SocialPrivateDraftList,type SocialPrivateDraftOrigin,type SocialDraftRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {privateSourceBasis,selectedPrivateSource,type PrivateSourceBasis} from './privateDraftSources.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
export class PrivateDraftAuthorityChanged extends Error{}
export type PrivateDraftAuthority=()=>Promise<boolean>;
export async function requirePrivateDraftAuthority(check:PrivateDraftAuthority):Promise<void>{if(!await check())throw new PrivateDraftAuthorityChanged();}
interface Row{[key:string]:unknown;id:string;owner_user_id:string;revision:number;kind:'post'|'comment';origin_kind:'manual'|'suggestion';text:string|null;origin:SocialPrivateDraftOrigin|null;source_selection:SocialDraftRequest|null;source_hash:string|null;reason:'expired'|'source_changed_or_unavailable'|'removed'|null;created_at:Date;updated_at:Date;expires_at:Date}
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
async function membership(ctx:RepositoryContext):Promise<boolean>{const user=owner(ctx);return user!==null&&(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[ctx.scope.workspaceId,user])).rows.length===1;}
async function fetchRow(ctx:RepositoryContext,id:string,lock=false):Promise<Row|null>{return (await ctx.db.query<Row>(`SELECT * FROM social_private_drafts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3${lock?' FOR UPDATE':''}`,[ctx.scope.workspaceId,id,owner(ctx)])).rows[0]??null;}
const metadata=(r:Row):SocialPrivateDraftMetadata=>({draftId:r.id,revision:r.revision,kind:r.kind,originKind:r.origin_kind,availability:r.reason===null?'available':'unavailable',createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),expiresAt:r.expires_at.toISOString()});
async function wallclock(ctx:RepositoryContext):Promise<Date>{return (await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;}
async function erase(ctx:RepositoryContext,row:Row,reason:NonNullable<Row['reason']>):Promise<Row>{return (await ctx.db.query<Row>(`UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason=$4,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND reason IS NULL RETURNING *`,[ctx.scope.workspaceId,row.id,owner(ctx),reason])).rows[0]??row;}
/** Inspect origin first, lock its sources before the private row, then reread.
 * Persisted source basis is immutable and independent of dispatch-request expiry. */
async function currentRow(ctx:RepositoryContext,id:string,authority:PrivateDraftAuthority):Promise<Row|null>{
 const before=await fetchRow(ctx,id);if(!before)return null;
 const source=before.reason===null&&before.source_selection?await privateSourceBasis(ctx,before.source_selection):null;
 let row=await fetchRow(ctx,id,true);if(!row)return null;
 await requirePrivateDraftAuthority(authority);
 if(row.reason!==null)return row;
 if(row.expires_at<=await wallclock(ctx))return erase(ctx,row,'expired');
 if(row.source_selection){
  // Sources above remain locked, but their time-dependent rights are read AFTER
  // the private-row/auth waits too. No new dependency can appear on an update.
  const fresh=source?.ok?await privateSourceBasis(ctx,row.source_selection):source;
  if(!fresh?.ok||fresh.value.hash!==row.source_hash)row=await erase(ctx,row,'source_changed_or_unavailable');
 }
 return row;
}
export async function saveSocialPrivateDraft(ctx:RepositoryContext,raw:SocialPrivateDraftSaveInput,authority:PrivateDraftAuthority):Promise<SocialResult<{draftId:string;revision:number}>>{
 const parsed=socialPrivateDraftSaveInputSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 if(!await membership(ctx))return {ok:false,reason:'owner_unavailable'};
 const input=parsed.data;
 let row:Row;
 if(input.operation==='create'){
  let basis:PrivateSourceBasis|null=null;
  if(input.origin.kind==='suggestion'){const selected=await selectedPrivateSource(ctx,input.origin);if(!selected.ok)return selected;basis=selected.value;}
  await requirePrivateDraftAuthority(authority);
  // Authority may have waited. Check source policy and initial request again
  // before inserting, with all previous dependency locks retained.
  if(input.origin.kind==='suggestion'){const selected=await selectedPrivateSource(ctx,input.origin);if(!selected.ok)return selected;basis=selected.value;}
  row=(await ctx.db.query<Row>(`INSERT INTO social_private_drafts(workspace_id,owner_user_id,kind,text,origin_kind,origin,source_selection,source_hash,dependencies,created_at,updated_at,expires_at) SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,t,t,LEAST(t+interval '90 days',$10::timestamptz) FROM (SELECT clock_timestamp() t) clock RETURNING *`,[ctx.scope.workspaceId,owner(ctx),input.kind,input.text,input.origin.kind,JSON.stringify(input.origin),basis?JSON.stringify(basis.selection):null,basis?.hash??null,JSON.stringify(basis?.dependencies??{}),basis?.expiresAt??null])).rows[0]!;
 }else{
  const current=await currentRow(ctx,input.draftId,authority);if(!current)return {ok:false,reason:'not_found'};
  if(current.reason!==null)return {ok:false,reason:current.reason};
  if(current.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
  row=(await ctx.db.query<Row>('UPDATE social_private_drafts SET text=$4,kind=$5,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 RETURNING *',[ctx.scope.workspaceId,current.id,owner(ctx),input.text,input.kind])).rows[0]!;
 }
 await requirePrivateDraftAuthority(authority);
 if(row.expires_at<=await wallclock(ctx))throw new PrivateDraftAuthorityChanged();
 await recordCrmAuditEvent(ctx,{action:'social.private_draft_saved',subjectKind:'social_private_draft',subjectId:row.id,detail:{revision:row.revision}});
 return {ok:true,value:{draftId:row.id,revision:row.revision}};
}
export async function readSocialPrivateDraft(ctx:RepositoryContext,id:string,authority:PrivateDraftAuthority):Promise<SocialPrivateDraftView|null>{
 if(!await membership(ctx))return null;
 const row=await currentRow(ctx,id,authority);if(!row)return null;
 await requirePrivateDraftAuthority(authority);
 return socialPrivateDraftViewSchema.parse(row.reason===null?{...metadata(row),availability:'available',text:row.text,origin:row.origin,reviewRequired:true}:{...metadata(row),availability:'unavailable',reason:row.reason});
}
export async function listSocialPrivateDrafts(ctx:RepositoryContext,afterId:string|undefined,authority:PrivateDraftAuthority):Promise<SocialPrivateDraftList>{
 if(!await membership(ctx))return {drafts:[],nextAfterId:null};
 const rows=(await ctx.db.query<{id:string}>('SELECT id FROM social_private_drafts WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21',[ctx.scope.workspaceId,owner(ctx),afterId??null])).rows;
 const drafts:SocialPrivateDraftMetadata[]=[];
 // Acquire the complete page's immutable source bases before any private row.
 for(const candidate of rows.slice(0,20)){const row=await fetchRow(ctx,candidate.id);if(row?.source_selection&&row.reason===null)await privateSourceBasis(ctx,row.source_selection);}
 for(const candidate of rows.slice(0,20)){const row=await currentRow(ctx,candidate.id,authority);if(row)drafts.push(metadata(row));}
 await requirePrivateDraftAuthority(authority);
 return {drafts,nextAfterId:rows.length>20?drafts.at(-1)?.draftId??null:null};
}
