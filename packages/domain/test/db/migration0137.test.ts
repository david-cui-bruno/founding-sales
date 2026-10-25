import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {MANUAL_ACTIVITY_CONSTRAINT_CASES,manualActivityRow,insertManualActivity,manualActivityContent} from './support/manualProspectActivityCases.ts';
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:136});seeded=await seedTwoWorkspaces(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(136);await applyMigrations(db.session,{throughVersion:137});expect(await readAppliedSchemaVersion(db.session)).toBe(137);});
afterAll(async()=>db?.drop());
it.each(['INSERT','UPDATE'] as const)('SPEC F1 rejects known occurrence without timestamp via actual %s',async operation=>{
 const runtime=await db.appRuntimeSession(),f={session:runtime,seeded},row=await manualActivityRow(f);
 const content=JSON.stringify({...manualActivityContent(),occurrence:{kind:'known',unexpected:'unbounded private replacement text'}});
 await runtime.query('BEGIN');
 try{
  if(operation==='UPDATE')await insertManualActivity(f,row);
  const write=operation==='INSERT'?insertManualActivity(f,{...row,content}):runtime.query('UPDATE sourcing_manual_prospect_attempts SET content=$2::jsonb,revision=revision+1 WHERE id=$1',[row.id,content]);
  await expect(write).rejects.toMatchObject({code:'23514',constraint:'manual_activity_content'});
 }finally{await runtime.query('ROLLBACK');}
});
it('SPEC F1 still accepts exact known occurrence and correction to unknown',async()=>{
 const runtime=await db.appRuntimeSession(),f={session:runtime,seeded},row=await manualActivityRow(f);
 await runtime.query('BEGIN');
 try{
  await insertManualActivity(f,{...row,content:JSON.stringify({...manualActivityContent(),occurrence:{kind:'known',occurredAt:'2026-10-20T09:30:00.000Z'}})});
  await runtime.query('UPDATE sourcing_manual_prospect_attempts SET content=$2::jsonb,revision=revision+1 WHERE id=$1',[row.id,JSON.stringify(manualActivityContent())]);
 }finally{await runtime.query('ROLLBACK');}
});
it('enforces immutable binding, monotonic CAS and no resurrection after physical withdrawal',async()=>{
 const runtime=await db.appRuntimeSession(),f={session:runtime,seeded},row=await manualActivityRow(f);await insertManualActivity(f,row);
 for(const update of ["candidate_revision=candidate_revision+1,revision=revision+1", "revision=revision+2", "recorded_at=recorded_at+interval '1 second',revision=revision+1"]){
  await runtime.query('BEGIN');try{await expect(runtime.query(`UPDATE sourcing_manual_prospect_attempts SET ${update} WHERE id=$1`,[row.id])).rejects.toMatchObject({code:'23514'});}finally{await runtime.query('ROLLBACK');}
 }
 await runtime.query("UPDATE sourcing_manual_prospect_attempts SET content=NULL,reason='withdrawn',revision=revision+1 WHERE id=$1",[row.id]);
 await runtime.query('BEGIN');try{await expect(runtime.query('UPDATE sourcing_manual_prospect_attempts SET content=$2::jsonb,reason=NULL,revision=revision+1 WHERE id=$1',[row.id,JSON.stringify(manualActivityContent())])).rejects.toMatchObject({code:'23514'});}finally{await runtime.query('ROLLBACK');}
});
it.each(MANUAL_ACTIVITY_CONSTRAINT_CASES)('136 to137 rejects $constraint',async c=>{const runtime=await db.appRuntimeSession();await runtime.query('BEGIN');try{await expect(c.run({session:runtime,seeded})).rejects.toMatchObject({constraint:c.constraint});}finally{await runtime.query('ROLLBACK');}});
it('classifies catalog constraints and grants current-content ownership only',async()=>{
 const runtime=await db.appRuntimeSession(),f={session:runtime,seeded};expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');await insertManualActivity(f,await manualActivityRow(f));
 const constraints=(await runtime.query("SELECT conname FROM pg_constraint WHERE conrelid='sourcing_manual_prospect_attempts'::regclass ORDER BY conname")).rows.map(r=>r['conname']);expect(constraints).toEqual(MANUAL_ACTIVITY_CONSTRAINT_CASES.map(c=>c.constraint).sort());
});
it.each([
 {...manualActivityContent(),performedByUser:false}, {...manualActivityContent(),channel:'automatic'},
 {...manualActivityContent(),result:'qualified'}, {...manualActivityContent(),extra:'private'},
 {...manualActivityContent(),note:'😀'.repeat(501)}, {...manualActivityContent(),note:'x'.repeat(1001)},
 {...manualActivityContent(),occurrence:{kind:'known',occurredAt:'invalid'}},
 {...manualActivityContent(),occurrence:{kind:'known',occurredAt:null}},
 {...manualActivityContent(),occurrence:{kind:'known',occurredAt:'2026-10-20T09:30:00.000Z',unexpected:'private replacement text'}},
 {...manualActivityContent(),result:'callback_requested'},
 {...manualActivityContent(),callback:{note:'wrong result',timing:{kind:'unknown'}}},
 {...manualActivityContent(),result:'callback_requested',callback:{note:'x'.repeat(501),timing:{kind:'unknown'}}},
 {...manualActivityContent(),result:'callback_requested',callback:{note:null,timing:{kind:'confirmed',localDate:'2026-02-30',localTime:'09:00',sourceTimeZone:'America/New_York',dueAt:'invalid'}}},
])('rejects malformed current content case %#',async content=>{await db.session.query('BEGIN');try{await expect(insertManualActivity({session:db.session,seeded},{...await manualActivityRow({session:db.session,seeded}),content:JSON.stringify(content)})).rejects.toMatchObject({constraint:'manual_activity_content'});}finally{await db.session.query('ROLLBACK');}});
