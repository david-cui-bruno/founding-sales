import {expect,it} from 'vitest';
import {socialPublishingReadinessInputSchema,socialPublishingReadinessSchema} from '../src/socialPublishingReadiness.ts';
const id='10000000-0000-4000-8000-000000000001';
const value={observedAt:'2026-10-29T12:00:00Z',runnerAvailable:false,publishingActivated:false,
 holds:['adapter_unavailable'],accounts:[{accountId:id,revision:2,platform:'linkedin',accountKind:'profile',
  displayName:'Fictional owner',historicalState:'connected',currentAccountVerified:false,holds:['current_account_unverified']}]};
it('accepts only an empty read input and bounded current capability metadata',()=>{
 expect(socialPublishingReadinessInputSchema.parse({})).toEqual({});expect(socialPublishingReadinessSchema.parse(value)).toEqual(value);
 for(const input of [{accountId:id},{activate:true},{commandId:id},undefined])expect(socialPublishingReadinessInputSchema.safeParse(input).success).toBe(false);
});
it.each([{runnerAvailable:'yes'},{publishingActivated:'yes'},{accounts:[{...value.accounts[0],currentAccountVerified:'yes'}]},
 {accounts:[{...value.accounts[0],token:'private'}]},{holds:['unknown']},{holds:['adapter_unavailable','adapter_unavailable']},
 {accounts:Array.from({length:31},()=>value.accounts[0])}])('refuses malformed capability, extra private fields, unsupported holds and overflow %#',change=>{
 expect(socialPublishingReadinessSchema.safeParse({...value,...change}).success).toBe(false);
});
it('accepts real available capability and current active policy without synthetic holds',()=>{
 const ready={...value,runnerAvailable:true,publishingActivated:true,holds:[],accounts:[{...value.accounts[0],currentAccountVerified:true,holds:[]}]};
 expect(socialPublishingReadinessSchema.parse(ready)).toEqual(ready);
});
