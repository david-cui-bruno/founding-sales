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
