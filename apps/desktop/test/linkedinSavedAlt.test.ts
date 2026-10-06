/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInSavedAltScript} from '../src/main/social/adapters/linkedinSavedAlt.ts';
const expected={token:'b6bacf0c-28b2-4290-8eaa-c8647020c3c8',receiptId:'urn:li:share:123',platformId:'D4E22AQFOb-d1RVmqRw',postingName:'Founder',text:'Approved text',scheduleLabel:'Posting at Tue, Oct 13, 12:00 PM',zone:Intl.DateTimeFormat().resolvedOptions().timeZone};
const state=window as unknown as Record<string,unknown>;
function run(action:'open'|'openAlt'|'read',overrides={}){return new Function('document','window',`return ${linkedInSavedAltScript({...expected,...overrides,action})}`)(document,window);}
function fixture(){
 state['__callieLinkedInDetail']={token:expected.token,receiptId:expected.receiptId,phase:'read'};
 document.body.innerHTML='<dialog open data-testid="dialog"><div role="button">Founder</div><div role="button">Post to Anyone</div><div role="button">Comments: Anyone</div><div contenteditable="true" role="textbox" componentkey="ShareBox_textEditor">Approved text</div><img src="https://media.licdn.com/dms/image/v2/D4E22AQFOb-d1RVmqRw/feedshare-shrink_1280/x"><div>Posting at Tue, Oct 13, 12:00 PM</div><button>Back</button><button aria-label="Edit">Edit</button><button>Schedule</button></dialog>';
 let opens=0,writes=0;
 document.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.onclick=()=>{opens++;document.querySelector('dialog')!.innerHTML='<h2>Editor</h2><span>1 of 1</span><button aria-pressed="false" aria-label="Alternative text">Alternative text</button>';document.querySelector('button')!.onclick=()=>{document.querySelector('dialog')!.innerHTML='<h2>Editor</h2><h2>Add alt text</h2><span>1 of 1</span><textarea>Actual stored alt</textarea><button>Update</button>';document.querySelector('button')!.onclick=()=>writes++;};};
 return {counts:()=>({opens,writes})};
}
afterEach(()=>{document.body.innerHTML='';delete state['__callieLinkedInDetail'];delete state['__callieLinkedInSavedAlt'];});
it('reads the stored value through a receipt-bound editor without writing or submitting',()=>{const h=fixture();expect(run('open')).toEqual({ok:true});expect(run('open')).toEqual({ok:false});expect(run('openAlt')).toEqual({ok:true});expect(run('read')).toEqual({ok:true,view:{receiptId:expected.receiptId,platformId:expected.platformId,altText:'Actual stored alt'}});expect(h.counts()).toEqual({opens:1,writes:0});});
it.each(['receiptId','platformId','text','postingName','scheduleLabel','zone'])('refuses changed %s before opening the editor',key=>{const h=fixture();expect(run('open',{[key]:key==='receiptId'?'urn:li:share:999':'changed'})).toEqual({ok:false});expect(h.counts().opens).toBe(0);});
it('refuses an unbound saved detail, multiple media and changed token',()=>{fixture();delete state['__callieLinkedInDetail'];expect(run('open')).toEqual({ok:false});fixture();document.querySelector('dialog')!.innerHTML+='<img src="https://media.licdn.com/dms/image/v2/other/feedshare-shrink_1280/x">';expect(run('open')).toEqual({ok:false});fixture();expect(run('open')).toEqual({ok:true});expect(run('openAlt',{token:'9b40c38a-ed43-43d0-b227-177c08724fc6'})).toEqual({ok:false});});
it('refuses ambiguous alt panels and does not substitute approved text',()=>{fixture();run('open');run('openAlt');document.querySelector('dialog')!.innerHTML+='<textarea>Other</textarea>';expect(run('read')).toEqual({ok:false});});
