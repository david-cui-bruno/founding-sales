import { test, expect } from "playwright/test";
import { startAppServer } from "./support/appServer.ts";

test("opens Ask in the real shell and finds records through its closed operation", async ({
  page,
}) => {
  const server = await startAppServer({
    operations: {
      "ask.read": () => ({
        operation: "records",
        selection: "single",
        records: [
          {
            recordId: "11111111-1111-4111-8111-111111111111",
            kind: "person",
            name: "Alex Example",
            firmId: null,
          },
        ],
        nextAfterId: null,
        scanComplete: true,
        coverage: {
          scope: "current_permitted_crm_state",
          acquisition: "unverified",
          semantic: "not_requested",
        },
      }),
    },
  });
  try {
    await page.goto(server.url("#ask"));
    await page.getByLabel("Find a person or firm").fill("Alex");
    await page.getByRole("button", { name: "Find records" }).click();
    await expect(
      page.getByRole("button", { name: "Select Alex Example" }),
    ).toBeVisible();
    await expect(page.getByTestId("nav-ask")).toHaveAttribute(
      "aria-current",
      "page",
    );
  } finally {
    await server.stop();
  }
});

test('asks from selected copies and opens a current citation in the real shell without generated links',async({page})=>{
 const personId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',windowId='33333333-3333-4333-8333-333333333333';
 const source={workspaceId:requestId,sourceId:personId,kind:'selected_note',revision:3,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T11:00:00Z',completeness:'selected_excerpt',availability:'available'};
 const requests:unknown[]=[];
 const server=await startAppServer({operations:{
  'ask.read':argument=>{
   if(typeof argument==='object'&&argument!==null&&'operation' in argument&&argument.operation==='records')return {operation:'records',selection:'single',records:[{recordId:personId,kind:'person',name:'Alex Example',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}};
   return {operation:'sources',scope:{personId},sources:[source],nextAfter:null,coverage:{scope:'record_copied_sources',acquisition:'unverified',semantic:'not_requested',scanComplete:true,candidateCeiling:50,sizeBoundReached:false}};
  },
  'ask.answerRequest':argument=>{requests.push(argument);return {requestId,version:1,state:'pending'};},
  'ask.answerRead':()=>({requestId,version:1,createdAt:'2026-10-09T11:00:00Z',state:'complete',reason:null,question:'What matters to Alex?',fallback:null,answer:{answeredAt:'2026-10-09T11:00:01Z',claims:[{text:'Scheduling may be the main concern.',kind:'inferred',citationWindowIds:[windowId],verification:'supported'}],conflicts:[],missingEvidence:[],abstained:false,coverage:{acquisition:'unverified',semantic:'bounded_evaluated',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:'b'.repeat(64)}}}),
  'ask.answerSourceRead':argument=>{requests.push(argument);return {requestId,version:1,windowId,source:{state:'available',source:{...source,locator:'text:0:24'},extent:{unit:'utf16',length:24},passage:{text:'<a href="https://attacker.example">Scheduling is difficult.</a>',locator:'text:0:24',speaker:null}}};},
 }});
 try{
  await page.goto(server.url('#ask'));
  await page.getByLabel('Find a person or firm').fill('Alex');
  await page.getByRole('button',{name:'Find records'}).click();
  await page.getByRole('button',{name:'Select Alex Example'}).click();
  await page.getByRole('button',{name:'Copied sources'}).click();
  await page.getByLabel('Include Selected note version 3').check();
  await page.getByLabel('Search selected copies').fill('What matters to Alex?');
  await page.getByRole('button',{name:'Explain selected copies'}).click();
  await expect(page.getByText('Inference from source evidence')).toBeVisible();
  await page.getByRole('button',{name:'Open citation 1 for claim 1'}).click();
  await expect(page.getByRole('region',{name:'Current citation'}).getByText('<a href="https://attacker.example">Scheduling is difficult.</a>')).toBeVisible();
  await expect(page.getByRole('region',{name:'Current citation'}).locator('a')).toHaveCount(0);
  expect(requests).toEqual([{question:'What matters to Alex?',scope:{sources:[{workspaceId:requestId,sourceId:personId,kind:'selected_note',revision:3,contentHash:'a'.repeat(64),locator:null}]}},{requestId,expectedVersion:1,windowId}]);
 }finally{await server.stop();}
});
