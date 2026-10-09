import {test,expect} from 'playwright/test';
import {startAppServer} from './support/appServer.ts';

test('opens Ask in the real shell and finds records through its closed operation',async({page})=>{
 const server=await startAppServer({operations:{'ask.read':()=>({operation:'records',selection:'single',records:[{recordId:'11111111-1111-4111-8111-111111111111',kind:'person',name:'Alex Example',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}})}});
 try{
  await page.goto(server.url('#ask'));
  await page.getByLabel('Find a person or firm').fill('Alex');await page.getByRole('button',{name:'Find records'}).click();
  await expect(page.getByRole('button',{name:'Select Alex Example'})).toBeVisible();
  await expect(page.getByTestId('nav-ask')).toHaveAttribute('aria-current','page');
 }finally{await server.stop();}
});
