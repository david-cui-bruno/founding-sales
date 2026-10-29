import {expect,it} from 'vitest';
import {socialPublishingReadinessInputSchema,socialPublishingReadinessSchema} from '../src/socialPublishingReadiness.ts';
const id='10000000-0000-4000-8000-000000000001';
const value={observedAt:'2026-10-29T12:00:00Z',runnerAvailable:false,publishingActivated:false,
 holds:['adapter_unavailable'],accounts:[{accountId:id,revision:2,platform:'linkedin',accountKind:'profile',
  displayName:'Fictional owner',historicalState:'connected',currentAccountVerified:false,holds:['current_account_unverified']}]};
it('accepts only an empty read input and metadata whose current publishing proof is false',()=>{
 expect(socialPublishingReadinessInputSchema.parse({})).toEqual({});expect(socialPublishingReadinessSchema.parse(value)).toEqual(value);
 for(const input of [{accountId:id},{activate:true},{commandId:id},undefined])expect(socialPublishingReadinessInputSchema.safeParse(input).success).toBe(false);
});
it.each([{runnerAvailable:true},{publishingActivated:true},{accounts:[{...value.accounts[0],currentAccountVerified:true}]},
 {accounts:[{...value.accounts[0],token:'private'}]},{holds:['unknown']},{holds:['adapter_unavailable','adapter_unavailable']},
 {accounts:Array.from({length:31},()=>value.accounts[0])}])('refuses activation, extra private fields, unsupported holds and overflow %#',change=>{
 expect(socialPublishingReadinessSchema.safeParse({...value,...change}).success).toBe(false);
});
