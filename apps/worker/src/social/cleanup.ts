import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {expireSocialUploads,recordSocialObjectDeletion} from '@fss/domain/social/assets.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export interface SocialDeletionPort{delete(key:string):Promise<void>}
export async function sweepSocialAssets(ctx:RepositoryContext,port:SocialDeletionPort|null):Promise<void>{
 await expireSocialUploads(ctx);if(!port)return;
 const rows=(await ctx.db.query<{asset_id:string;version:number;object_key:string}>('SELECT asset_id,version,object_key FROM social_object_deletions WHERE workspace_id=$1 AND deleted_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10 FOR UPDATE',[ctx.scope.workspaceId])).rows;
 for(const row of rows){let success=false;try{await port.delete(row.object_key);success=true;}catch{/* Durable retry, without object paths or provider bodies in logs. */}await recordSocialObjectDeletion(ctx,{assetId:row.asset_id,version:row.version,success});}
}
export function socialAssetsHandler(port:SocialDeletionPort|null):JobHandler{return {kind:'social.assets_cleanup',protection:'business_uniqueness',maxAttempts:4,leaseSeconds:90,handle:async input=>sweepSocialAssets(repositoryContext(input.scope,input.session),port)};}
export function socialAssetsSource():DueWorkSource{return {name:'social-assets-cleanup',find:async(session,now)=>{
 const rows=(await session.query<{workspace_id:string}>("SELECT DISTINCT workspace_id FROM social_asset_objects WHERE state='uploading' AND expires_at<=$1 UNION SELECT DISTINCT workspace_id FROM social_object_deletions WHERE deleted_at IS NULL AND next_attempt_at<=$1",[now])).rows;
 return rows.map(r=>({workspaceId:r.workspace_id,kind:'social.assets_cleanup' as const,idempotencyKey:`social-assets:${Math.floor(Date.parse(now)/300_000)}`,payload:{},maxAttempts:4}));
}};}
export async function socialDeletionPort(environment:NodeJS.ProcessEnv):Promise<SocialDeletionPort|null>{const bucket=environment['FSS_SOCIAL_ASSETS_BUCKET'],region=environment['AWS_REGION'];if(!bucket||!region)return null;const sdkName='@aws-sdk/client-s3';const sdk=await import(sdkName) as {S3Client:new(o:Record<string,unknown>)=>{send(c:unknown,o:{abortSignal:AbortSignal}):Promise<unknown>};DeleteObjectCommand:new(o:Record<string,unknown>)=>unknown};const client=new sdk.S3Client({region,maxAttempts:2});return {delete:async key=>{await client.send(new sdk.DeleteObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(5000)});}};}
