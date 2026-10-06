import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {seedMail,type SeededMail} from '../db/support/mailFixtures.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {buildOutreachCadence} from '../../outreach/cadence.ts';
import {claimProspectingTouch,settleProspectingTouch} from '../../outreach/touchReservations.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;let crm:SeededCrm;let mail:SeededMail;
const scope=()=>workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.salesperson.userId,role:'salesperson'});
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);mail=await seedMail(db.session,seeded,crm);});
afterAll(async()=>db.drop());
it('reserves once across connections, retains unknown capacity, and releases only proven non-dispatch',async()=>{
 const candidate=randomUUID(),run=randomUUID(),plan=randomUUID(),at='2026-10-05T14:00:00Z';
 const cadence=buildOutreachCadence({lane:'call_first',startsAt:at,timeZone:'America/New_York'});
 await db.session.query("INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload,status,revision) VALUES($1,$2,$3,'{}','needs_review',1)",[seeded.alpha.workspaceId,candidate,'d'.repeat(64)]);
 await db.session.query("INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name) VALUES($1,$2,$3,1,$4,'fixture','fixture','fixture')",[seeded.alpha.workspaceId,run,candidate,'e'.repeat(64)]);
 await db.session.query("INSERT INTO outreach_plans(workspace_id,id,firm_id,contact_id,owner_user_id,mailbox_id,candidate_id,qualification_run_id,lane,cadence,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'call_first',$9::jsonb,$10)",[seeded.alpha.workspaceId,plan,crm.alpha.firmId,crm.alpha.contactId,seeded.alpha.salesperson.userId,mail.alpha.mailboxId,candidate,run,JSON.stringify(cadence),cadence.expiresAt]);
 const other=await db.appRuntimeSession();const ctx=repositoryContext(scope(),db.session),ctx2=repositoryContext(scope(),other);
 const input={planId:plan,expectedRevision:1,actionId:randomUUID(),channel:'phone' as const,at};
 const results=await Promise.all([withTransaction(db.session,()=>claimProspectingTouch(ctx,input)),withTransaction(other,()=>claimProspectingTouch(ctx2,{...input,actionId:randomUUID()}))]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);
 const accepted=results.find(r=>r.ok)!;if(!accepted.ok)throw new Error('claim failed');
 expect(await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,channel:'email',actionId:randomUUID()}))).toMatchObject({ok:false});
 await withTransaction(db.session,()=>settleProspectingTouch(ctx,{reservationId:accepted.value.reservationId,outcome:'unknown'}));
 expect(await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID()}))).toMatchObject({ok:false});
 await withTransaction(db.session,()=>settleProspectingTouch(ctx,{reservationId:accepted.value.reservationId,outcome:'not_dispatched'}));
 expect(await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID()}))).toMatchObject({ok:true});
 await db.session.query('DELETE FROM outreach_touch_reservations');
 // Skipping an unanswered first call leaves explicit evidence when its email wins.
 const emailTouch=cadence.touches[1]!;
 const skipped=await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID(),channel:'email',at:emailTouch.dueAt}));
 expect(skipped.ok).toBe(true);if(!skipped.ok)throw new Error(skipped.reason);
 expect((await db.session.query('SELECT skipped_ordinals FROM outreach_touch_reservations WHERE id=$1',[skipped.value.reservationId])).rows[0]).toEqual({skipped_ordinals:[1]});
 await withTransaction(db.session,()=>settleProspectingTouch(ctx,{reservationId:skipped.value.reservationId,outcome:'unknown'}));
 expect(await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID(),at:cadence.touches[2]!.dueAt}))).toMatchObject({ok:false,reason:'touch_in_flight'});
 await db.session.query('DELETE FROM outreach_touch_reservations');
 for(const touch of cadence.touches){
  const claim=await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID(),channel:touch.channel,at:touch.dueAt}));
  expect(claim.ok,JSON.stringify(claim)).toBe(true);if(!claim.ok)throw new Error(claim.reason);
  await withTransaction(db.session,()=>settleProspectingTouch(ctx,{reservationId:claim.value.reservationId,outcome:'accepted'}));
  await withTransaction(db.session,()=>settleProspectingTouch(ctx,{reservationId:claim.value.reservationId,outcome:'not_dispatched'}));
 }
 expect((await db.session.query("SELECT channel,count(*)::int AS n FROM outreach_touch_reservations WHERE state='accepted' GROUP BY channel ORDER BY channel")).rows).toEqual([{channel:'email',n:4},{channel:'phone',n:4}]);
 expect(await withTransaction(db.session,()=>claimProspectingTouch(ctx,{...input,actionId:randomUUID(),at:'2026-11-01T15:00:00Z'}))).toMatchObject({ok:false,reason:'plan_expired'});
});
