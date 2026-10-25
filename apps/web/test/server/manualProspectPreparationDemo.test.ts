import {expect,it} from 'vitest';
import type {BrowserAssets} from '../../src/server/hostContract.ts';
import {manualPreparationDemoNotice,manualProspectPreparationDemoAssets} from '../support/manualProspectPreparationDemo.ts';
it('adds explicit fictional report instructions inside the existing persistent synthetic banner without changing current assets',()=>{
 const html='<aside id="synthetic-demo-label"><strong>SYNTHETIC · NO SEND</strong><details><summary>Local demo instructions and limits</summary><p>Existing limits</p></details></aside><div id="root"></div>';
 const root={body:new TextEncoder().encode(html),contentType:'text/html; charset=utf-8' as const};
 const assets:BrowserAssets=new Map([['/',root]]);
 const decorated=manualProspectPreparationDemoAssets(assets),body=new TextDecoder().decode(decorated.get('/')!.body);
 expect(new TextDecoder().decode(assets.get('/')!.body)).toBe(html);expect(body).toContain(manualPreparationDemoNotice);
 expect(body).toContain('No real call occurred');expect(body).toContain('Nothing is recorded until you deliberately save');
 expect(body).toContain('not a reminder, next-due queue, booking or action');expect(body).toContain('Existing limits');
 expect(body.split('<div id="root">')).toHaveLength(2);expect(body.indexOf('Fictional manual activity instructions')).toBeLessThan(body.indexOf('<div id="root">'));
});
it('refuses absent original synthetic banner rather than accidentally labeling unrelated product assets',()=>{
 const assets:BrowserAssets=new Map([['/',{body:new TextEncoder().encode('<div id="root"></div>'),contentType:'text/html; charset=utf-8'}]]);
 expect(()=>manualProspectPreparationDemoAssets(assets)).toThrow();
});
