import {z} from 'zod';
const actionSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('read')}),z.strictObject({action:z.literal('openAlt')}),z.strictObject({action:z.literal('back')}),z.strictObject({action:z.literal('next')}),
 z.strictObject({action:z.literal('fillAlt'),text:z.string().min(1).max(1000)}),z.strictObject({action:z.literal('saveAlt'),text:z.string().min(1).max(1000)})
]);
/** Closed, single-image editing operations. No final Post/Schedule operation. */
export function linkedInImageEditorScript(input:z.infer<typeof actionSchema>):string{
 const action=actionSchema.parse(input);
 return `(()=>{const action=${JSON.stringify(action)};
 const visible=e=>!e.hidden&&window.getComputedStyle(e).display!=='none';
 const dialogs=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);
 const editors=dialogs.filter(d=>Array.from(d.querySelectorAll('h2')).some(h=>h.textContent.trim()==='Editor'));
 const fail=()=>({ok:false});
 if(editors.length>1)return fail();const editor=editors[0];
 const one=xs=>xs.length===1?xs[0]:null;
 const click=e=>{if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return fail();e.click();return {ok:true};};
 if(!editor){
  if(action.action!=='read')return fail();
  const composer=one(dialogs.filter(d=>d.querySelector('[componentkey="ShareBox_textEditor"]')));if(!composer)return fail();
  const images=Array.from(composer.querySelectorAll('img')).filter(e=>e.alt);
  const busy=!!composer.querySelector('[role="progressbar"],progress');
  return {ok:true,view:{kind:'composer',alt:null,single:false,busy,images:images.map(e=>({alt:e.alt,loaded:e.complete&&e.naturalWidth>0}))}};
 }
 const altPanel=Array.from(editor.querySelectorAll('h2')).some(h=>h.textContent.trim()==='Add alt text');
 const field=altPanel?one(Array.from(editor.querySelectorAll('textarea')).filter(visible)):null;
 const single=Array.from(editor.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='1 of 1');
 if(action.action==='read')return {ok:true,view:{kind:altPanel?'alt':'editor',alt:field?field.value:null,single,busy:false,images:[]}};
 const button=name=>one(Array.from(editor.querySelectorAll('button')).filter(e=>visible(e)&&(e.textContent.trim()===name||e.getAttribute('aria-label')===name)));
 if(action.action==='openAlt'){if(altPanel||!single)return fail();return click(one(Array.from(editor.querySelectorAll('[role="checkbox"],input[type="checkbox"]')).filter(e=>visible(e)&&e.getAttribute('aria-label')==='Alternative text')));}
 if(action.action==='back')return altPanel?click(button('Back')):fail();
 if(action.action==='next')return !altPanel&&single?click(button('Next')):fail();
 if(!field)return fail();
 if(action.action==='fillAlt'){Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(field,action.text);field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};}
 if(action.action==='saveAlt'){if(field.value!==action.text)return fail();return click(one(['Add','Update'].map(button).filter(Boolean)));}
 return fail();})()`;
}
