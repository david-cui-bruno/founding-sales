import {expect,it,vi} from 'vitest';
import * as contracts from '@fss/contracts';
import {OUTREACH_PATHS,routeOutreach} from '../../../../apps/api/src/routes/outreach.ts';
import type {RoutingOptions} from '../../../../apps/api/src/routes/types.ts';
import {OPERATIONS} from '../../../../apps/desktop/src/shared/operations.ts';
const id='10000000-0000-4000-8000-000000000001';
it('rejects obsolete policy commands without removing historical read compatibility',()=>{
 expect('routineSettingsSaveSchema' in contracts).toBe(false);
 expect('routineSettingsCommandSchema' in contracts).toBe(false);
 expect(contracts.outreachMutationSchema.safeParse({action:'policy',commandId:id,expectedRevision:0,enabled:true,sequenceVersionId:id,bookingUrl:null}).success).toBe(false);
 expect(contracts.routineSettingsSchema.safeParse({revision:7,enabled:true,sequenceVersionId:id,bookingUrl:null}).success).toBe(true);
 expect(contracts.outreachMutationSchema.safeParse({action:'reply_manual',commandId:id,id,expectedRevision:1}).success).toBe(true);
});
it('removes the desktop policy endpoint while preserving explicit supported actions',()=>{
 const paths=OPERATIONS['outreach.mutate'].calls.map(call=>call.path);
 expect(paths).not.toContain('/outreach/settings/save');
 expect(paths).toEqual(expect.arrayContaining(['/outreach/reply/manual','/outreach/cohort/enable','/outreach/authorization/save','/outreach/answer-blocks/save','/outreach/answer-blocks/approve','/outreach/answer-blocks/retire']));
});
it.each([false,true])('does not mount a policy write route for enabled=%s, before any auth or database work',async(enabled)=>{
 const auth=vi.fn(()=>{throw new Error('retired route must not inspect authentication');});
 const options=new Proxy({},{get:auth}) as RoutingOptions;
 expect(OUTREACH_PATHS).not.toContain('/outreach/settings/save');
 expect(await routeOutreach({method:'POST',path:'/outreach/settings/save',query:new URLSearchParams(),headers:{},body:{enabled}},options)).toBeNull();
 expect(auth).not.toHaveBeenCalled();
});
