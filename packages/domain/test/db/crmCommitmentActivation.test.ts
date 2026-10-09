import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
let database:TestDatabase;
beforeAll(async()=>{database=await createTestDatabase();});
afterAll(async()=>{await database.drop();});
const hash='a'.repeat(64);
const context={personId:null,firmIds:[],relationships:[],review:'current'};
const receipt={reviewId:randomUUID(),reviewRevision:1,activationKey:hash,sourceKind:'selected_note',sourceId:randomUUID(),sourceRevision:1,sourceHash:hash,anchorId:randomUUID(),decisionRevision:0,contextHash:hash,initialContextSnapshot:context,contextSnapshot:context,originalAccessClosure:{firmIds:[],personIds:[]},actionHash:hash,dueHash:hash,activatedAt:'2026-10-01T00:00:00.000Z'};
it('accepts the closed complete activation receipt control',async()=>{
 const result=await database.session.query<{valid:boolean}>('SELECT crm_commitment_activation_valid($1::jsonb) AS valid',[JSON.stringify(receipt)]);
 expect(result.rows[0]!.valid).toBe(true);
});
it.each(Object.keys(receipt))('refuses JSON null in required activation field %s',async field=>{
 const result=await database.session.query<{valid:boolean}>('SELECT crm_commitment_activation_valid($1::jsonb) AS valid',[JSON.stringify({...receipt,[field]:null})]);
 expect(result.rows[0]!.valid).toBe(false);
});
