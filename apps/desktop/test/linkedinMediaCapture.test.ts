/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {webcrypto,createHash} from 'node:crypto';
import {linkedInMediaCaptureScript} from '../src/main/social/adapters/linkedinMediaCapture.ts';
const token='b6bacf0c-28b2-4290-8eaa-c8647020c3c8';
const bytes=new Uint8Array([1,2,3]),sha256=createHash('sha256').update(bytes).digest('hex');
const blob='blob:https://www.linkedin.com/b0791b68-081f-4d5a-b559-b82eae4ca37f';
const native='https://media.licdn.com/dms/image/v2/native-image/feedshare-shrink_1280/x';
const state=window as unknown as Record<string,unknown>;
function fixture(){document.body.innerHTML=`<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><img src="${blob}" alt="Test image"></dialog>`;}
async function run(action:'arm'|'read',changes={}){return new Function('document','window','fetch','crypto','AbortSignal','MutationObserver',`return ${linkedInMediaCaptureScript({action,token,sha256,altText:'Test image',...changes})}`)(document,window,async()=>new Response(bytes),webcrypto,AbortSignal,window.MutationObserver);}
afterEach(()=>{const capture=state['__callieLinkedInMediaCapture'] as {observer?:MutationObserver;timer?:number}|undefined;capture?.observer?.disconnect();if(capture?.timer)window.clearTimeout(capture.timer);delete state['__callieLinkedInMediaCapture'];document.body.innerHTML='';});
it('binds only the verified original image node changing from its blob to native media',async()=>{fixture();expect(await run('arm')).toEqual({ok:true});document.querySelector('img')!.src=native;await Promise.resolve();expect(await run('read')).toEqual({ok:true,view:{sha256,platformId:'native-image'}});});
it('does not invent a mapping from a later saved-detail image',async()=>{fixture();await run('arm');document.querySelector('img')!.replaceWith(Object.assign(document.createElement('img'),{src:native,alt:'Test image'}));await Promise.resolve();expect(await run('read')).toEqual({ok:false});});
it('refuses changed bytes, changed alt and repeated arming',async()=>{fixture();expect(await run('arm',{sha256:'a'.repeat(64)})).toEqual({ok:false});expect(await run('arm')).toEqual({ok:true});expect(await run('arm')).toEqual({ok:false});document.querySelector('img')!.alt='Changed';document.querySelector('img')!.src=native;await Promise.resolve();expect(await run('read')).toEqual({ok:false});});
it('requires the original token and refuses an unrelated native host',async()=>{fixture();await run('arm');document.querySelector('img')!.src=native.replace('media.licdn.com','evil.test');await Promise.resolve();expect(await run('read')).toEqual({ok:false});expect(await run('read',{token:'9b40c38a-ed43-43d0-b227-177c08724fc6'})).toEqual({ok:false});});
it('refuses a detached composer',async()=>{fixture();await run('arm');document.querySelector('dialog')!.remove();await Promise.resolve();expect(await run('read')).toEqual({ok:false});});
