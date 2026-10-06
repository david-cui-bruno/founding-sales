import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {createFirm} from '../../crm/firms.ts';
import {saveMeetingQualification,readMeetingQualification} from '../../meetings/qualification.ts';
import {setMeetingAttendance} from '../../meetings/attendance.ts';
import {saveMeetingOutcomeCorrections} from '../../meetings/outcomeCorrections.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>db.drop());
async function meeting(){
 const f=await tx(()=>createFirm(ctx(),{name:`Qualification ${randomUUID()}`,assignedUserId:seeded.alpha.admin.userId}));if(!f.ok)throw new Error(f.reason);
 const uid=randomUUID();return (await db.session.query<{id:string;firm_id:string}>(`INSERT INTO meetings(workspace_id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$3,'booked',now()-interval '1 hour',now()-interval '30 minutes',now()) RETURNING id,firm_id`,[seeded.alpha.workspaceId,f.value.id,uid])).rows[0]!;
}
const fields=['buyingParticipant','maintenanceNeed','openToPaying'] as const;
function input(meetingId:string,expectedRevision=0){const commandId=randomUUID();return {meetingId,expectedRevision,commandId,buyingParticipant:'yes' as const,maintenanceNeed:'yes' as const,openToPaying:'yes' as const,evidence:fields.map(field=>({field,sourceKind:'user_confirmation' as const,sourceId:commandId,sourceRevision:expectedRevision+1}))};}
it('booked and scheduled-end-passed meetings are not qualified without confirmed attendance',async()=>{
 const m=await meeting();expect(await tx(()=>saveMeetingQualification(ctx(),input(m.id)))).toMatchObject({ok:true,value:{revision:1,qualified:false}});
 await db.session.query("UPDATE meetings SET state='ended' WHERE id=$1",[m.id]);expect((await readMeetingQualification(ctx(),m.id))?.qualified).toBe(false);
});
it('held plus three yes answers is qualified; undoing attendance removes it without moving a deal',async()=>{
 const m=await meeting();await tx(()=>setMeetingAttendance(ctx(),{meetingId:m.id,attendance:'attended'}));
 expect(await tx(()=>saveMeetingQualification(ctx(),input(m.id)))).toMatchObject({ok:true,value:{qualified:true}});
 expect((await readMeetingQualification(ctx(),m.id))?.qualified).toBe(true);
 expect((await db.session.query("SELECT id FROM funnel_facts WHERE workspace_id=$1 AND kind='meeting.qualification_saved' AND firm_id=$2",[seeded.alpha.workspaceId,m.firm_id])).rows).toHaveLength(1);
 expect((await db.session.query('SELECT id FROM opportunities WHERE workspace_id=$1 AND firm_id=$2',[seeded.alpha.workspaceId,m.firm_id])).rows).toHaveLength(0);
 await tx(()=>setMeetingAttendance(ctx(),{meetingId:m.id,attendance:'unconfirmed'}));expect((await readMeetingQualification(ctx(),m.id))?.qualified).toBe(false);
 expect((await db.session.query("SELECT id FROM funnel_facts WHERE workspace_id=$1 AND kind='meeting.qualified' AND firm_id=$2 AND withdrawn_at IS NULL",[seeded.alpha.workspaceId,m.firm_id])).rows).toHaveLength(0);
});
it('unknown remains unknown, and saving known answers requires field-specific current evidence',async()=>{
 const m=await meeting();await tx(()=>setMeetingAttendance(ctx(),{meetingId:m.id,attendance:'attended'}));
 expect((await readMeetingQualification(ctx(),m.id))?.maintenanceNeed).toBe('unknown');
 const draft=input(m.id);draft.evidence=draft.evidence.filter(e=>e.field!=='maintenanceNeed');
 expect(await tx(()=>saveMeetingQualification(ctx(),draft))).toEqual({ok:false,reason:'evidence_required'});
 expect(await tx(()=>saveMeetingQualification(ctx(),{...draft,maintenanceNeed:'unknown'}))).toMatchObject({ok:true,value:{qualified:false}});
});
it('refuses stale or foreign command confirmations and stale saves without changing the saved answers',async()=>{
 const m=await meeting(),draft=input(m.id);draft.evidence[0]!.sourceId=randomUUID();
 expect(await tx(()=>saveMeetingQualification(ctx(),draft))).toEqual({ok:false,reason:'source_changed'});
 const valid=input(m.id);expect((await tx(()=>saveMeetingQualification(ctx(),valid))).ok).toBe(true);
 expect(await tx(()=>saveMeetingQualification(ctx(),input(m.id)))).toEqual({ok:false,reason:'qualification_changed'});
 expect((await readMeetingQualification(ctx(),m.id))?.revision).toBe(1);
});
it('changing a cited debrief clears its answer until the user confirms again',async()=>{
 const m=await meeting();await tx(()=>setMeetingAttendance(ctx(),{meetingId:m.id,attendance:'attended'}));
 const note={meetingId:m.id,expectedRevision:0,debrief:'They need help handling after-hours maintenance.',speakerMappings:[],itemOverrides:[],sufficient:true};
 expect((await tx(()=>saveMeetingOutcomeCorrections(ctx(),note))).ok).toBe(true);
 const draft=input(m.id);const evidence=[...draft.evidence.filter(e=>e.field!=='maintenanceNeed'),{field:'maintenanceNeed' as const,sourceKind:'user_note' as const,sourceId:m.id,sourceRevision:1}];
 expect(await tx(()=>saveMeetingQualification(ctx(),{...draft,evidence}))).toMatchObject({ok:true,value:{qualified:true}});
 await tx(()=>saveMeetingOutcomeCorrections(ctx(),{...note,expectedRevision:1,debrief:'Correction: their vendor covers this already.'}));
 expect(await readMeetingQualification(ctx(),m.id)).toMatchObject({maintenanceNeed:'unknown',qualified:false});
});
it('does not expose or update another workspace or an unassigned meeting',async()=>{
 const m=await meeting();const other=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),db.session);
 expect(await readMeetingQualification(other,m.id)).toBeNull();expect((await tx(()=>saveMeetingQualification(other,input(m.id)))).ok).toBe(false);
 const seller=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.salesperson.userId,role:'salesperson'}),db.session);
 expect(await readMeetingQualification(seller,m.id)).toBeNull();expect((await tx(()=>saveMeetingQualification(seller,input(m.id)))).ok).toBe(false);
});
it('keeps qualification history when duplicate meetings fold, requiring confirmation on the survivor',async()=>{
 const {foldMeetingOutcomes}=await import('../../meetings/outcomeCorrections.ts');
 const m=await meeting();await tx(()=>saveMeetingQualification(ctx(),input(m.id)));
 const otherId=randomUUID();await db.session.query(`INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) SELECT workspace_id,$2::uuid,firm_id,($2::uuid)::text,($2::uuid)::text,state,starts_at,ends_at,last_event_at FROM meetings WHERE id=$1`,[m.id,otherId]);
 await tx(()=>foldMeetingOutcomes(ctx(),{sourceMeetingId:m.id,targetMeetingId:otherId}));await db.session.query('DELETE FROM meetings WHERE id=$1',[m.id]);
 expect((await db.session.query('SELECT revision FROM meeting_qualification_revisions WHERE workspace_id=$1 AND meeting_id=$2',[seeded.alpha.workspaceId,otherId])).rows).toHaveLength(1);
 expect(await readMeetingQualification(ctx(),otherId)).toMatchObject({buyingParticipant:'unknown',maintenanceNeed:'unknown',openToPaying:'unknown',qualified:false});
});
it('refuses unsupported or unrelated meeting item references instead of accepting an arbitrary evidence ID',async()=>{
 const m=await meeting(),draft=input(m.id);
 expect(await tx(()=>saveMeetingQualification(ctx(),{...draft,evidence:[...draft.evidence.filter(e=>e.field!=='maintenanceNeed'),{field:'maintenanceNeed',sourceKind:'meeting_item',sourceId:`${randomUUID()}/made-up`,sourceRevision:0}]}))).toEqual({ok:false,reason:'source_changed'});
});
