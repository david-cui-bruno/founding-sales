import {createHash} from 'node:crypto';
import {SOCIAL_PUBLISHER_ADAPTER,socialPublisherConnectionInputSchema,socialPublisherBindingSchema,type SocialPublisherBinding,type SocialPublisherAttempt,type SocialPublisherObservation,type SocialPublisherPort,type SocialPublisherPrepared,type SocialPublisherConnectionInput,type SocialPublisherConnectionResult,type SocialPublisherChannel} from '@fss/contracts';
import type {PublisherOwner,PublisherCredentialStore,PublisherExecutionSide} from './publisherCredentials.ts';
import {BufferGraphQL,PublisherRefusal,CHANNEL_FIELDS,POST_FIELDS,requireChannel,type BufferChannel,type BufferPost,type PublisherTransport} from './publisherBuffer.ts';
import {publisherMediaURL} from './publisherMedia.ts';
export interface PublisherConnectionOwner extends PublisherOwner {sessionId:string;deviceId:string}
export interface SocialBufferRuntimeOptions {credentials:PublisherCredentialStore;executionSide:PublisherExecutionSide;mediaOrigin:string}
const hash=(text:string)=>createHash('sha256').update(text.replace(/\r\n/gu,'\n').trim()).digest('hex');
function linkedinURL(value:string|null):string|null {if(!value)return null;try{const url=new URL(value);return url.protocol==='https:'&&['linkedin.com','www.linkedin.com'].includes(url.hostname)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
/** All vendor I/O is server-side; fixture transport is explicit, never environment-selected. */
export class SocialBufferPublisher implements SocialPublisherPort {
 private readonly client:BufferGraphQL;
 private readonly activeAttempts=new Set<string>();
 private closed=false;
 constructor(private readonly options:SocialBufferRuntimeOptions,fixture?:{transport:PublisherTransport}){this.client=new BufferGraphQL(fixture?.transport);}
 async start():Promise<void>{await this.heartbeat();}
 async heartbeat():Promise<void>{if(this.closed)throw new PublisherRefusal('runtime_closed');await this.options.credentials.heartbeat(this.options.executionSide);}
 async close():Promise<void>{this.closed=true;}
 private async channels(apiKey:string,authority:()=>Promise<void>):Promise<BufferChannel[]>{
  if(this.closed)throw new PublisherRefusal('runtime_closed');
  const account=await this.client.request<{account:{organizations:{id:string}[]}}>(apiKey,'query PublisherOrganizations { account { organizations { id } } }');await authority();
  if(!Array.isArray(account.account?.organizations)||account.account.organizations.length>20)throw new PublisherRefusal('discovery_limit');
  const channels:BufferChannel[]=[];
  for(const organization of account.account.organizations){
   if(!/^[a-fA-F0-9]{24}$/u.test(organization.id))throw new PublisherRefusal('remote_unavailable');
   const result=await this.client.request<{channels:BufferChannel[]}>(apiKey,`query PublisherChannels($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { ${CHANNEL_FIELDS} } }`,{organizationId:organization.id});await authority();
   if(!Array.isArray(result.channels)||result.channels.length>100||channels.length+result.channels.length>100)throw new PublisherRefusal('discovery_limit');
   for(const channel of result.channels){if(channel.organizationId!==organization.id)throw new PublisherRefusal('account_mismatch');channels.push(channel);}
  }
  return channels;
 }
 async connection(owner:PublisherConnectionOwner,raw:SocialPublisherConnectionInput,authority:()=>Promise<void>):Promise<SocialPublisherConnectionResult>{
  const input=socialPublisherConnectionInputSchema.parse(raw);await authority();
  if(input.operation==='disconnect'){await this.options.credentials.disconnect(owner,input.accountId,authority);await authority();return {state:'closed'};}
  const channels=await this.channels(input.apiKey,authority);
  if(input.operation==='discover'){
   const available:SocialPublisherChannel[]=[];
   for(const channel of channels){try{requireChannel(channel);}catch{continue;}available.push({organizationId:channel.organizationId,channelId:channel.id,externalId:channel.serviceId,displayName:(channel.displayName??channel.name).slice(0,200),profileUrl:linkedinURL(channel.externalLink)});}
   await authority();return {state:'channels',channels:available};
  }
  const channel=channels.find(value=>value.id===input.channelId&&value.organizationId===input.organizationId);if(!channel)throw new PublisherRefusal('channel_unavailable');requireChannel(channel);await authority();
  const displayName=(channel.displayName??channel.name).slice(0,200);
  const binding=await this.options.credentials.save(owner,input.accountId,{organizationId:channel.organizationId,channelId:channel.id,externalId:channel.serviceId,displayName},input.apiKey,authority);await authority();
  return {state:'connected',accountId:binding.accountId,revision:binding.accountRevision,externalId:binding.externalId,displayName};
 }
 private async operation<T>(binding:SocialPublisherBinding,authority:()=>Promise<void>,action:(apiKey:string,current:()=>Promise<void>)=>Promise<T>,allowPaused=false):Promise<T>{
  if(this.closed||!socialPublisherBindingSchema.safeParse(binding).success)throw new PublisherRefusal('credential_unavailable');await authority();
  const apiKey=await this.options.credentials.read(binding);if(!apiKey)throw new PublisherRefusal('credential_unavailable');
  const current=async()=>{await authority();if(await this.options.credentials.read(binding)!==apiKey)throw new PublisherRefusal('credential_unavailable');};
   const channels=await this.channels(apiKey,current),channel=channels.find(value=>value.id===binding.channelId&&value.organizationId===binding.organizationId);
   if(!channel||channel.serviceId!==binding.externalId)throw new PublisherRefusal('account_mismatch');requireChannel(channel,allowPaused);await current();return await action(apiKey,current);
 }
 async verify(binding:SocialPublisherBinding):Promise<{usable:boolean;externalId:string|null;adapter:typeof SOCIAL_PUBLISHER_ADAPTER;reason:null|'credential_revoked'|'unavailable'}>{
  try{return await this.operation(binding,async()=>{},async(_key,current)=>{await current();return {usable:true,externalId:binding.externalId,adapter:SOCIAL_PUBLISHER_ADAPTER,reason:null};});}
  catch(error){return {usable:false,externalId:null,adapter:SOCIAL_PUBLISHER_ADAPTER,reason:error instanceof PublisherRefusal&&error.reason==='credential_revoked'?'credential_revoked':'unavailable'};}
 }
 private validate(attempt:SocialPublisherAttempt,write=false):void {
  if(!/^[a-f0-9-]{36}$/iu.test(attempt.attemptId)||!/^[a-f0-9]{64}$/u.test(attempt.fingerprint)||!Number.isFinite(Date.parse(attempt.publishAt)))throw new PublisherRefusal('attempt_invalid');
  if(attempt.text===null?write||!attempt.textSHA256||!/^[a-f0-9]{64}$/u.test(attempt.textSHA256):!attempt.text.trim()||attempt.text.length>3000||Boolean(attempt.textSHA256&&hash(attempt.text)!==attempt.textSHA256))throw new PublisherRefusal('attempt_invalid');
  const image=attempt.image;if(image&&(!/^[a-f0-9]{64}$/u.test(image.sha256)||!['image/jpeg','image/png'].includes(image.mime)||!Number.isInteger(image.byteLength)||image.byteLength<=0||image.byteLength>5*1024*1024||write&&(!image.altText.trim()||image.altText.length>1000)))throw new PublisherRefusal('image_invalid');
 }
 private schedule(attempt:SocialPublisherAttempt):void {const at=Date.parse(attempt.publishAt);if(at<=Date.now()+300000||at>Date.now()+30*86400000)throw new PublisherRefusal('schedule_window_invalid');}
 async prepare(attempt:SocialPublisherAttempt,authority:()=>Promise<void>):Promise<SocialPublisherPrepared>{this.validate(attempt,true);this.schedule(attempt);await this.operation(attempt.binding,authority,async(_key,current)=>{await current();});return {attemptId:attempt.attemptId,fingerprint:attempt.fingerprint,expiresAt:new Date(Math.min(Date.parse(attempt.publishAt)-300000,Date.now()+60000)).toISOString()};}
 private observation(attempt:SocialPublisherAttempt,reason:SocialPublisherObservation['reason']='readback_incomplete'):SocialPublisherObservation{return {state:'unknown',receiptId:null,mediaReceiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:null,fingerprint:attempt.fingerprint,imageCount:attempt.image?1:0,mediaMatched:false,reason};}
 private match(attempt:SocialPublisherAttempt,post:BufferPost,knownCreate=false,draft=false):SocialPublisherObservation|null {
  if(!post||!/^[a-fA-F0-9]{24}$/u.test(post.id)||post.channelId!==attempt.binding.channelId||post.channel?.organizationId!==attempt.binding.organizationId||post.channel.serviceId!==attempt.binding.externalId||post.channel.service!=='linkedin'||post.channel.type!=='profile'||typeof post.text!=='string'||hash(post.text)!==(attempt.textSHA256??(attempt.text===null?'':hash(attempt.text))))return null;
  if(!draft&&(Date.parse(post.dueAt??'')!==Date.parse(attempt.publishAt)||post.schedulingType!=='automatic'||post.isCustomScheduled!==true))return null;
  if(!Array.isArray(post.assets))return null;
  let mediaReceiptId:string|null=null;
  if(attempt.image){
   const asset=post.assets[0];if(post.assets.length!==1||asset?.__typename!=='ImageAsset'||asset.mimeType!==attempt.image.mime||!asset.id||asset.id.length>300)return null;
   const expected=publisherMediaURL(this.options.mediaOrigin,{workspaceId:attempt.binding.workspaceId,attemptId:attempt.attemptId,sha256:attempt.image.sha256});
   if(!knownCreate&&(attempt.mediaReceiptId?asset.id!==attempt.mediaReceiptId:asset.source!==expected))return null;
   mediaReceiptId=asset.id;
  }else if(post.assets.length)return null;
  const state=post.status==='scheduled'?'scheduled':post.status==='sent'?'published':post.status==='draft'?'cancelled':'unknown';
  return {...this.observation(attempt,state==='unknown'?'readback_incomplete':'matched'),state,receiptId:post.id,mediaReceiptId,accountExternalId:attempt.binding.externalId,imageCount:post.assets.length,mediaMatched:true,permalink:state==='published'?linkedinURL(post.externalLink):null};
 }
 async submit(attempt:SocialPublisherAttempt,authority:()=>Promise<void>,durableMarker:()=>Promise<boolean>):Promise<SocialPublisherObservation>{
  this.validate(attempt,true);if(this.activeAttempts.has(attempt.attemptId)||attempt.submittedAt!==null)return this.observation(attempt);
  this.activeAttempts.add(attempt.attemptId);
  try{return await this.operation(attempt.binding,authority,async(apiKey,current)=>{
   this.schedule(attempt);await current();try{if(!await durableMarker())return this.observation(attempt);}catch{return this.observation(attempt);}
   try{
    await current();
    const assets=attempt.image?[{image:{url:publisherMediaURL(this.options.mediaOrigin,{workspaceId:attempt.binding.workspaceId,attemptId:attempt.attemptId,sha256:attempt.image.sha256}),metadata:{altText:attempt.image.altText}}}]:[];
    const result=await this.client.request<{createPost:{__typename:string;post?:BufferPost}}>(apiKey,`mutation PublisherCreate($input:CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`,{input:{channelId:attempt.binding.channelId,text:attempt.text,schedulingType:'automatic',mode:'customScheduled',dueAt:attempt.publishAt,assets}});await current();
    if(['InvalidInputError','UnauthorizedError','LimitReachedError','NotFoundError'].includes(result.createPost?.__typename))return {...this.observation(attempt,'provider_rejected'),state:'rejected',accountExternalId:attempt.binding.externalId};
    if(result.createPost?.__typename!=='PostActionSuccess'||!result.createPost.post)return this.observation(attempt);
    return this.match(attempt,result.createPost.post,true)??this.observation(attempt);
   }catch(error){if(error instanceof PublisherRefusal&&error.reason==='credential_revoked')return {...this.observation(attempt,'credential_revoked'),state:'rejected',accountExternalId:attempt.binding.externalId};return this.observation(attempt,'remote_unavailable');}
  });}catch(error){if(error instanceof PublisherRefusal&&error.reason==='credential_revoked')return {...this.observation(attempt,'credential_revoked'),state:'rejected',accountExternalId:attempt.binding.externalId};throw error;}finally{this.activeAttempts.delete(attempt.attemptId);}
 }
 private async read(apiKey:string,id:string):Promise<BufferPost|null>{const result=await this.client.request<{post:BufferPost|null}>(apiKey,`query PublisherPost($id:PostId!) { post(input:{id:$id}) { ${POST_FIELDS} } }`,{id});return result.post;}
 async inspect(attempt:SocialPublisherAttempt,receiptId:string|null,authority:()=>Promise<void>):Promise<SocialPublisherObservation>{
  this.validate(attempt);
  try{return await this.operation(attempt.binding,authority,async(apiKey,current)=>{
   if(receiptId!==null){if(!/^[a-fA-F0-9]{24}$/u.test(receiptId))return this.observation(attempt);const post=await this.read(apiKey,receiptId);await current();return post&&post.id===receiptId?this.match(attempt,post,false,post.status==='draft')??this.observation(attempt):this.observation(attempt);}
   const submitted=Date.parse(attempt.submittedAt??'');if(!Number.isFinite(submitted))return this.observation(attempt);
   let after:string|null=null;const seen=new Set<string>(),matches:SocialPublisherObservation[]=[];
   for(let page=0;page<10;page++){
    const result: {posts:{edges:{node:BufferPost}[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}}=await this.client.request(apiKey,`query PublisherReconcile($input:PostsInput!,$after:String) { posts(input:$input,first:100,after:$after) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,{input:{organizationId:attempt.binding.organizationId,filter:{channelIds:[attempt.binding.channelId],createdAt:{start:new Date(submitted-60000).toISOString(),end:new Date(submitted+16*60000).toISOString()}}},after});await current();
    if(!Array.isArray(result.posts?.edges)||result.posts.edges.length>100||typeof result.posts.pageInfo?.hasNextPage!=='boolean')return this.observation(attempt);
    for(const edge of result.posts.edges){const post=edge.node;if(seen.has(post.id))return this.observation(attempt);seen.add(post.id);const created=Date.parse(post.createdAt);if(created<submitted-60000||created>submitted+16*60000||!Number.isFinite(created))continue;const match=this.match(attempt,post);if(match)matches.push(match);}
    if(!result.posts.pageInfo.hasNextPage)return matches.length===1?matches[0]!:this.observation(attempt);
    const cursor=result.posts.pageInfo.endCursor;if(!cursor||cursor===after||cursor.length>2048)return this.observation(attempt);after=cursor;
   }
   return this.observation(attempt);
  },true);}catch(error){return this.observation(attempt,error instanceof PublisherRefusal&&['credential_revoked','credential_unavailable','account_mismatch','queue_paused','channel_unavailable'].includes(error.reason)?error.reason as SocialPublisherObservation['reason']:'remote_unavailable');}
 }
 async cancel(attempt:SocialPublisherAttempt,receiptId:string,authority:()=>Promise<void>):Promise<SocialPublisherObservation>{
  this.validate(attempt);if(!/^[a-fA-F0-9]{24}$/u.test(receiptId))return this.observation(attempt,'cancel_race');
  try{return await this.operation(attempt.binding,authority,async(apiKey,current)=>{
   const post=await this.read(apiKey,receiptId);await current();if(!post||post.id!==receiptId)return this.observation(attempt,'cancel_race');
   const observed=this.match(attempt,post,false,post.status==='draft');if(!observed)return this.observation(attempt,'cancel_race');
   if(post.status==='draft')return observed;
   if(post.status!=='scheduled'||!post.allowedActions.includes('movePostToDraft'))return {...observed,reason:'cancel_race'};
   await current();const result=await this.client.request<{editPost:{__typename:string;post?:BufferPost}}>(apiKey,`mutation PublisherCancel($input:EditPostInput!) { editPost(input:$input) { __typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`,{input:{id:receiptId,saveToDraft:true}});await current();
   const changed=result.editPost?.post;if(result.editPost?.__typename!=='PostActionSuccess'||!changed||changed.id!==receiptId)return this.observation(attempt,'cancel_race');
   const resultObservation=this.match(attempt,changed,false,changed.status==='draft');
   return resultObservation?{...resultObservation,reason:changed.status==='draft'?'matched':'cancel_race'}:this.observation(attempt,'cancel_race');
  },true);}catch(error){return this.observation(attempt,error instanceof PublisherRefusal&&error.reason==='credential_revoked'?'credential_revoked':'cancel_race');}
 }
}
