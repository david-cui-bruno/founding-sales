import {expect,it} from 'vitest';
import {targetingPolicySchema,targetingProposalSchema} from '@fss/contracts';

const queries=(count:number)=>Array.from({length:count},(_,index)=>({id:`market-${index}`,query:`Residential property management in City ${index}, California`,locality:`City ${index}`,region:'CA' as const}));
const rankOrder=['help_request','operational_burden','investigation','fit_only'];
it.each([31,60,64])('supports an explicitly approved %i-query national policy and proposal',count=>{
 const value=queries(count);
 expect(targetingPolicySchema.safeParse({version:'national-fixture',queries:value,rankOrder}).success).toBe(true);
 expect(targetingProposalSchema.safeParse({basePolicyVersion:'prior-fixture',queryChanges:value,rankOrder,evidenceIds:[],rationale:'Explicit national fixture; no acquisition.'}).success).toBe(true);
});
it('refuses 65 queries and preserves unrelated evidence and per-selector bounds',()=>{
 const proposal={basePolicyVersion:'prior-fixture',queryChanges:queries(65),rankOrder,evidenceIds:[],rationale:'Bounded fixture.'};
 expect(targetingProposalSchema.safeParse(proposal).success).toBe(false);
 expect(targetingPolicySchema.safeParse({version:'fixture',queries:queries(65),rankOrder}).success).toBe(false);
 expect(targetingProposalSchema.safeParse({...proposal,queryChanges:[{...queries(1)[0],query:'x'.repeat(401)}]}).success).toBe(false);
 expect(targetingProposalSchema.safeParse({...proposal,queryChanges:queries(1),evidenceIds:Array.from({length:31},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`)}).success).toBe(false);
});
