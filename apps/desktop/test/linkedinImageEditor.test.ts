/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInImageEditorScript} from '../src/main/social/adapters/linkedinImageEditor.ts';
afterEach(()=>{document.body.innerHTML='';});
function run(input:Parameters<typeof linkedInImageEditorScript>[0]){return new Function('document','window',`return ${linkedInImageEditorScript(input)}`)(document,window);}
it('sets and reads alt text only in the unique image editor, leaving the underlying composer alone',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><textarea>Do not change</textarea></dialog><dialog open data-testid="dialog"><h2>Editor</h2><h2>Add alt text</h2><textarea></textarea><button>Add</button></dialog>';
 expect(run({action:'fillAlt',text:'Test image'})).toMatchObject({ok:true});
 expect(document.querySelector('textarea')!.value).toBe('Do not change');
 expect(run({action:'read'})).toMatchObject({ok:true,view:{kind:'alt',alt:'Test image'}});
 let saved=0;document.querySelectorAll('button')[0]!.onclick=()=>saved++;
 expect(run({action:'saveAlt',text:'Wrong'})).toMatchObject({ok:false});expect(saved).toBe(0);
 expect(run({action:'saveAlt',text:'Test image'})).toMatchObject({ok:true});expect(saved).toBe(1);
});
it('requires one image and refuses ambiguous editors and publish actions',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><h2>Editor</h2><img alt="Image Preview"><span>1 of 2</span><button>Next</button></dialog>';
 expect(run({action:'next'})).toMatchObject({ok:false});
 document.body.innerHTML+='<dialog open data-testid="dialog"><h2>Editor</h2></dialog>';
 expect(run({action:'read'})).toMatchObject({ok:false});
 expect(()=>linkedInImageEditorScript({action:'publish'} as never)).toThrow();
});
it('counts media with missing alt instead of hiding an extra image from verification',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><img src="blob:https://www.linkedin.com/approved" alt="Approved image"><img src="blob:https://www.linkedin.com/unexpected" alt=""></dialog>';
 expect(run({action:'read'})).toMatchObject({ok:true,view:{images:[{alt:'Approved image'},{alt:''}]}});
});
it('excludes only the known LinkedIn avatar and rejects unrecognized image sources',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><img src="https://media.licdn.com/dms/image/v2/profile/profile-displayphoto-scale_100_100/x" alt="Founder"><img src="blob:https://www.linkedin.com/upload" alt="Approved image"></dialog>';
 expect(run({action:'read'})).toMatchObject({ok:true,view:{images:[{alt:'Approved image'}]}});
 document.querySelectorAll('img')[1]!.src='https://foreign.test/image.png';expect(run({action:'read'})).toEqual({ok:false});
});
