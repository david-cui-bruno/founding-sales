import {expect,it} from 'vitest';
import {MENU_ROUTES,MENU_SETTINGS} from '../src/main/windowMenu.ts';
it('assigns a unique shortcut to Social and every settings destination',()=>{
 const keys=[...MENU_ROUTES,...MENU_SETTINGS].map(row=>row.accelerator);
 expect(new Set(keys).size).toBe(keys.length);
});
