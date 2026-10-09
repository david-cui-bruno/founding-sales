import {expect,it} from 'vitest';
import {crmClaimContextSchema} from '../src/crmProcessing.ts';
const id='11111111-1111-4111-8111-111111111111';
it('preserves bounded exact native mail context refs without inventing relationship revisions',()=>{
 const value={personId:null,firmIds:[id],relationships:[],review:'required',mailContexts:[{contextId:id,sourceRevision:1,personId:null,firmId:id,opportunityId:null,operationalMatchId:null,operationalMatchHash:null,kind:'acquired'}]};
 expect(crmClaimContextSchema.parse(value)).toEqual(value);
 expect(crmClaimContextSchema.safeParse({...value,mailContexts:[{...value.mailContexts[0],quote:'Copied body'}]}).success).toBe(false);
 expect(crmClaimContextSchema.safeParse({...value,mailContexts:[{...value.mailContexts[0],operationalMatchId:id}]}).success).toBe(false);
 expect(crmClaimContextSchema.safeParse({...value,mailContexts:Array.from({length:101},()=>value.mailContexts[0])}).success).toBe(false);
});
