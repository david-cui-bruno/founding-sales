import {expect,it} from 'vitest';
import {manualProspectBrowserResult} from '../../src/server/manualProspectBoundary.ts';
it('only maps exact content-free product refusals, never authority or command custody failures',()=>{
 const path='/sourcing/candidates/prospects/feedback';
 for(const reason of ['candidate_changed','candidate_unavailable','invalid_input'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toEqual({status:200,body:{status:'refused',replayed:false,reason}});
 for(const reason of ['admin_only','authority_changed','command_payload_mismatch','command_device_mismatch','session_changed','unknown'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toBeNull();
 expect(manualProspectBrowserResult(path,401,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult('/sourcing/candidates/review',409,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason:'candidate_changed',source:'private'})).toBeNull();
});
