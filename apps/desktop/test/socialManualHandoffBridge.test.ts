import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {AuthedClient} from '../src/main/authedClient.ts';
import type {SocialManualHandoffView} from '@fss/contracts';
import {createSocialManualHandoffBridge} from '../src/main/social/manualHandoffBridge.ts';
const id='11111111-1111-4111-8111-111111111111';
const view:SocialManualHandoffView={postId:id,revision:1,fingerprint:'a'.repeat(64),approvalId:id,approvedAt:'2026-10-09T12:00:00Z',state:'manual_needed',accountEvidence:'human_review_required',snapshot:{account:{id,platform:'x',externalId:'founder',displayName:'Founder',accountKind:'profile',revision:1},text:'Exact approved server text',images:[],publishAt:'2099-10-10T12:00:00Z',zone:'America/New_York'}};
function harness(send?:typeof fetch){let generation=1;const copy=vi.fn(async(_text:string)=>{}),open=vi.fn(async(_url:string)=>{}),write=vi.fn(async(_path:string,_bytes:Uint8Array)=>{}),chooseDestination=vi.fn(async(_name:string)=>'/private/reviewed.png');
 const serverView=structuredClone(view);const read:AuthedClient['read']=async(_path,parse)=>({ok:true,value:parse({view:serverView})});const api:AuthedClient={read,command:async(_path,_input,parse)=>({ok:true,value:parse({approvalId:id})})};
 const bridge=createSocialManualHandoffBridge({api,generation:()=>generation,copy,open,write,chooseDestination,...(send?{send}:{})});return {api,bridge,copy,open,write,chooseDestination,serverView,changeSession:()=>{generation++;}};
}
it('copies only authenticated exact server text and opens only the fixed provider composer',async()=>{
 const h=harness();const input={postId:id,expectedRevision:1,fingerprint:view.fingerprint,approvalId:id};
 expect(await h.bridge.use({...input,action:'copy'})).toEqual({accepted:true,reason:null});expect(h.copy).toHaveBeenCalledWith(view.snapshot.text);
 expect(await h.bridge.use({...input,action:'open'})).toEqual({accepted:true,reason:null});expect(h.open).toHaveBeenCalledWith('https://x.com/compose/post');
});

const imageBytes=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
function withImage(h:ReturnType<typeof harness>){const image={assetId:id,version:2,sha256:createHash('sha256').update(imageBytes).digest('hex'),altText:'White square',mime:'image/png',width:10,height:10};h.serverView.snapshot.images=[image];
 h.api.read=async(path,parse)=>({ok:true,value:parse(path==='/social/manual-handoff/read'?{view:h.serverView}:path==='/social/assets/read'?{asset:{id,state:'ready',version:2,origin:{kind:'upload',sourceUrl:null,usageNote:null},objects:[{version:2,kind:'derivative',state:'ready',sha256:image.sha256,bytes:imageBytes.length,mime:image.mime,width:10,height:10}]}}:{url:'https://bucket.s3.us-east-1.amazonaws.com/approved',expiresAt:'2099-01-01T00:00:00.000Z'})});
 return {postId:id,expectedRevision:1,fingerprint:view.fingerprint,approvalId:id,action:'save_image',image:{assetId:id,version:2}};
}
it('saves only the reviewed image through a native destination without returning private paths or URLs',async()=>{
 const h=harness(async()=>new Response(new Uint8Array(imageBytes))),input=withImage(h);
 expect(await h.bridge.use(input)).toEqual({accepted:true,reason:null});expect(h.write).toHaveBeenCalledWith('/private/reviewed.png',imageBytes);expect(h.chooseDestination).toHaveBeenCalledWith(`Callie-${id}-v2.png`);
});

it('rechecks approval after fetching image bytes and never writes changed authority',async()=>{
 const h=harness(async()=>{h.serverView.fingerprint='b'.repeat(64);return new Response(new Uint8Array(imageBytes));}),input=withImage(h);
 expect(await h.bridge.use(input)).toEqual({accepted:false,reason:'approval_changed'});expect(h.write).not.toHaveBeenCalled();
});

it('refuses corrupt bytes without writing them or leaking a destination path in the failure',async()=>{
 const corrupt=Buffer.from(imageBytes);corrupt[corrupt.length-1]=0;
 const h=harness(async()=>new Response(new Uint8Array(corrupt))),input=withImage(h);
 expect(await h.bridge.use(input)).toEqual({accepted:false,reason:'image_checksum_mismatch'});expect(h.write).not.toHaveBeenCalled();
});

it('rejects a forged renderer URL or changed server approval without native effects',async()=>{
 const h=harness(),input={postId:id,expectedRevision:1,fingerprint:view.fingerprint,approvalId:id,action:'open'};
 expect(await h.bridge.use({...input,url:'https://attacker.invalid'})).toEqual({accepted:false,reason:'manual_handoff_unavailable'});
 h.serverView.fingerprint='b'.repeat(64);expect(await h.bridge.use(input)).toEqual({accepted:false,reason:'approval_changed'});expect(h.open).not.toHaveBeenCalled();expect(h.copy).not.toHaveBeenCalled();
});

it('blocks a session transition while waiting for authenticated approval',async()=>{
 const h=harness();h.api.read=async(_path,parse)=>{h.changeSession();return {ok:true,value:parse({view:h.serverView})};};
 expect(await h.bridge.use({postId:id,expectedRevision:1,fingerprint:view.fingerprint,approvalId:id,action:'copy'})).toEqual({accepted:false,reason:'session_changed'});expect(h.copy).not.toHaveBeenCalled();
});
