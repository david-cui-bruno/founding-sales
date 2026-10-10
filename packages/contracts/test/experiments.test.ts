import {expect,it} from 'vitest';
import {experimentContentSchema} from '../src/experiments.ts';
const content=()=>({change:{kind:'email_wording' as const,baseTemplateVersionId:'11111111-1111-4111-8111-111111111111',subject:'Maintenance question',body:'b'.repeat(10000)},interval:{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z'},rationale:'Bounded copy review.',counterexamples:[] as string[],uncertainty:'Small sample.',successMeasures:['Replies.']});
it('refuses oversized UTF-8 proposal content before persistence',()=>{
 expect(experimentContentSchema.safeParse(content()).success).toBe(true);
 expect(experimentContentSchema.safeParse({...content(),counterexamples:Array.from({length:4},()=> 'c'.repeat(2000))}).success).toBe(false);
 expect(experimentContentSchema.safeParse({...content(),change:{...content().change,body:'界'.repeat(6000)}}).success).toBe(false);
});
it('accounts for JSON escaping and leaves room for PostgreSQL JSONB serialization',()=>{
 expect(experimentContentSchema.safeParse({...content(),change:{...content().change,body:'\n'.repeat(9000)}}).success).toBe(false);
});
