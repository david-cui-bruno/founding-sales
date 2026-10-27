import {expect,it} from 'vitest';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH as path,PROSPECT_PHONE_DISCOVERY_PATHS} from '@fss/contracts';
import {browserApiPathAllowed,BROWSER_COMMAND_PATHS,BROWSER_POST_READ_PATHS} from '../../src/shared/browserContract.ts';
import {PROSPECT_PHONE_DISCOVERY_BROWSER_PATHS,prospectPhoneDiscoveryBrowserResult} from '../../src/server/prospectPhoneDiscoveryBoundary.ts';
it('admits only the exact POST read, never a browser command',()=>{
 expect(BROWSER_POST_READ_PATHS).toContain(path);
 expect(BROWSER_COMMAND_PATHS).not.toContain(path);
 expect(browserApiPathAllowed('POST',path)).toBe(true);
 for(const method of ['GET','PUT','DELETE'])expect(browserApiPathAllowed(method,path)).toBe(false);
 for(const suffix of ['/','/other','?include=all'])expect(browserApiPathAllowed('POST',path+suffix)).toBe(false);
});
it('retains the phone admin boundary without replacing old route identities',()=>{
 expect(PROSPECT_PHONE_DISCOVERY_PATHS.slice(0,3)).toEqual(['/sourcing/candidates/phone-discovery/request','/sourcing/candidates/phone-discovery/read','/sourcing/candidates/phone-discovery/receipt']);
 expect(PROSPECT_PHONE_DISCOVERY_BROWSER_PATHS.has(path)).toBe(true);
});
it('never translates original refusal or auth loss into accepted content',()=>{
 for(const status of [400,401,403,404,409,500])expect(prospectPhoneDiscoveryBrowserResult(path,status,{error:'not_found'})).toBeNull();
 expect(prospectPhoneDiscoveryBrowserResult(path,409,{status:'refused',replayed:false,reason:'source_changed'})).toBeNull();
});
