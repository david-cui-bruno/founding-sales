import {expect,test} from 'playwright/test';
import {startAppServer} from './support/appServer.ts';
import {adminState} from './support/adminFixtures.ts';
import type {OutreachControl} from '@fss/contracts';
test('outreach controls preserve a draft across real route navigation',async({page})=>{
 const id='11111111-1111-4111-8111-111111111111';
 const view:OutreachControl={settings:{revision:0,enabled:false,sequenceVersionId:null,bookingUrl:null},blocks:[],senders:[{id,address:'owner@example.test',ownerUserId:id,connected:true,authorized:false,authorizationRevision:0,sendingEnabled:false,dailyCap:5}],sequences:[],candidates:[],replies:[]};
 const app=await startAppServer({admin:adminState(),operations:{'outreach.control':()=>({view,reason:null})}});
 try{
  await page.goto(app.url('#admin'));
  await page.getByRole('button',{name:'Outreach setup'}).click();
  await expect(page.getByText(/^Sending paused/)).toBeVisible();
  await page.getByLabel('Answer fact').fill('Callie integrates with AppFolio.');
  await page.getByRole('button',{name:/^Firms/}).click();
  await expect(page.getByLabel('Answer fact')).toHaveCount(0);
  await page.getByRole('button',{name:/^Settings/}).click();
  await expect(page.getByLabel('Answer fact')).toHaveValue('Callie integrates with AppFolio.');
  await expect(page.getByLabel('Automatically answer supported replies')).not.toBeChecked();
  await page.getByRole('button',{name:'Outreach setup'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'.superpowers-outreach-settings.png',fullPage:true});
 }finally{await app.stop();}
});
