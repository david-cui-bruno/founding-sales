import {test,expect} from 'playwright/test';
import {startAppServer} from './support/appServer.ts';
test('shows human manual tasks separately in the actual Today shell',async({page})=>{
 const actionId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222';
 const server=await startAppServer({operations:{'ask.actionRead':()=>({items:[{actionId,version:2,kind:'task',status:'open',provenance:'human',createdAt:'2026-10-09T11:00:00Z',updatedAt:'2026-10-09T11:00:00Z',completedAt:null,target:{kind:'person',personId},label:'Prepare scheduling options',text:null,due:{kind:'date',date:'2026-10-10',zone:'America/Chicago',expression:'2026-10-10'},reviewRequired:false,supportState:'current',sources:[]}],nextAfterId:null})}});
 try{await page.goto(server.url('#today'));await expect(page.getByRole('region',{name:'Manual human work'}).getByText('Prepare scheduling options')).toBeVisible();await expect(page.getByRole('button',{name:'Complete manual task'})).toBeVisible();}
 finally{await server.stop();}
});

test('shows a protected human annotation on its actual firm record',async({page})=>{
 const {crmState,FIRM_ID}=await import('./support/crmFixtures.ts');
 const server=await startAppServer({crm:crmState({screen:'firm'}),operations:{'crm.businessMailList':()=>({sources:[],nextAfterId:null}),'crm.progressRead':()=>({events:[],truncated:false}),'calling.history':()=>({calls:[]}),'meetings.forFirm':()=>({meetings:[]}),'research.open':()=>({firm:null,settings:null,worstCaseRunCents:null,spend:null,notice:null,mayMutate:true,role:'salesperson'}),'ask.actionRead':()=>({items:[{actionId:'11111111-1111-4111-8111-111111111111',version:1,kind:'note',status:'active',provenance:'human',createdAt:'2026-10-09T11:00:00Z',updatedAt:'2026-10-09T11:00:00Z',completedAt:null,target:{kind:'firm',firmId:FIRM_ID},label:null,text:'Discuss scheduling options.',due:null,reviewRequired:false,supportState:'current',sources:[]}],nextAfterId:null})}});
 try{await page.goto(server.url(`#firm/${FIRM_ID}`));await expect(page.getByRole('region',{name:'Manual human work'}).getByText('Discuss scheduling options.')).toBeVisible();}
 finally{await server.stop();}
});
