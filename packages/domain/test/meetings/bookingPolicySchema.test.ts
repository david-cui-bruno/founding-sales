import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
let db:TestDatabase,workspaceId:string;
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await db.session.query<{id:string}>('INSERT INTO workspaces(slug,display_name) VALUES($1,$2) RETURNING id',[`booking-${randomUUID()}`,'Controlled booking'])).rows[0]!.id;});
afterAll(async()=>{await db.drop();});
it('the real reservation catalog token-price guards booking interpretation and retains unit guards',async()=>{
  const catalog=(await db.session.query<{conname:string;definition:string}>("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='provider_reservations'::regclass AND conname IN ('provider_reservations_subject_known','provider_reservations_priced_shape') ORDER BY conname")).rows;
  expect(catalog.find(c=>c.conname==='provider_reservations_priced_shape')?.definition).toContain('booking_interpretation');
  await expect(db.session.query(`INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens) VALUES($1,'aws_bedrock.booking','booking_interpretation',$2,1,'2026-10-13','America/New_York',5,NULL,NULL,NULL)`,[workspaceId,randomUUID()])).rejects.toMatchObject({constraint:'provider_reservations_priced_shape'});
  await expect(db.session.query(`INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros) VALUES($1,'twilio.voice','call_session',$2,1,'2026-10-13','America/New_York',5,NULL,NULL,NULL,'minute',241,10000)`,[workspaceId,randomUUID()])).rejects.toMatchObject({constraint:'provider_reservations_priced_shape'});
});
