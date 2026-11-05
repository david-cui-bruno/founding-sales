import {expect,it} from 'vitest';
import type {BrowserAssets} from '../../src/server/hostContract.ts';
import {manualProspectPreparationDemoAssets} from '../support/manualProspectPreparationDemo.ts';
it('refuses absent original synthetic banner rather than accidentally labeling unrelated product assets',()=>{
 const assets:BrowserAssets=new Map([['/',{body:new TextEncoder().encode('<div id="root"></div>'),contentType:'text/html; charset=utf-8'}]]);
 expect(()=>manualProspectPreparationDemoAssets(assets)).toThrow();
});
