import {REQUIRED_SCHEMA} from '../../db/schemaRange.ts';
import {randomUUID} from 'node:crypto';
import {seedPolicy} from '../db/support/policyFixtures.ts';
import {publishTestRegistrySnapshot} from '../support/nationalRegistry.ts';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm} from '../db/support/crmFixtures.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {readFirm} from '../../crm/firms.ts';
import {callingPreparationSources} from './preparationFixture.ts';
it('upgrades populated schema143 to the current schema without binding or rewriting independent companies, and app_runtime can then use exact preparation owners',async()=>{
 const database=await createTestDatabase({throughVersion:143});
 try{
  const seed=await seedTwoWorkspaces(database.session),crm=await seedCrm(database.session,seed);
  const policy=await seedPolicy(database.session,seed,crm,{registry:false}),w=seed.alpha.workspaceId,user=seed.alpha.salesperson.userId;
  // Native143 populated execution rows. Calling current owners at an old schema
  // would test a production feature against an unsupported schema instead.
  const ticket=(await database.session.query<{id:string}>(`INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at)
   VALUES($1,'upgrade143',$2,$3,1,$4,1,$5,$6,$7,$6,$8,'America/New_York',now()+interval '30 seconds') RETURNING id`,[w,crm.alpha.firmId,policy.alpha.phoneRouteId,policy.alpha.postureId,policy.alpha.callingIdentityId,user,seed.alpha.salesperson.deviceId,policy.alpha.e164])).rows[0]!.id;
  const callId=randomUUID(),reservation=(await database.session.query<{id:string}>(`INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state)
   VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',2,NULL,NULL,NULL,'minute',1,14000,'calling') RETURNING id`,[w,callId])).rows[0]!.id;
  await database.session.query(`INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at,consumed_at,twilio_call_sid)
   VALUES($1,$2,$3,$4,$5,$6,now()+interval '25 seconds',now(),$7)`,[w,callId,ticket,crm.alpha.firmId,user,reservation,'CA'+'a'.repeat(32)]);
  const registry=await publishTestRegistrySnapshot(database.session,w,{e164s:[{e164:policy.alpha.e164,result:'clear'}]});
  const handoff=(await database.session.query<{id:string}>(`WITH tick AS(SELECT clock_timestamp() at) INSERT INTO phone_handoff_attempts(workspace_id,firm_id,actor_user_id,device_id,command_id,phone_route_id,route_version,e164,registry_snapshot_id,registry_scrubbed_at,reserved_at,expires_at)
   SELECT $1,$2,$3,$4,'upgrade143-handoff',$5,1,$6,$7,at,at,at+interval '15 seconds' FROM tick RETURNING id`,[w,crm.alpha.firmId,user,seed.alpha.salesperson.deviceId,policy.alpha.phoneRouteId,policy.alpha.e164,registry])).rows[0]!.id;
  const before=new Map<string,Record<string,unknown>>();for(const [table,id]of [['dial_tickets',ticket],['call_sessions',callId],['phone_handoff_attempts',handoff],['provider_reservations',reservation]])before.set(table!, (await database.session.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]!);
  const firm=await database.session.query('SELECT * FROM firms WHERE id=$1',[crm.alpha.firmId]);
  const routes=await database.session.query('SELECT * FROM phone_routes WHERE firm_id=$1',[crm.alpha.firmId]);
  expect(await readAppliedSchemaVersion(database.session)).toBe(143);
  expect((await applyMigrations(database.session)).map(m=>m.version)).toEqual(Array.from({length:REQUIRED_SCHEMA-143},(_,index)=>144+index));
  expect(await readAppliedSchemaVersion(database.session)).toBe(REQUIRED_SCHEMA);expect(await applyMigrations(database.session)).toEqual([]);
  const runtime=await database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
  const afterFirm=(await runtime.query('SELECT * FROM firms WHERE id=$1',[crm.alpha.firmId])).rows[0]!;
  expect(afterFirm).toEqual({...firm.rows[0],calling_preparation_id:null,calling_preparation_erased_at:null});
  const afterRoutes=(await runtime.query('SELECT * FROM phone_routes WHERE firm_id=$1',[crm.alpha.firmId])).rows;
  expect(afterRoutes).toEqual(routes.rows.map(r=>({...r,calling_preparation_id:null,calling_preparation_erased_at:null})));
  expect(await readFirm(ctx,crm.alpha.firmId)).toMatchObject({name:crm.collidingFirmName});
  for(const [table,id]of [['dial_tickets',ticket],['call_sessions',callId],['phone_handoff_attempts',handoff],['provider_reservations',reservation]]){
   const added=table==='dial_tickets'?{calling_preparation_id:null,calling_preparation_erased_at:null}:table==='phone_handoff_attempts'?{calling_preparation_id:null,calling_preparation_outcome_recorded_at:null}:table==='call_sessions'?{purpose:'business',audio_test_request_id:null}:{};
   expect((await runtime.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]).toEqual({...before.get(table!),...added});
  }
  await expect(withTransaction(runtime,()=>runtime.query('UPDATE dial_tickets SET e164=NULL,firm_time_zone=NULL WHERE id=$1',[ticket]))).rejects.toMatchObject({code:'23514'});

  await expect(withTransaction(runtime,()=>runtime.query('UPDATE phone_routes SET e164=NULL WHERE firm_id=$1',[crm.alpha.firmId]))).rejects.toMatchObject({code:'23514'});
  const source=callingPreparationSources(runtime,seed),p=await source.prepared();expect((await runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
  expect((await runtime.query('SELECT calling_preparation_id FROM firms WHERE id=$1',[crm.alpha.firmId])).rows).toEqual([{calling_preparation_id:null}]);
 }finally{await database.drop();}
});
