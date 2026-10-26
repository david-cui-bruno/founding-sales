import {expect,it} from 'vitest';
import {callingBrowserResult} from '../src/server/callingBoundary.ts';
it('normalizes only known product conflicts on the five closed Calling routes',()=>{
 for(const path of ['/calling/wrap','/calling/follow-ups/save'])expect(callingBrowserResult(path,409,{status:'refused',replayed:false,reason:'stale_revision'})).toEqual({status:200,body:{status:'refused',replayed:false,reason:'stale_revision'}});
 expect(callingBrowserResult('/calling/follow-ups/read',404,{error:'draft_unavailable'})).toEqual({status:200,body:{error:'draft_unavailable'}});
 for(const reason of ['command_payload_mismatch','command_kind_mismatch','command_device_mismatch','unauthenticated','session_changed','not_a_known_product_state'])expect(callingBrowserResult('/calling/wrap',409,{status:'refused',replayed:false,reason})).toBeNull();
 for(const status of [401,403,500,503])expect(callingBrowserResult('/calling/wrap',status,{error:'source_unavailable'})).toBeNull();
 expect(callingBrowserResult('/calls/log',409,{error:'source_unavailable'})).toBeNull();expect(callingBrowserResult('/calling/wrap',409,{error:'source_unavailable',note:'private'})).toBeNull();
});
