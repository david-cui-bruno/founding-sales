import {expect,it,vi} from 'vitest';
vi.mock('../src/main/social/adapters/linkedinStage.ts',()=>({stageLinkedInText:vi.fn(async()=>({ready:true}))}));
vi.mock('../src/main/social/adapters/linkedinImages.ts',()=>({stageLinkedInImages:vi.fn(async()=>({ready:true}))}));
vi.mock('../src/main/social/adapters/linkedinImageFinish.ts',()=>({finishLinkedInImage:vi.fn(async()=>({ready:true}))}));
import {stageLinkedInPost} from '../src/main/social/adapters/linkedinPostStage.ts';
import {stageLinkedInImages} from '../src/main/social/adapters/linkedinImages.ts';
import {stageLinkedInText} from '../src/main/social/adapters/linkedinStage.ts';
import type {ApprovedPost} from '../src/main/social/adapters.ts';
const post:ApprovedPost={deliveryId:'d',postId:'p',revision:1,account:{platform:'linkedin',externalId:'profile',displayName:'Founder'},text:'Approved',images:[{assetId:'a',version:1,localPath:'/private/image.png',sha256:'a'.repeat(64),altText:'Test'}],publishAt:'2026-11-02T15:00:00Z',zone:'America/New_York',fingerprint:'hash'};
function setup(changed=false){let count=0,media=false;return {root:'/private',current:()=>true,now:()=>Date.parse('2026-10-06'),wait:async()=>{},contents:{getURL:()=> 'https://www.linkedin.com/sharing/compose',insertText:async()=>{},executeJavaScriptInIsolatedWorld:vi.fn(async(_world:number,scripts:{code:string}[])=>{const code=scripts[0]!.code;if(code.includes('crypto.subtle.digest'))return {ok:true,view:{sha256:'a'.repeat(64),altText:'Test',bytes:100}};if(code.includes('const action='))return {ok:true,view:{kind:media?'editor':'composer',alt:null,single:false,busy:false,images:[]}};if(code.includes('"action":"openMedia"')){media=true;return {ok:true};}count++;return {ok:true,view:{kind:'composer',text:changed&&count===2?'Changed':'Approved',postingName:'Founder',zone:'America/New_York',scheduleLabel:'Posting at Mon, Nov 2, 10:00 AM'}};})}};}
it('stages approved text/time and one image, then rechecks text/time after image editing',async()=>{const p=setup();expect(await stageLinkedInPost(post,p)).toEqual({ready:true});expect(stageLinkedInText).toHaveBeenCalledWith(expect.objectContaining({images:[]}),p);expect(stageLinkedInImages).toHaveBeenCalledWith(post.images,p);});
it('refuses composer changes during image editing and unsupported multiple images',async()=>{expect(await stageLinkedInPost(post,setup(true))).toMatchObject({ready:false});expect(await stageLinkedInPost({...post,images:[...post.images,...post.images]},setup())).toEqual({ready:false,reason:'format_not_verified'});});
it('does not touch an existing media draft or a signed-out session',async()=>{
 vi.mocked(stageLinkedInText).mockClear();
 const p=setup();p.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async()=>({ok:true,view:{kind:'composer',alt:null,single:false,busy:false,images:[{alt:'Existing image',loaded:true}]}} as never));
 expect(await stageLinkedInPost(post,p)).toMatchObject({ready:false});expect(stageLinkedInText).not.toHaveBeenCalled();
 const q=setup();q.current=()=>false;expect(await stageLinkedInPost(post,q)).toMatchObject({ready:false});expect(q.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

it('refuses an image preview whose bytes differ from the approved derivative',async()=>{const p=setup();const original=p.contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;p.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async(world,scripts)=>scripts[0]!.code.includes('crypto.subtle.digest')?{ok:true,view:{sha256:'b'.repeat(64),altText:'Test',bytes:100}}:original(world,scripts));expect(await stageLinkedInPost(post,p)).toEqual({ready:false,reason:'image_identity_unverified'});});
