import {expect,it} from 'vitest';
import {manualProspectBrowserResult} from '../../src/server/manualProspectBoundary.ts';
it('maps only bounded recording product refusals, never receipt/auth/UUID collisions',()=>{
 const prefix='/sourcing/candidates/prospects/activity';
 for(const action of ['list','read','save'])expect(manualProspectBrowserResult(`${prefix}/${action}`,409,{error:'candidate_unavailable'})).toMatchObject({status:200});
 for(const reason of ['stale_revision','invalid_time','removed','already_exists'])expect(manualProspectBrowserResult(`${prefix}/save`,409,{status:'refused',replayed:false,reason})).toMatchObject({status:200});
 expect(manualProspectBrowserResult(`${prefix}/receipt`,409,{error:'candidate_unavailable'})).toBeNull();
 expect(manualProspectBrowserResult(`${prefix}/save`,401,{error:'candidate_unavailable'})).toBeNull();
 expect(manualProspectBrowserResult(`${prefix}/save`,409,{status:'refused',replayed:false,reason:'command_payload_mismatch'})).toBeNull();
});
it('only maps exact content-free product refusals, never authority or command custody failures',()=>{
 const path='/sourcing/candidates/prospects/feedback';
 for(const reason of ['candidate_changed','candidate_unavailable','invalid_input'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toEqual({status:200,body:{status:'refused',replayed:false,reason}});
 for(const reason of ['admin_only','authority_changed','command_payload_mismatch','command_device_mismatch','session_changed','unknown'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toBeNull();
 expect(manualProspectBrowserResult(path,401,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult('/sourcing/candidates/review',409,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason:'candidate_changed',source:'private'})).toBeNull();
});
