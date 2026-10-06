import {expect,it,vi} from 'vitest';
import {finishLinkedInImage} from '../src/main/social/adapters/linkedinImageFinish.ts';
function harness(wrong=false){let mode='editor',saved='',current=true;const actions:string[]=[];
 const execute=vi.fn(async(_world:number,scripts:{code:string}[])=>{const code=scripts[0]!.code;const a=JSON.parse(code.match(/const action=(.*);\n/)![1]!) as {action:string;text?:string};actions.push(a.action);
 if(a.action==='read')return {ok:true,view:{kind:mode,alt:mode==='alt'?saved:null,single:mode==='editor',busy:false,images:mode==='composer'?[{alt:wrong?'wrong':saved,loaded:true}]:[]}};
 if(a.action==='openAlt')mode='alt';if(a.action==='fillAlt')saved=a.text!;if(a.action==='saveAlt'||a.action==='back')mode='editor';if(a.action==='next')mode='composer';return {ok:true};});
 return {actions,signOut:()=>{current=false;},port:{current:()=>current,wait:async()=>{},contents:{getURL:()=> 'https://www.linkedin.com/sharing/compose',executeJavaScriptInIsolatedWorld:execute}}};}
it('reads saved alt text back before advancing and verifies the loaded composer preview',async()=>{const h=harness();expect(await finishLinkedInImage('Test image',h.port)).toEqual({ready:true});expect(h.actions.filter(a=>a==='openAlt')).toHaveLength(2);expect(h.actions).not.toContain('publish');});
it('refuses wrong preview text and a changed session',async()=>{const h=harness(true);expect(await finishLinkedInImage('Test image',h.port)).toMatchObject({ready:false});h.signOut();const count=h.actions.length;expect(await finishLinkedInImage('Test image',h.port)).toMatchObject({ready:false});expect(h.actions).toHaveLength(count);});
it('bounds waiting for upload completion and never submits a post',async()=>{
 const h=harness();let reads=0;h.port.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async(_world,scripts)=>{
 const a=JSON.parse(scripts[0]!.code.match(/const action=(.*);\n/)![1]!) as {action:string};expect(a.action).toBe('read');reads++;return {ok:true,view:{kind:'composer',alt:null,single:false,busy:true,images:[]}};
 });
 expect(await finishLinkedInImage('Test image',h.port)).toMatchObject({ready:false});expect(reads).toBe(30);
});
