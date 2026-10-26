import {expect,it} from 'vitest';
import {PROSPECT_PHONE_DISCOVERY_PATHS,prospectPhoneDiscoveryReasonSchema} from '@fss/contracts';
import {PROSPECT_PHONE_DISCOVERY_BROWSER_PATHS,prospectPhoneDiscoveryBrowserResult} from '../../src/server/prospectPhoneDiscoveryBoundary.ts';
const [request,read,receipt]=PROSPECT_PHONE_DISCOVERY_PATHS;
const refusal=(reason:string)=>({status:'refused',replayed:false,reason});
it('has exactly the locked three paths, not a generic sourcing command proxy',()=>{
 expect([...PROSPECT_PHONE_DISCOVERY_BROWSER_PATHS]).toEqual([...PROSPECT_PHONE_DISCOVERY_PATHS]);
 expect(prospectPhoneDiscoveryBrowserResult('/sourcing/qualification/request',409,refusal('research_held'))).toBeNull();
});
it.each(prospectPhoneDiscoveryReasonSchema.options.filter(reason=>reason!=='authority_changed'))('presents only finite product request refusal %s',reason=>{
 const body=refusal(reason);expect(prospectPhoneDiscoveryBrowserResult(request,409,body)).toEqual({status:200,body});
});
it('maps only exact read not_found to unavailable without fetching or refreshing',()=>{
 expect(prospectPhoneDiscoveryBrowserResult(read,404,{error:'not_found'})).toEqual({status:200,body:null});
 for(const path of [request,receipt])expect(prospectPhoneDiscoveryBrowserResult(path,404,{error:'not_found'})).toBeNull();
 expect(prospectPhoneDiscoveryBrowserResult(read,404,{error:'not_found',private:'text'})).toBeNull();
});
it.each(['authority_changed','session_changed','admin_only','unauthenticated','command_payload_mismatch','command_device_mismatch','command_kind_mismatch','client_upgrade_required','unknown_future_reason'])('keeps security/custody refusal %s generic',reason=>{
 for(const path of PROSPECT_PHONE_DISCOVERY_PATHS)expect(prospectPhoneDiscoveryBrowserResult(path,409,refusal(reason))).toBeNull();
});
it('does not normalize read/receipt refusals, success, transport failures or malformed envelopes',()=>{
 for(const path of [read,receipt])expect(prospectPhoneDiscoveryBrowserResult(path,409,refusal('candidate_changed'))).toBeNull();
 for(const status of [200,400,401,403,426,500])expect(prospectPhoneDiscoveryBrowserResult(request,status,refusal('research_held'))).toBeNull();
 for(const body of [null,{reason:'research_held'},{...refusal('research_held'),private:'text'},{...refusal('research_held'),replayed:'false'}])expect(prospectPhoneDiscoveryBrowserResult(request,409,body)).toBeNull();
});
