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
