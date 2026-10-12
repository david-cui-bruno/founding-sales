import {expect,it} from 'vitest';
import {syntheticPaidBudget} from './support/syntheticPaidBudget.ts';
it('enforces one combined pre-dispatch step/spend ceiling and conserves ambiguous calls',async()=>{
 const snapshots:unknown[]=[];let dispatches=0;const budget=syntheticPaidBudget({maxSteps:2,maxCents:100,persist:snapshot=>snapshots.push(snapshot)});
 await expect(budget.run('synthetic',1000,async()=>{dispatches++;throw new Error('unknown_after_wait');})).rejects.toThrow('unknown_after_wait');
 expect(budget.snapshot()).toMatchObject({startedSteps:1,allocatedCents:1});
 await budget.run('synthetic',1000,async()=>{expect(snapshots).toHaveLength(2);dispatches++;return null;});
 await expect(budget.run('synthetic',1000,async()=>{dispatches++;})).rejects.toThrow('synthetic_combined_limit_exceeded');expect(dispatches).toBe(2);
 const spend=syntheticPaidBudget({maxSteps:25,maxCents:1,persist:()=>{}});
 await expect(spend.run('x'.repeat(25000),1000,async()=>{dispatches++;})).rejects.toThrow('synthetic_combined_limit_exceeded');expect(dispatches).toBe(2);
});
it('reserves explicit stronger-model upper prices instead of silently reusing historical Haiku prices',async()=>{
 const budget=syntheticPaidBudget({maxSteps:50,maxCents:500,inputTokenPriceMicros:3,outputTokenPriceMicros:15,persist:()=>{}});
 await budget.run('synthetic',1000,async()=>null);
 expect(budget.snapshot()).toEqual({startedSteps:1,allocatedCents:3});
});
it('fits a separately approved ten-dollar history run without expanding individual call or input ceilings',async()=>{
 let fakeCalls=0;const persisted:unknown[]=[];
 const budget=syntheticPaidBudget({maxSteps:50,maxCents:1000,inputTokenPriceMicros:6,outputTokenPriceMicros:30,persist:value=>persisted.push(value)});
 await budget.run('Synthetic probe',32,async()=>{fakeCalls++;});
 const nearCeiling='x'.repeat(27940); // JSON quotes + protocol2048 =29990bytes.
 for(let index=0;index<4;index++)await budget.run(nearCeiling,4096,async()=>{fakeCalls++;});
 for(let index=0;index<36;index++)await budget.run(nearCeiling,1000,async()=>{fakeCalls++;});
 expect(fakeCalls).toBe(41);expect(persisted).toHaveLength(41);expect(budget.snapshot()).toEqual({startedSteps:41,allocatedCents:882});
 expect(()=>syntheticPaidBudget({maxSteps:50,maxCents:1001,persist:()=>{}})).toThrow('synthetic_budget_configuration_invalid');
 await expect(budget.run('x'.repeat(27951),1000,async()=>{fakeCalls++;})).rejects.toThrow('synthetic_request_bound_exceeded');expect(fakeCalls).toBe(41);
});
