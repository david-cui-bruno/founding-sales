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
