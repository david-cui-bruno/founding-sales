import {createHash} from 'node:crypto';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readStandingPublicationMedia} from '@fss/domain/social/standingPublication.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';

export const SOCIAL_PUBLISHER_MEDIA_PREFIX='/social/publisher/media';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const mediaPath=new RegExp(`^${SOCIAL_PUBLISHER_MEDIA_PREFIX}/(${uuid})/(${uuid})/([0-9a-f]{64})$`,'u');
const unavailable=():RouteResult=>({status:404,body:{error:'not_found'}});

/** An admitted posting image is public, not a private-library download capability.
 * Every fetch still checks its exact current publication/source/media authority. */
export async function routeSocialPublisherMedia(request:ApiRequest,options:RoutingOptions):Promise<RouteResult>{
 if(request.method!=='GET'&&request.method!=='HEAD')return {status:405,body:{error:'method_not_allowed'}};
 const match=mediaPath.exec(request.path),store=options.socialMedia;
 if(!match||request.query.size!==0||!options.socialPublisher||!store)return unavailable();
 const workspaceId=match[1]!,attemptId=match[2]!,sha256=match[3]!;
 return withTransaction(options.session,async()=>{
  const media=await readStandingPublicationMedia(options.session,workspaceId,attemptId,sha256);
  if(!media)return unavailable();
  if(request.method==='HEAD')return {status:200,body:Buffer.alloc(0),contentType:media.mimeType,contentLength:media.byteLength};
  const bytes=await store.read(media.objectKey,media.byteLength);
  if(bytes.byteLength!==media.byteLength||createHash('sha256').update(bytes).digest('hex')!==media.sha256)throw new Error('publisher_media_integrity_failed');
  // S3 is an external wait. Expiry, source withdrawal and owner/plan/media changes
  // must be checked again; an old snapshot is recovery evidence, not public access.
  const current=await readStandingPublicationMedia(options.session,workspaceId,attemptId,sha256);
  if(!current||current.objectKey!==media.objectKey||current.ownerUserId!==media.ownerUserId||current.mimeType!==media.mimeType||current.byteLength!==media.byteLength)return unavailable();
  return {status:200,body:bytes,contentType:media.mimeType};
 });
}
