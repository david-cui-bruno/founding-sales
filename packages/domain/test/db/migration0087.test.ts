import {seedCrm} from './support/crmFixtures.ts';
import {seedExtractionFinancialReceipt} from './support/crmExtractionCases.ts';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {seedAskFinancialReceipt} from './support/askAnswerCases.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {readCrmExtractionPurpose} from '../../crm/processing.ts';

it('upgrades real schema86 prices without changing controls, immutable Ask snapshots or ledger identities',async()=>{
 const db=await createTestDatabase({throughVersion:86});
 try{
  const seeded=await seedTwoWorkspaces(db.session),ws=seeded.alpha.workspaceId;
  await db.session.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,7,false,'legacy','legacy-v1','legacy-grant','legacy-handling',100,1000,2,8,$2)`,[ws,seeded.alpha.admin.userId]);
  await seedAskFinancialReceipt({session:db.session,seeded});
  const crm=await seedCrm(db.session,seeded);
  await seedExtractionFinancialReceipt({session:db.session,seeded,crm});
  const snapshot=async()=>({purpose:(await db.session.query('SELECT to_jsonb(p) AS row FROM crm_extraction_purposes p ORDER BY workspace_id')).rows,receipts:(await db.session.query('SELECT to_jsonb(r) AS row FROM crm_ask_financial_receipts r ORDER BY id')).rows,extractionReceipts:(await db.session.query('SELECT to_jsonb(r) AS row FROM crm_extraction_financial_receipts r ORDER BY generation_id')).rows,reservations:(await db.session.query('SELECT to_jsonb(r) AS row FROM provider_reservations r ORDER BY id')).rows});
  const before=await snapshot();
  await applyMigrations(db.session,{throughVersion:87});
  expect(await readAppliedSchemaVersion(db.session)).toBe(87);
  expect(await snapshot()).toEqual(before);
  const runtime=await db.appRuntimeSession(),context=repositoryContext(workspaceScope(ws,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),runtime);
  expect(await readCrmExtractionPurpose(context)).toMatchObject({enabled:false,revision:7,inputTokenPriceMicros:2,outputTokenPriceMicros:8});
  await runtime.query('UPDATE crm_extraction_purposes SET input_token_price_micros=$2,output_token_price_micros=$3 WHERE workspace_id=$1',[ws,'0.02',0]);
  expect(await readCrmExtractionPurpose(context)).toMatchObject({enabled:false,revision:7,inputTokenPriceMicros:'0.02',outputTokenPriceMicros:0});
  await expect(runtime.query('UPDATE crm_extraction_purposes SET input_token_price_micros=$2 WHERE workspace_id=$1',[ws,'0.0200001'])).rejects.toMatchObject({code:'23514',constraint:'crm_extraction_purposes_input_token_price_micros_check'});
  await expect(runtime.query('UPDATE crm_ask_financial_receipts SET input_price_micros=2 WHERE workspace_id=$1',[ws])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
 }finally{await db.drop();}
});
