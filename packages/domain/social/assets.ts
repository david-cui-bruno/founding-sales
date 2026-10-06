import {randomUUID} from 'node:crypto';
import {registerSocialAssetSchema,type RegisterSocialAsset,type SocialAssetView,type AssetOrigin} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Asset={id:string;owner_user_id:string;state:SocialAssetView['state'];current_version:number;origin:AssetOrigin};
type ObjectRow={version:number;upload_id:string;object_key:string;kind:'original'|'derivative';state:'uploading'|'ready'|'deleted';sha256:string;bytes:number;mime:string;width:number|null;height:number|null;expired:boolean};
const user=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
async function lock(ctx:RepositoryContext){await ctx.db.query('INSERT INTO social_library_usage(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[ctx.scope.workspaceId]);return Number((await ctx.db.query<{bytes_reserved:string}>('SELECT bytes_reserved FROM social_library_usage WHERE workspace_id=$1 FOR UPDATE',[ctx.scope.workspaceId])).rows[0]!.bytes_reserved);}
async function asset(ctx:RepositoryContext,id:string){return (await ctx.db.query<Asset>('SELECT * FROM social_assets WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[ctx.scope.workspaceId,id,user(ctx)])).rows[0]??null;}
/** Called in the command transaction. Reservations include pending uploads and retained old versions. */
export async function registerSocialAsset(ctx:RepositoryContext,raw:RegisterSocialAsset):Promise<Result<{assetId:string;uploadId:string}>>{
 const owner=user(ctx);if(!owner)return {ok:false,reason:'user_required'};
 const parsed=registerSocialAssetSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data,used=await lock(ctx);let id=input.assetId,version=1;
 if(id){const row=await asset(ctx,id);if(!row)return {ok:false,reason:'not_found'};if(row.state==='deleted')return {ok:false,reason:'asset_deleted'};if(row.state!=='ready')return {ok:false,reason:'original_pending'};if(row.current_version!==input.expectedVersion)return {ok:false,reason:'stale_version'};if((await ctx.db.query("SELECT 1 FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND state='uploading'",[ctx.scope.workspaceId,id])).rows.length)return {ok:false,reason:'upload_pending'};version=Number((await ctx.db.query<{version:number}>('SELECT max(version)+1 AS version FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2',[ctx.scope.workspaceId,id])).rows[0]!.version);}
 if(used+input.bytes>1024**3)return {ok:false,reason:'library_full'};
 if(!id){id=randomUUID();await ctx.db.query('INSERT INTO social_assets(workspace_id,id,owner_user_id,origin) VALUES($1,$2,$3,$4::jsonb)',[ctx.scope.workspaceId,id,owner,JSON.stringify(input.origin)]);}
 const uploadId=randomUUID(),key=`${ctx.scope.workspaceId}/${id}/${version}/${uploadId}`;
 await ctx.db.query('INSERT INTO social_asset_objects(workspace_id,asset_id,version,upload_id,object_key,kind,sha256,bytes,mime,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[ctx.scope.workspaceId,id,version,uploadId,key,version===1?'original':'derivative',input.sha256,input.bytes,input.mime,input.width??null,input.height??null]);
 await ctx.db.query('UPDATE social_library_usage SET bytes_reserved=bytes_reserved+$2 WHERE workspace_id=$1',[ctx.scope.workspaceId,input.bytes]);
 await recordCrmAuditEvent(ctx,{action:'social.asset_registered',subjectKind:'social_asset',subjectId:id,detail:{version}});
 return {ok:true,value:{assetId:id,uploadId}};
}
/** verified is supplied only by the API's object-store HEAD/checksum check, never a request body. */
export async function completeSocialAsset(ctx:RepositoryContext,input:{assetId:string;uploadId:string;verified:{sha256:string;bytes:number;mime:string}}):Promise<Result<{version:number}>>{
 if(!user(ctx))return {ok:false,reason:'user_required'};await lock(ctx);
 const a=await asset(ctx,input.assetId);if(!a)return {ok:false,reason:'not_found'};if(a.state==='deleted')return {ok:false,reason:'asset_deleted'};
 const o=(await ctx.db.query<ObjectRow>('SELECT *,expires_at<=now() AS expired FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND upload_id=$3',[ctx.scope.workspaceId,input.assetId,input.uploadId])).rows[0];
 if(!o)return {ok:false,reason:'not_found'};if(o.state==='deleted'||o.state==='uploading'&&o.expired)return {ok:false,reason:'upload_expired'};
 if(o.sha256!==input.verified.sha256||o.bytes!==input.verified.bytes||o.mime!==input.verified.mime)return {ok:false,reason:'object_mismatch'};
 if(o.state==='ready')return {ok:true,value:{version:o.version}};
 await ctx.db.query("UPDATE social_asset_objects SET state='ready',completed_at=now() WHERE workspace_id=$1 AND asset_id=$2 AND upload_id=$3",[ctx.scope.workspaceId,input.assetId,input.uploadId]);
 await ctx.db.query("UPDATE social_assets SET state='ready',current_version=$3 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.assetId,o.version]);
 await recordCrmAuditEvent(ctx,{action:'social.asset_completed',subjectKind:'social_asset',subjectId:input.assetId,detail:{version:o.version}});
 return {ok:true,value:{version:o.version}};
}
export async function readSocialAsset(ctx:RepositoryContext,id:string):Promise<SocialAssetView|null>{const a=await asset(ctx,id);if(!a)return null;const objects=(await ctx.db.query<ObjectRow>('SELECT * FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 ORDER BY version',[ctx.scope.workspaceId,id])).rows.map(o=>({version:o.version,kind:o.kind,state:o.state,sha256:o.sha256,bytes:o.bytes,mime:o.mime,width:o.width,height:o.height}));return {id:a.id,state:a.state,version:a.current_version,origin:a.origin,objects};}
async function queueDeletion(ctx:RepositoryContext,id:string,version?:number){await ctx.db.query(`INSERT INTO social_object_deletions(workspace_id,asset_id,version,object_key,bytes,next_attempt_at) SELECT workspace_id,asset_id,version,object_key,bytes,now()+interval '10 minutes' FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND ($3::integer IS NULL OR version=$3) ON CONFLICT DO NOTHING`,[ctx.scope.workspaceId,id,version??null]);await ctx.db.query("UPDATE social_asset_objects SET state='deleted' WHERE workspace_id=$1 AND asset_id=$2 AND ($3::integer IS NULL OR version=$3)",[ctx.scope.workspaceId,id,version??null]);}
export async function deleteSocialAsset(ctx:RepositoryContext,id:string):Promise<Result<{deleted:true}>>{if(!user(ctx))return {ok:false,reason:'user_required'};await lock(ctx);const a=await asset(ctx,id);if(!a)return {ok:false,reason:'not_found'};await queueDeletion(ctx,id);await ctx.db.query("UPDATE social_assets SET state='deleted',deleted_at=COALESCE(deleted_at,now()) WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,id]);await recordCrmAuditEvent(ctx,{action:'social.asset_deleted',subjectKind:'social_asset',subjectId:id});return {ok:true,value:{deleted:true}};}
export async function expireSocialUploads(ctx:RepositoryContext):Promise<number>{await lock(ctx);const rows=(await ctx.db.query<{asset_id:string;version:number}>("SELECT asset_id,version FROM social_asset_objects WHERE workspace_id=$1 AND state='uploading' AND expires_at<=now() ORDER BY expires_at LIMIT 100",[ctx.scope.workspaceId])).rows;for(const r of rows){await queueDeletion(ctx,r.asset_id,r.version);if(r.version===1)await ctx.db.query("UPDATE social_assets SET state='deleted',deleted_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,r.asset_id]);}return rows.length;}
/** Key authorization is repeated for every URL, including command replays. */
export async function socialAssetObject(ctx:RepositoryContext,input:{assetId:string;uploadId?:string;version?:number},mode:'upload'|'download'):Promise<ObjectRow|null>{
 const a=await asset(ctx,input.assetId);if(!a||a.state==='deleted')return null;
 const o=(await ctx.db.query<ObjectRow>('SELECT *,expires_at<=now() AS expired FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND ($3::uuid IS NULL OR upload_id=$3) AND ($4::integer IS NULL OR version=$4)',[ctx.scope.workspaceId,input.assetId,input.uploadId??null,input.version??null])).rows;
 if(o.length!==1)return null;const row=o[0]!;
 return mode==='upload'?row.state==='uploading'&&!row.expired?row:null:row.state==='ready'?row:null;
}
export async function listSocialAssets(ctx:RepositoryContext,afterId?:string):Promise<SocialAssetView[]>{const ids=(await ctx.db.query<{id:string}>("SELECT id FROM social_assets WHERE workspace_id=$1 AND owner_user_id=$2 AND state<>'deleted' AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 50",[ctx.scope.workspaceId,user(ctx),afterId??null])).rows;const rows:SocialAssetView[]=[];for(const r of ids){const v=await readSocialAsset(ctx,r.id);if(v)rows.push(v);}return rows;}
/** The worker supplies the object key from this row; success alone releases storage quota. */
export async function recordSocialObjectDeletion(ctx:RepositoryContext,input:{assetId:string;version:number;success:boolean}):Promise<void>{await lock(ctx);const r=(await ctx.db.query<{bytes:number;attempts:number}>('SELECT bytes,attempts FROM social_object_deletions WHERE workspace_id=$1 AND asset_id=$2 AND version=$3 AND deleted_at IS NULL FOR UPDATE',[ctx.scope.workspaceId,input.assetId,input.version])).rows[0];if(!r)return;if(input.success){await ctx.db.query('UPDATE social_object_deletions SET deleted_at=now(),attempts=attempts+1 WHERE workspace_id=$1 AND asset_id=$2 AND version=$3',[ctx.scope.workspaceId,input.assetId,input.version]);await ctx.db.query('UPDATE social_library_usage SET bytes_reserved=bytes_reserved-$2 WHERE workspace_id=$1',[ctx.scope.workspaceId,r.bytes]);}else await ctx.db.query("UPDATE social_object_deletions SET attempts=attempts+1,next_attempt_at=now()+($4::integer*interval '1 minute') WHERE workspace_id=$1 AND asset_id=$2 AND version=$3",[ctx.scope.workspaceId,input.assetId,input.version,Math.min(1440,2**Math.min(11,r.attempts+1))]);}
