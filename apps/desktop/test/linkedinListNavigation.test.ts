/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInListNavigationScript} from '../src/main/social/adapters/linkedinListNavigation.ts';
afterEach(()=>{document.body.innerHTML='';});
function run(action:'read'|'openSchedule'|'openList'){return new Function('document','window',`return ${linkedInListNavigationScript(action)}`)(document,window);}
it('opens only the composer clock then the native scheduled-list tab',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><a aria-label="Scheduled"></a><button>Schedule</button></dialog>';let clicks=0;document.querySelector('a')!.onclick=()=>{clicks++;};expect(run('read')).toMatchObject({ok:true,kind:'composer'});expect(run('openSchedule')).toEqual({ok:true});expect(clicks).toBe(1);
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input"><input data-testid="time-picker-input"><a>Scheduled (0)</a><button>Confirm</button></dialog>';document.querySelector('a')!.onclick=()=>clicks++;expect(run('read')).toMatchObject({kind:'schedule'});expect(run('openList')).toEqual({ok:true});expect(clicks).toBe(2);
});
it('refuses duplicate tabs, unexpected dialogs and final submission operations',()=>{document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input"><input data-testid="time-picker-input"><a>Scheduled (1)</a><a>Scheduled (1)</a></dialog>';expect(run('openList')).toEqual({ok:false});expect(()=>linkedInListNavigationScript('submit' as never)).toThrow();});
