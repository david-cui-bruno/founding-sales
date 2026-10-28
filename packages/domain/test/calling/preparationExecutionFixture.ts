import {randomUUID} from 'node:crypto';
import {callingPreparationFixture} from './preparationFixture.ts';
import {seedCrm} from '../db/support/crmFixtures.ts';
import {seedPolicy} from '../db/support/policyFixtures.ts';
import {publishTestRegistrySnapshot} from '../support/nationalRegistry.ts';
import {confirmCallingPreparation} from '../../calling/preparation.ts';
import {authorizeDialCommand} from '../../dial/tickets.ts';
import {createCallSession} from '../../calls/sessions.ts';

export async function preparedExecutionFixture(){
 const f=await callingPreparationFixture(),crm=await seedCrm(f.database.session,f.seed),policy=await seedPolicy(f.database.session,f.seed,crm,{registry:false}),w=f.seed.alpha.workspaceId;
 await f.runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,'telephony_budget',1,$2::jsonb,$3)",[w,JSON.stringify({dailyCeilingCents:1000,maxMinutesPerCall:1,unitPriceMicros:14000}),f.seed.alpha.admin.userId]);
 async function prepared(historicalRegistry=false,options:{registry?:boolean}={}){
  const source=await f.source();source.input.reviewedProfile={...source.input.reviewedProfile,locality:'Providence',regionCode:'RI',timeZone:{kind:'reviewed',timeZone:'America/New_York'}};
  const result=await f.tx(()=>confirmCallingPreparation(f.ctx(),source.input,async()=>true));if(!result.ok)throw Error(result.reason);
  const p={...source,...result.value},phone=(await f.runtime.query<{e164:string}>('SELECT e164 FROM phone_routes WHERE id=$1',[p.routeId])).rows[0]!.e164;
  if(options.registry!==false){const clock=historicalRegistry?policy.insideWindow:new Date().toISOString();await publishTestRegistrySnapshot(f.runtime,w,{downloadedAt:clock,publishedAt:clock,e164s:[{e164:phone,result:'clear'}]});}
  return {...p,phone};
 }
 const input=(p:Awaited<ReturnType<typeof prepared>>)=>({firmId:p.firmId,routeId:p.routeId,routeVersion:1,callingIdentityId:policy.alpha.otherCallingIdentityId,deviceId:f.seed.alpha.admin.deviceId,commandId:randomUUID(),at:policy.insideWindow});
 const ticket=(p:Awaited<ReturnType<typeof prepared>>)=>f.tx(()=>authorizeDialCommand(f.ctx(),input(p)));
 const session=(p:Awaited<ReturnType<typeof prepared>>)=>f.tx(()=>createCallSession(f.ctx(),{...input(p),configuredCallerIdE164:'+14015550101'}));
 return {...f,prepared,input,ticket,session,policy,crm};
}
