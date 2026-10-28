import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {callingPreparationFixture} from './preparationFixture.ts';
import {confirmCallingPreparation} from '../../calling/preparation.ts';
import {createFirm} from '../../crm/firms.ts';
import {enqueueFirmResearch} from '../../research/enqueue.ts';
import {readResearchSettings,updateResearchSettings} from '../../research/settings.ts';
import {researchClearanceAvailable} from '../../research/ceilings.ts';
import {firmIsResearchable} from '../../research/firmState.ts';
import {workspaceScope} from '../../db/workspaceScope.ts';
import {jobIdempotencyKey} from '../../jobs/jobKinds.ts';
import {researchFirmJobHandler,researchSweepJobHandler} from '../../../../apps/worker/src/handlers/research.ts';
let f:Awaited<ReturnType<typeof callingPreparationFixture>>;
beforeAll(async()=>{f=await callingPreparationFixture();});afterAll(async()=>f?.stop());
it('real preparation hold wins otherwise enabled/priced research at creation, ordinary enqueue, sweep and stale worker claim before any transport or prompt',async()=>{
 const effects=vi.fn(()=>{throw Error('No transport or token/prompt activity is authorized');});
 const ports={pageFetch:{providerKey:'company_page',fetchPages:effects},extraction:{providerKey:'anthropic_extraction',countInputTokens:effects,extract:effects}};
 expect(await f.tx(()=>updateResearchSettings(f.ctx(),{enabled:true}))).toMatchObject({ok:true});
 expect(await readResearchSettings(f.ctx())).toMatchObject({enabled:true,modelName:'claude-haiku-4-5'});
 expect(await researchClearanceAvailable(f.ctx(),{at:new Date().toISOString(),providerKey:'anthropic_extraction'})).toMatchObject({ok:true});
 // The same normal create/enqueue path really is ready for an independently authored company.
 const control=await f.tx(()=>createFirm(f.ctx(),{name:'Independent fictional control',website:'https://control.example.test/',assignedUserId:f.seed.alpha.admin.userId}));if(!control.ok)throw Error(control.reason);
 expect(await firmIsResearchable(f.ctx(),control.value.id)).toMatchObject({ok:true});
 expect(await f.tx(()=>enqueueFirmResearch(f.ctx(),{firmId:control.value.id,trigger:'user_request',requestedByUserId:f.seed.alpha.admin.userId}))).toMatchObject({ok:true});
 const s=await f.source(),saved=await f.tx(()=>confirmCallingPreparation(f.ctx(),s.input,async()=>true));if(!saved.ok)throw Error(saved.reason);
 const p=saved.value,w=f.seed.alpha.workspaceId;
 expect(await f.tx(()=>enqueueFirmResearch(f.ctx(),{firmId:p.firmId,trigger:'user_request',requestedByUserId:f.seed.alpha.admin.userId}))).toEqual({ok:false,reason:'research_disabled'});
 const base={id:randomUUID(),workspaceId:w,attempt:1,maxAttempts:3,fencingToken:'1',leaseOwner:'isolated-preparation-proof',leaseExpiresAt:new Date().toISOString()};
 const scope=workspaceScope(w,{kind:'system',component:'worker'});
 await f.tx(()=>researchSweepJobHandler(ports).handle({session:f.runtime,scope,job:{...base,kind:'research.sweep',idempotencyKey:'fictional-held-sweep',payload:{businessDate:new Date().toISOString().slice(0,10)}}}));
 expect((await f.runtime.query("SELECT 1 FROM jobs WHERE kind='research.firm' AND payload->>'firmId'=$1",[p.firmId])).rows).toEqual([]);
 // Simulate an already queued claim, through the registered worker composition.
 await f.tx(()=>researchFirmJobHandler(ports).handle({session:f.runtime,scope,job:{...base,kind:'research.firm',idempotencyKey:jobIdempotencyKey.researchFirm(p.firmId,1),payload:{firmId:p.firmId,revision:1,trigger:'sweep'}}}));
 expect((await f.runtime.query('SELECT outcome,refusal_code FROM research_runs WHERE firm_id=$1',[p.firmId])).rows).toEqual([{outcome:'refused',refusal_code:'research_disabled'}]);
 expect(effects).not.toHaveBeenCalled();
 for(const table of ['provider_reservations','provider_ledger','evidence_items','firm_facts','firm_judgments','contacts','opportunities','sequence_enrollments'])expect((await f.runtime.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[w])).rows).toEqual([]);
 expect((await f.runtime.query("SELECT reason_code,blocked_action_kinds,released_at FROM active_holds WHERE scope_kind='firm' AND scope_key=$1",[p.firmId])).rows).toEqual([{reason_code:'scoped_pause',blocked_action_kinds:['research'],released_at:null}]);
});
