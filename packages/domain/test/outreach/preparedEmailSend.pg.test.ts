import {afterAll,beforeAll,expect,it} from 'vitest';
import {SENDING_STOP_LINE} from '@fss/contracts';
import {runEmailRouteValidation} from '../../crm/routeValidation.ts';
import {readCampaignOpeningControl} from '../../outreach/campaignOpeningControl.ts';
import {composeEligibility} from '../../sequences/eligibility.ts';
import {runDueStepExecution} from '../../sequences/executions.ts';
import {recordingSendHandoff} from '../../sequences/sendHandoff.ts';
import {BOOKING_LINK,POSTAL_ADDRESS,goodMx,preparedEmailWorld,verifier} from './preparedEmailFixture.ts';

// ADR0035/0036: an admitted prepared company must actually reach email preparation, greeting its named decision-maker, and the campaign opening policy must not hold it silently.
let world:Awaited<ReturnType<typeof preparedEmailWorld>>,opened:Awaited<ReturnType<typeof preparedEmailWorld>>;
beforeAll(async()=>{[world,opened]=[await preparedEmailWorld(),await preparedEmailWorld({opening:true})];},240_000);
afterAll(async()=>{await world?.stop();await opened?.stop();});

it('prepares the first email for an admitted company whose run is invalid_evidence, greeting its named decision-maker and composed with the booking link, postal address and stop sentence',async()=>{
 const company=await world.prepared('OH',()=>'Call our office.','Columbus',true);
 await world.enrich();
 const run=(await world.runtime.query<{state:string;reason:string|null}>('SELECT state,reason FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[world.ws,company.runId])).rows[0]!;
 expect(run.reason).toBe('invalid_evidence');
 expect(await world.pass()).toEqual({admitted:1,checked:1,failed:0});
 const admission=(await world.runtime.query<{enrollment_id:string;route_id:string;firm_id:string;source_kind:string}>('SELECT enrollment_id,route_id,firm_id,source_kind FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[world.ws,company.candidateId])).rows[0]!;
 expect(admission.source_kind).toBe('prepared_capture');
 expect((await world.runtime.query('SELECT 1 FROM sourcing_attributions WHERE workspace_id=$1 AND firm_id=$2 AND run_id=$3',[world.ws,admission.firm_id,company.runId])).rows).toHaveLength(1);
 // The route is a candidate until the ordinary free route validation passes it (a real MX answer); eligibility reads that, not the admission check.
 const route=(await world.runtime.query<{version:number}>('SELECT version FROM email_addresses WHERE workspace_id=$1 AND id=$2',[world.ws,admission.route_id])).rows[0]!;
 const validated=await world.tx(()=>runEmailRouteValidation(world.ctx(true),{payload:{routeKind:'email',routeId:admission.route_id,routeVersion:route.version},resolver:goodMx}));
 expect(validated.outcome).toBe('written');
 const execution=(await world.runtime.query<{id:string}>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1',[world.ws,admission.enrollment_id])).rows[0]!;
 const handoff=recordingSendHandoff(),dueAt=async()=>(await world.runtime.query<{at:Date}>('SELECT greatest(due_at,not_before)+interval \'1 minute\' AS at FROM step_executions WHERE workspace_id=$1 AND id=$2',[world.ws,execution.id])).rows[0]!.at.toISOString();
 const look=(now:string)=>world.tx(()=>runDueStepExecution(world.ctx(true),{stepExecutionId:execution.id,now,eligibility:composeEligibility(),sendHandoff:handoff}));
 let ran=await look(await dueAt());if(ran.kind==='scheduled')ran=await look(await dueAt());
 expect(ran).toMatchObject({kind:'handed_to_send'});
 const email=handoff.prepared[0]!;
 expect(email.toAddress).toBe(`jordan.blake@${company.domain}`);
 expect(email.body.startsWith('Hi Jordan,\n')).toBe(true);
 for(const text of [BOOKING_LINK,POSTAL_ADDRESS,SENDING_STOP_LINE])expect(email.body).toContain(text);
 expect(handoff.dispatched).toEqual([]);
});

it('does not admit into a campaign with an opening policy, and opening approval refuses once a prepared company is admitted',async()=>{
 await opened.prepared('OH',()=>'Call our office.');await opened.enrich();
 expect(await opened.pass(verifier)).toEqual({admitted:0,checked:0,failed:0});
 expect(await opened.admissions()).toEqual([]);
 expect(await world.approveOpening()).toEqual({ok:false,reason:'prepared_admissions_present'});
 expect(await readCampaignOpeningControl(world.ctx(),{campaignId:world.campaignId},async()=>true)).toMatchObject({approvalState:'unavailable'});
});
