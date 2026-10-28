import {expect,it} from 'vitest';
import {callingSetupCommandSchema,callingSetupSchema,callingSetupReceiptInputSchema} from '@fss/contracts';
import {browserApiPathAllowed} from '../../src/shared/browserContract.ts';
import {callingSetupBrowserResult} from '../../src/server/callingSetupBoundary.ts';
const id='00000000-0000-4000-8000-000000000001';
it('only admits the three exact setup methods; generic settings and nested routes stay closed',()=>{
 expect(browserApiPathAllowed('GET','/calling/setup')).toBe(true);expect(browserApiPathAllowed('POST','/calling/setup/provider')).toBe(true);expect(browserApiPathAllowed('POST','/calling/setup/receipt')).toBe(true);
 for(const [method,path] of [['POST','/calling/setup'],['GET','/calling/setup/provider'],['GET','/calling/setup/receipt'],['POST','/settings/update'],['GET','/settings/integrations'],['POST','/calling/setup/budget'],['POST','/calling/setup/provider/extra']])expect(browserApiPathAllowed(method!,path!)).toBe(false);
});
it('strict schemas refuse new scope, extra settings/secret metadata and incomplete command identity',()=>{
 const command={commandId:id,clientVersion:'1.4.0',expectedVersion:0,provider:'twilio'};expect(callingSetupCommandSchema.safeParse(command).success).toBe(true);
 for(const extra of [{budget:1000},{consent:true},{changeNote:'override'},{expectedVersion:-1},{provider:'automatic'},{commandId:undefined}])expect(callingSetupCommandSchema.safeParse({...command,...extra}).success).toBe(false);
 const snapshot={callingProvider:{provider:'tel',version:0},telephonyBudget:{version:0,dailyCeilingCents:0,maxMinutesPerCall:30,unitPriceMicros:14000},configured:false,spentTodayCents:0};expect(callingSetupSchema.safeParse(snapshot).success).toBe(true);expect(callingSetupSchema.safeParse({...snapshot,missing:['secret_field']}).success).toBe(false);
 expect(callingSetupReceiptInputSchema.safeParse({commandId:id,payloadSHA256:'a'.repeat(64),operation:'other'}).success).toBe(false);
});
it('maps only closed receipted product refusals and never masks auth, UUID/device/hash collisions or unknown errors',()=>{
 for(const reason of ['admin_only','setting_version_conflict','integration_unconfigured','telephony_budget_disabled'])expect(callingSetupBrowserResult('/calling/setup/provider',409,{status:'refused',replayed:false,reason})).toEqual({status:200,body:{status:'refused',replayed:false,reason}});
 for(const reason of ['command_payload_mismatch','command_device_mismatch','command_kind_mismatch','unknown'])expect(callingSetupBrowserResult('/calling/setup/provider',409,{status:'refused',replayed:false,reason})).toBeNull();
 for(const path of ['/settings/update','/calling/setup','/calling/setup/receipt'])expect(callingSetupBrowserResult(path,409,{status:'refused',replayed:false,reason:'admin_only'})).toBeNull();
 expect(callingSetupBrowserResult('/calling/setup/provider',401,{status:'refused',replayed:false,reason:'admin_only'})).toBeNull();expect(callingSetupBrowserResult('/calling/setup/provider',409,{error:'integration_unconfigured'})).toBeNull();
});
