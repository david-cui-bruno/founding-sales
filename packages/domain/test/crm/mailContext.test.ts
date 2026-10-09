import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {crmClaimContextSchema} from '@fss/contracts';
import {processingContextHash,sameProcessingContext} from '../../crm/processingContext.ts';
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase();});afterAll(async()=>{await db.drop();});
const ref=()=>({contextId:randomUUID(),sourceRevision:1,personId:null,firmId:randomUUID(),opportunityId:null,operationalMatchId:null,operationalMatchHash:null,kind:'acquired' as const});
it('validates exact mail context storage and deterministic fingerprint without granting native source authority',async()=>{
 const ctx=crmClaimContextSchema.parse({personId:null,firmIds:[],relationships:[],review:'required',mailContexts:[ref(),ref()]});
 const result=(await db.session.query<{valid:boolean;hash:string}>('SELECT crm_extraction_context_valid($1::jsonb) AS valid,crm_processing_context_hash($1::jsonb) AS hash',[JSON.stringify(ctx)])).rows[0]!;
 expect(result.valid).toBe(true);expect(result.hash).toBe(processingContextHash(ctx));
 expect(processingContextHash({...ctx,mailContexts:[...ctx.mailContexts!].reverse(),review:'current'})).toBe(result.hash);
 expect(sameProcessingContext(ctx,{...ctx,mailContexts:[...ctx.mailContexts!].reverse(),review:'current'})).toBe(true);
 const base={personId:null,firmIds:[],relationships:[],review:'current' as const};
 expect(processingContextHash({...base,mailContexts:[]})).toBe(processingContextHash(base));
 const hundred=crmClaimContextSchema.parse({...ctx,mailContexts:Array.from({length:100},ref)});
 expect((await db.session.query<{valid:boolean}>('SELECT crm_extraction_context_valid($1::jsonb) AS valid',[JSON.stringify(hundred)])).rows[0]!.valid).toBe(true);
});
it('rejects names, copied text, unpaired operational matches, invalid revisions and excess context refs in SQL and public DTO',async()=>{
 const item=ref(),base={personId:null,firmIds:[],relationships:[],review:'current',mailContexts:[item]};
 for(const invalid of [{...item,quote:'Private quote'},{...item,operationalMatchId:randomUUID()},{...item,sourceRevision:1.5},{...item,kind:'guessed'},{...item,firmId:42}]){
  const value={...base,mailContexts:[invalid]};expect(crmClaimContextSchema.safeParse(value).success).toBe(false);
  expect((await db.session.query<{valid:boolean}>('SELECT crm_extraction_context_valid($1::jsonb) AS valid',[JSON.stringify(value)])).rows[0]!.valid).toBe(false);
 }
 const over={...base,mailContexts:Array.from({length:101},ref)};expect(crmClaimContextSchema.safeParse(over).success).toBe(false);expect((await db.session.query<{valid:boolean}>('SELECT crm_extraction_context_valid($1::jsonb) AS valid',[JSON.stringify(over)])).rows[0]!.valid).toBe(false);
});
