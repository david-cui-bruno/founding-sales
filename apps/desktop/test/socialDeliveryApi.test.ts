import {expect,it,vi} from 'vitest';
import type {AuthedClient} from '../src/main/authedClient.ts';
import {createSocialDeliveryPorts} from '../src/main/social/deliveryApi.ts';
const id='11111111-1111-4111-8111-111111111111',fingerprint='a'.repeat(64);
it('allows only one begin attempt even when the server response is lost',async()=>{
 const command=vi.fn(async()=>({ok:false,reason:'offline',offline:true}));const p=createSocialDeliveryPorts({api:{command} as unknown as AuthedClient,current:()=>true,now:()=>0});
 await expect(p.begin({claimId:id,approvalId:id,fingerprint})).rejects.toThrow('submission_uncertain');
 expect(await p.begin({claimId:id,approvalId:id,fingerprint})).toEqual({ok:false,reason:'inspect_existing_submission'});expect(command).toHaveBeenCalledTimes(1);
});
it('returns verified begin data and does not issue commands after session loss',async()=>{
 let current=true;const command=vi.fn(async(_path:string,_payload:unknown,parse:(value:unknown)=>unknown)=>({ok:true,value:parse({submissionId:id})}));const p=createSocialDeliveryPorts({api:{command} as unknown as AuthedClient,current:()=>current,now:()=>0});
 expect(await p.begin({claimId:id,approvalId:id,fingerprint})).toEqual({ok:true,submissionId:id});
 current=false;expect(await p.observe(id,{state:'unknown',receiptId:null,permalink:null,observedAt:'2026-10-06T00:00:00Z',accountExternalId:null,observedFingerprint:null,complete:false})).toBe(false);expect(command).toHaveBeenCalledTimes(1);
});
