import {expect,it} from 'vitest';
import {manualProspectBrowserResult} from '../../src/server/manualProspectBoundary.ts';
it('keeps priority pagination and review refusals recoverable without mapping authority or custody failures',()=>{
 const prefix='/sourcing/candidates/prospects/priority';
 expect(manualProspectBrowserResult(`${prefix}/list`,409,{error:'view_changed'})).toEqual({status:200,body:{error:'view_changed'}});
 expect(manualProspectBrowserResult(`${prefix}/save`,409,{error:'source_unavailable'})).toEqual({status:200,body:{status:'refused',replayed:false,reason:'source_unavailable'}});
 expect(manualProspectBrowserResult(`${prefix}/consider`,409,{status:'refused',replayed:false,reason:'assessment_changed'})).toMatchObject({status:200});
 for(const action of ['list','save','consider','receipt']){
  expect(manualProspectBrowserResult(`${prefix}/${action}`,401,{error:'view_changed'})).toBeNull();
  for(const reason of ['authority_changed','command_payload_mismatch','command_device_mismatch','unknown'])expect(manualProspectBrowserResult(`${prefix}/${action}`,409,{status:'refused',replayed:false,reason})).toBeNull();
 }
 expect(manualProspectBrowserResult(`${prefix}/receipt`,409,{error:'candidate_unavailable'})).toBeNull();
 expect(manualProspectBrowserResult(`${prefix}/list`,409,{error:'view_changed',private:'extra'})).toBeNull();
});
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
 for(const reason of ['candidate_changed','candidate_unavailable','invalid_input','phone_source_changed'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toEqual({status:200,body:{status:'refused',replayed:false,reason}});
 expect(manualProspectBrowserResult(path,409,{error:'phone_source_changed'})).toEqual({status:200,body:{status:'refused',replayed:false,reason:'phone_source_changed'}});
 expect(manualProspectBrowserResult(path,409,{error:'authority_changed'})).toBeNull();
 for(const reason of ['admin_only','authority_changed','command_payload_mismatch','command_device_mismatch','session_changed','unknown'])expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason})).toBeNull();
 expect(manualProspectBrowserResult(path,401,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult('/sourcing/candidates/review',409,{status:'refused',replayed:false,reason:'candidate_changed'})).toBeNull();
 expect(manualProspectBrowserResult(path,409,{status:'refused',replayed:false,reason:'candidate_changed',source:'private'})).toBeNull();
});
it('keeps prepared prospect view changes separate from session or contact authority',()=>{
 for(const path of ['/sourcing/prepared-prospects/list','/sourcing/prepared-prospects/read']){
  for(const error of ['view_changed','candidate_changed','candidate_unavailable','source_changed','source_expired'])expect(manualProspectBrowserResult(path,409,{error})).toEqual({status:200,body:{error}});
  expect(manualProspectBrowserResult(path,401,{error:'source_expired'})).toBeNull();
  expect(manualProspectBrowserResult(path,409,{error:'authority_changed'})).toBeNull();
  expect(manualProspectBrowserResult(path,409,{error:'source_expired',private:'extra'})).toBeNull();
 }
 expect(manualProspectBrowserResult('/sourcing/prepared-prospects/create',409,{error:'candidate_changed'})).toBeNull();
});
