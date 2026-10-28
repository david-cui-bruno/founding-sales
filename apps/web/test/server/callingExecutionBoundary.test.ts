import {expect,it} from 'vitest';
import {callingExecutionBrowserResult} from '../../src/server/callingExecutionBoundary.ts';
it('adapts only finite operational refusals, not actual auth or command collisions',()=>{
 expect(callingExecutionBrowserResult('/calls/session',409,{status:'refused',replayed:false,reason:'route_version_stale'})).toMatchObject({status:200});
 for(const reason of ['session_changed','command_id_conflict','payload_mismatch','device_mismatch'])expect(callingExecutionBrowserResult('/calls/session',409,{status:'refused',replayed:false,reason})).toBeNull();
 expect(callingExecutionBrowserResult('/calls/session',401,{error:'session_changed'})).toBeNull();
 expect(callingExecutionBrowserResult('/calls/calling',404,{error:'not_found',message:'Not found'})).toEqual({status:200,body:{availability:'unavailable',reason:'calling_off'}});
 expect(callingExecutionBrowserResult('/calls/access-token',503,{error:'integration_unconfigured',message:'Calling is not configured.'})).toEqual({status:200,body:{availability:'unavailable',reason:'integration_unconfigured'}});
 expect(callingExecutionBrowserResult('/calling/execution/receipt',404,{error:'not_found'})).toBeNull();
 expect(callingExecutionBrowserResult('/calls/stop',409,{status:'refused',replayed:false,reason:'route_version_stale'})).toBeNull();
});
it('review excludes the removed browser history route from operational normalization',()=>{
 expect(callingExecutionBrowserResult('/calls/history',404,{error:'not_found'})).toBeNull();
 expect(callingExecutionBrowserResult('/calls/history',503,{error:'integration_unconfigured'})).toBeNull();
});
it('audio-test refusal is explicit, while auth loss and receipt absence retain uncertainty',()=>{
 for(const reason of ['audio_test_admin_only','audio_test_today','audio_test_limit','audio_test_active','dnc_registry_match','handle_suppressed','telephony_budget_exhausted'])expect(callingExecutionBrowserResult('/calling/audio-test/session',409,{status:'refused',replayed:false,reason})).toMatchObject({status:200});
 expect(callingExecutionBrowserResult('/calling/audio-test/session',503,{error:'integration_unconfigured'})).toMatchObject({status:200,body:{availability:'unavailable'}});
 for(const status of [401,404,503])expect(callingExecutionBrowserResult('/calling/audio-test/receipt',status,{error:'not_found'})).toBeNull();
 expect(callingExecutionBrowserResult('/calling/audio-test/session',409,{status:'refused',replayed:false,reason:'command_payload_mismatch'})).toBeNull();
});
