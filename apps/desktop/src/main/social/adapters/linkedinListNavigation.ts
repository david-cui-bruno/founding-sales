import {z} from 'zod';
/** Navigate existing native controls only; never Confirm, Schedule or Post. */
export function linkedInListNavigationScript(raw:'read'|'openSchedule'|'openList'):string{
 const action=z.enum(['read','openSchedule','openList']).parse(raw);
 return `(()=>{const action=${JSON.stringify(action)};
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const roots=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);if(roots.length!==1)return {ok:false};const root=roots[0];
 const all=s=>Array.from(root.querySelectorAll(s)).filter(visible);
 const list=all('[data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"]').length===1;
 const composer=all('[componentkey="ShareBox_textEditor"]').length===1;
 const schedule=all('input[data-testid="date-picker-input"]').length===1&&all('input[data-testid="time-picker-input"]').length===1;
 const kind=list?'list':composer?'composer':schedule?'schedule':'unknown';
 if(action==='read')return {ok:true,kind};
 const targets=action==='openSchedule'&&kind==='composer'?all('a[aria-label="Scheduled"]'):action==='openList'&&kind==='schedule'?all('a').filter(e=>/^Scheduled \\(\\d+\\)$/.test(e.textContent.trim())):[];
 if(targets.length!==1||targets[0].getAttribute('aria-disabled')==='true')return {ok:false};targets[0].click();return {ok:true};
 })()`;
}
