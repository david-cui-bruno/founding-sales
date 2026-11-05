import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SOCIAL_PUBLISHER_ADAPTER,type SocialPublisherAttempt,type SocialPublisherBinding} from '@fss/contracts';
import {SocialBufferPublisher} from '../src/publisherRuntime.ts';
import {BufferGraphQL,type BufferPost,type BufferChannel,type PublisherTransport} from '../src/publisherBuffer.ts';
import {sealPublisherCredential,openPublisherCredential,type PublisherCredentialStore} from '../src/publisherCredentials.ts';
import {publisherProductionConfiguration} from '../src/publisherConfig.ts';
import {publisherMediaURL} from '../src/publisherMedia.ts';
const id='10000000-0000-4000-8000-000000000001',channelId='b'.repeat(24),organizationId='a'.repeat(24),receiptId='c'.repeat(24),apiKey='fixture-private-api-key';
const binding:SocialPublisherBinding={adapter:SOCIAL_PUBLISHER_ADAPTER,workspaceId:id,ownerUserId:id,accountId:id,accountRevision:1,credentialId:id,credentialRevision:1,organizationId,channelId,externalId:'native-linkedin-id'};
const image={mime:'image/png' as const,sha256:'d'.repeat(64),altText:'Approved image',byteLength:100};
let attempt:SocialPublisherAttempt,channel:BufferChannel,post:BufferPost,publisher:SocialBufferPublisher,store:PublisherCredentialStore;
let calls:{query:string;variables:Record<string,unknown>;authorization:string|undefined}[];
let respond:(query:string,variables:Record<string,unknown>,res:ServerResponse)=>void;
let origin:string,transport:PublisherTransport;
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);calls.push({...input,authorization:req.headers.authorization});respond(input.query,input.variables,res);});
const authority=async()=>{};
function json(res:ServerResponse,data:unknown):void{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data}));}
beforeEach(async()=>{
 attempt={binding,attemptId:id,fingerprint:'e'.repeat(64),text:'Exact approved text',textSHA256:createHash('sha256').update('Exact approved text').digest('hex'),publishAt:new Date(Date.now()+3600000).toISOString(),submittedAt:null,mediaReceiptId:null,image:null};
 channel={id:channelId,organizationId,service:'linkedin',type:'profile',serviceId:binding.externalId,name:'Owner',displayName:'Owner',externalLink:'https://www.linkedin.com/in/owner',isDisconnected:false,isLocked:false,isQueuePaused:false,allowedActions:['readUpdates','scheduleUpdates','manageUpdates']};
 post={id:receiptId,channelId,channel:{organizationId,serviceId:binding.externalId,service:'linkedin',type:'profile'},text:attempt.text!,dueAt:attempt.publishAt,createdAt:new Date().toISOString(),status:'scheduled',schedulingType:'automatic',isCustomScheduled:true,externalLink:null,allowedActions:['movePostToDraft'],assets:[]};
 calls=[];respond=(query,_variables,res)=>{if(query.includes('PublisherOrganizations'))json(res,{account:{organizations:[{id:organizationId}]}});else if(query.includes('PublisherChannels'))json(res,{channels:[channel]});else if(query.includes('PublisherCreate'))json(res,{createPost:{__typename:'PostActionSuccess',post}});else if(query.includes('PublisherCancel'))json(res,{editPost:{__typename:'PostActionSuccess',post:{...post,status:'draft',dueAt:null}}});else if(query.includes('PublisherReconcile'))json(res,{posts:{edges:[{node:post}],pageInfo:{hasNextPage:false,endCursor:null}}});else json(res,{post});};
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_address');origin=`http://127.0.0.1:${address.port}`;
 transport=async(url,init)=>{expect(url).toBe('https://api.buffer.com');expect(init.redirect).toBe('error');return fetch(origin,init);};
 store={read:vi.fn(async()=>apiKey),save:vi.fn(async()=>binding),disconnect:vi.fn(async()=>{}),heartbeat:vi.fn(async()=>{})};
 publisher=new SocialBufferPublisher({credentials:store,executionSide:'api',mediaOrigin:'https://app.example'},{transport});
});
afterEach(async()=>{await publisher.close();server.closeAllConnections();const closed=Promise.withResolvers<void>();server.close(error=>error?closed.reject(error):closed.resolve());await closed.promise;});
it('discovers only usable personal profiles and never exposes the API key',async()=>{
 const result=await publisher.connection({...binding,sessionId:id,deviceId:id},{operation:'discover',apiKey},authority);
 expect(result).toEqual({state:'channels',channels:[{organizationId,channelId,externalId:binding.externalId,displayName:'Owner',profileUrl:channel.externalLink}]});
 expect(JSON.stringify(result)).not.toContain(apiKey);expect(calls.every(call=>call.authorization===`Bearer ${apiKey}`)).toBe(true);
});
it.each(['isLocked','isDisconnected','isQueuePaused'] as const)('refuses %s channels without a mutation',async flag=>{channel[flag]=true;expect(await publisher.verify(binding)).toMatchObject({usable:false,reason:'unavailable'});expect(calls.some(call=>call.query.includes('mutation'))).toBe(false);});
it('verifies the bound personal profile with an explicit null failure reason',async()=>{expect(await publisher.verify(binding)).toEqual({usable:true,externalId:binding.externalId,adapter:SOCIAL_PUBLISHER_ADAPTER,reason:null});expect(store.save).not.toHaveBeenCalled();expect(store.disconnect).not.toHaveBeenCalled();});
it.each(['page','business','account'])('excludes nonpersonal %s channels',async type=>{channel.type=type;expect(await publisher.connection({...binding,sessionId:id,deviceId:id},{operation:'discover',apiKey},authority)).toEqual({state:'channels',channels:[]});});
it('rereads authoritative identity on connect and fences after vendor waits',async()=>{
 await publisher.connection({...binding,sessionId:id,deviceId:id},{operation:'connect',accountId:id,apiKey,organizationId,channelId},authority);
 expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ownerUserId:id}),id,{organizationId,channelId,externalId:binding.externalId,displayName:'Owner'},apiKey,authority);
 const denied=vi.fn(async()=>{throw new Error('principal_changed');});await expect(publisher.connection({...binding,sessionId:id,deviceId:id},{operation:'connect',accountId:id,apiKey,organizationId,channelId},denied)).rejects.toThrow('principal_changed');
 expect(store.save).toHaveBeenCalledTimes(1);
});
it('rejects wrong identity and missing permissions before create',async()=>{channel.serviceId='foreign';await expect(publisher.prepare(attempt,authority)).rejects.toThrow('account_mismatch');channel.serviceId=binding.externalId;channel.allowedActions=['readUpdates'];await expect(publisher.prepare(attempt,authority)).rejects.toThrow('channel_permission_denied');expect(calls.some(call=>call.query.includes('mutation'))).toBe(false);});
it('prepares read-only and commits marker before the first create',async()=>{
 await publisher.prepare(attempt,authority);expect(calls.some(call=>call.query.includes('mutation'))).toBe(false);
 let marked=false;const previous=respond;respond=(query,variables,res)=>{if(query.includes('PublisherCreate'))expect(marked).toBe(true);previous(query,variables,res);};
 const result=await publisher.submit(attempt,authority,async()=>{marked=true;return true;});expect(result).toMatchObject({state:'scheduled',receiptId,mediaMatched:true});
 const create=calls.find(call=>call.query.includes('PublisherCreate'));expect(create?.variables).toEqual({input:{channelId,text:attempt.text,schedulingType:'automatic',mode:'customScheduled',dueAt:attempt.publishAt,assets:[]}});
});
it('never creates when marker fails or has already been committed',async()=>{expect((await publisher.submit(attempt,authority,async()=>false)).state).toBe('unknown');expect((await publisher.submit({...attempt,submittedAt:new Date().toISOString()},authority,async()=>true)).state).toBe('unknown');expect(calls.some(call=>call.query.includes('PublisherCreate'))).toBe(false);});
it('does not repeat an in-flight create and holds dropped create outcomes',async()=>{
 const gate=Promise.withResolvers<void>();const marker=vi.fn(async()=>{await gate.promise;return true;});const first=publisher.submit(attempt,authority,marker);expect((await publisher.submit(attempt,authority,marker)).state).toBe('unknown');
 const previous=respond;respond=(query,variables,res)=>{if(query.includes('PublisherCreate'))res.destroy();else previous(query,variables,res);};gate.resolve();expect((await first).state).toBe('unknown');expect(calls.filter(call=>call.query.includes('PublisherCreate'))).toHaveLength(1);
});
it.each(['InvalidInputError','UnauthorizedError','LimitReachedError'])('classifies proven %s rejection without retry',async __typename=>{const previous=respond;respond=(query,variables,res)=>query.includes('PublisherCreate')?json(res,{createPost:{__typename,message:apiKey}}):previous(query,variables,res);const result=await publisher.submit(attempt,authority,async()=>true);expect(result).toMatchObject({state:'rejected',reason:'provider_rejected',accountExternalId:binding.externalId});expect(JSON.stringify(result)).not.toContain(apiKey);expect(calls.filter(call=>call.query.includes('PublisherCreate'))).toHaveLength(1);});
it('holds generic mutation failures and top-level GraphQL errors',async()=>{const previous=respond;respond=(query,variables,res)=>query.includes('PublisherCreate')?json(res,{createPost:{__typename:'UnexpectedError',message:apiKey}}):previous(query,variables,res);expect((await publisher.submit(attempt,authority,async()=>true)).state).toBe('unknown');respond=(_query,_variables,res)=>res.end(JSON.stringify({errors:[{message:apiKey}]}));expect(await publisher.verify(binding)).toMatchObject({usable:false});});
it('binds create image identity and requires the retained asset ID on later reads',async()=>{
 attempt.image=image;post.assets=[{__typename:'ImageAsset',id:'accepted-image',source:'https://media.buffer.com/rewritten',mimeType:image.mime,image:{altText:image.altText}}];
 const result=await publisher.submit(attempt,authority,async()=>true);expect(result).toMatchObject({state:'scheduled',mediaReceiptId:'accepted-image',mediaMatched:true});
 expect(JSON.stringify(calls.find(call=>call.query.includes('PublisherCreate'))?.variables)).toContain(publisherMediaURL('https://app.example',{workspaceId:id,attemptId:id,sha256:image.sha256}));
 attempt.mediaReceiptId=result.mediaReceiptId;attempt.text=null;expect((await publisher.inspect(attempt,receiptId,authority)).state).toBe('scheduled');post.assets[0]!.id='foreign-image';expect((await publisher.inspect(attempt,receiptId,authority)).state).toBe('unknown');
});
it('lost-create image matching requires the exact public source, not count or alt text',async()=>{
 attempt={...attempt,image,submittedAt:new Date().toISOString(),text:null};post.assets=[{__typename:'ImageAsset',id:'provider-image',source:'https://media.buffer.com/rewritten',mimeType:image.mime,image:{altText:image.altText}}];expect((await publisher.inspect(attempt,null,authority)).state).toBe('unknown');
 post.assets[0]!.source=publisherMediaURL('https://app.example',{workspaceId:id,attemptId:id,sha256:image.sha256});expect((await publisher.inspect(attempt,null,authority)).state).toBe('scheduled');
});
it('reconciles one exact candidate only within the persisted creation window',async()=>{
 attempt.submittedAt=new Date().toISOString();expect((await publisher.inspect(attempt,null,authority)).state).toBe('scheduled');const list=calls.find(call=>call.query.includes('PublisherReconcile'));expect(list?.variables).toMatchObject({input:{organizationId,filter:{channelIds:[channelId],createdAt:{start:expect.any(String),end:expect.any(String)}}}});
 post.createdAt=new Date(Date.now()-3600000).toISOString();expect((await publisher.inspect(attempt,null,authority)).state).toBe('unknown');
});
it('holds empty, ambiguous and incomplete reconciliation instead of recreating',async()=>{
 attempt.submittedAt=new Date().toISOString();const previous=respond;
 for(const mode of ['empty','ambiguous','incomplete']){respond=(query,variables,res)=>query.includes('PublisherReconcile')?json(res,{posts:{edges:mode==='empty'?[]:[{node:post},...(mode==='ambiguous'?[{node:{...post,id:'f'.repeat(24)}}]:[])],pageInfo:{hasNextPage:mode==='incomplete',endCursor:null}}}):previous(query,variables,res);expect((await publisher.inspect(attempt,null,authority)).state).toBe('unknown');}
 expect(calls.some(call=>call.query.includes('PublisherCreate'))).toBe(false);
});
it('moves only the exact scheduled owned post to draft and establishes returned draft state',async()=>{expect(await publisher.cancel(attempt,receiptId,authority)).toMatchObject({state:'cancelled',receiptId});expect(calls.find(call=>call.query.includes('PublisherCancel'))?.variables).toEqual({input:{id:receiptId,saveToDraft:true}});});
it.each(['sending','sent'])('does not edit a %s post during cancellation race',async status=>{post.status=status;const result=await publisher.cancel(attempt,receiptId,authority);expect(result.reason).toBe('cancel_race');expect(result.state).toBe(status==='sent'?'published':'unknown');expect(calls.some(call=>call.query.includes('PublisherCancel'))).toBe(false);});
it('never claims cancellation from acknowledgement without a verified draft',async()=>{const previous=respond;respond=(query,variables,res)=>query.includes('PublisherCancel')?json(res,{editPost:{__typename:'PostActionSuccess',post}}):previous(query,variables,res);expect((await publisher.cancel(attempt,receiptId,authority)).state).toBe('scheduled');post.channel.serviceId='foreign';expect((await publisher.cancel(attempt,receiptId,authority)).state).toBe('unknown');});
it('surfaces invalid-key evidence without writing through another DB lease',async()=>{respond=(_query,_variables,res)=>{res.statusCode=401;res.end();};expect(await publisher.verify(binding)).toEqual({usable:false,externalId:null,adapter:SOCIAL_PUBLISHER_ADAPTER,reason:'credential_revoked'});await expect(publisher.prepare(attempt,authority)).rejects.toThrow('credential_revoked');expect(await publisher.inspect(attempt,receiptId,authority)).toMatchObject({state:'unknown',reason:'credential_revoked'});expect(await publisher.cancel(attempt,receiptId,authority)).toMatchObject({state:'unknown',reason:'credential_revoked'});expect(store.save).not.toHaveBeenCalled();expect(store.disconnect).not.toHaveBeenCalled();});
it('reports create 401 as a proven no-create rejection with verified account identity and no credential mutation',async()=>{const previous=respond;respond=(query,variables,res)=>{if(query.includes('PublisherCreate')){res.statusCode=401;res.end();}else previous(query,variables,res);};expect(await publisher.submit(attempt,authority,async()=>true)).toMatchObject({state:'rejected',reason:'credential_revoked',accountExternalId:binding.externalId});expect(calls.filter(call=>call.query.includes('PublisherCreate'))).toHaveLength(1);expect(store.save).not.toHaveBeenCalled();expect(store.disconnect).not.toHaveBeenCalled();});
it('inspects and cancels an owned post while its queue is paused without resuming it',async()=>{channel.isQueuePaused=true;expect((await publisher.inspect(attempt,receiptId,authority)).state).toBe('scheduled');expect((await publisher.cancel(attempt,receiptId,authority)).state).toBe('cancelled');expect(calls.filter(call=>call.query.includes('mutation'))).toHaveLength(1);});
it('does not create after local credential revocation across a vendor wait',async()=>{const previous=respond;respond=(query,variables,res)=>{if(query.includes('PublisherChannels'))store.read=vi.fn(async()=>null);previous(query,variables,res);};await expect(publisher.submit(attempt,authority,async()=>true)).rejects.toThrow('credential_unavailable');expect(calls.some(call=>call.query.includes('PublisherCreate'))).toBe(false);});
it('disconnects only the requested retained owner account',async()=>{expect(await publisher.connection({...binding,sessionId:id,deviceId:id},{operation:'disconnect',accountId:id},authority)).toEqual({state:'closed'});expect(store.disconnect).toHaveBeenCalledWith(expect.objectContaining({workspaceId:id,ownerUserId:id}),id,authority);expect(calls).toHaveLength(0);});
it('does not leak authorization through redirects, raw errors, oversized responses or retries',async()=>{
 let redirected=0;const target=createServer((_req,res)=>{redirected++;res.end('{}');});target.listen(0,'127.0.0.1');await once(target,'listening');const address=target.address();if(!address||typeof address==='string')throw new Error('fixture_address');
 try{respond=(_query,_variables,res)=>{res.statusCode=302;res.setHeader('Location',`http://127.0.0.1:${address.port}`);res.end();};const client=new BufferGraphQL(transport);await expect(client.request(apiKey,'query Fixture { account { id } }')).rejects.toThrow('remote_unavailable');expect(redirected).toBe(0);expect(calls).toHaveLength(1);
 respond=(_query,_variables,res)=>res.end('x'.repeat(512001));await expect(client.request(apiKey,'query Fixture { account { id } }')).rejects.toThrow('remote_unavailable');
 }finally{target.closeAllConnections();const closed=Promise.withResolvers<void>();target.close(()=>closed.resolve());await closed.promise;}
});
it('aborts an unresponsive provider at the fixed request deadline without retry',async()=>{
 vi.useFakeTimers();let requests=0;
 const client=new BufferGraphQL(async(_url,init)=>{requests++;const pending=Promise.withResolvers<Response>();init.signal?.addEventListener('abort',()=>pending.reject(new Error('private timeout details')),{once:true});return pending.promise;});
 try{const result=expect(client.request(apiKey,'query Fixture { account { id } }')).rejects.toThrow('remote_unavailable');await vi.advanceTimersByTimeAsync(15000);await result;expect(requests).toBe(1);}finally{vi.useRealTimers();}
});
it('encrypts strict provider payloads and authenticates all binding dimensions',()=>{
 const key=Buffer.alloc(32,7),sealed=sealPublisherCredential(key,binding,apiKey);expect(sealed.toString()).not.toContain(apiKey);expect(openPublisherCredential(key,binding,sealed)).toBe(apiKey);
 for(const changed of [{organizationId:'f'.repeat(24)},{channelId:'f'.repeat(24)},{credentialRevision:2},{accountRevision:2},{externalId:'foreign'},{ownerUserId:'20000000-0000-4000-8000-000000000002'}])expect(()=>openPublisherCredential(key,{...binding,...changed},sealed)).toThrow();
});
it('requires complete canonical runtime configuration and keeps heartbeat local',async()=>{
 expect(publisherProductionConfiguration({})).toBeUndefined();expect(()=>publisherProductionConfiguration({FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example'})).toThrow();expect(()=>publisherProductionConfiguration({FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY:'invalid',FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example'})).toThrow();
 const key=Buffer.alloc(32).toString('base64');expect(publisherProductionConfiguration({FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY:key,FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example'})).toMatchObject({mediaOrigin:'https://app.example'});expect(()=>publisherProductionConfiguration({FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY:key,FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example/'})).toThrow();
 await publisher.start();await publisher.heartbeat();expect(store.heartbeat).toHaveBeenCalledTimes(2);expect(calls).toHaveLength(0);
});
