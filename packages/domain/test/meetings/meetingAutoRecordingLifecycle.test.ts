import { expect,it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { foldMeetingRecordingSetup, invalidateMeetingRecordingSetup } from '../../meetings/autoRecordingLifecycle.ts';
import { meetingAutoRecordingFixture } from './support/meetingAutoRecordingFixture.ts';
it('fold_never_transfers_readiness_to_a_new_zoom_id',async()=>{
  const f=await meetingAutoRecordingFixture();try{
    await f.db.session.query("UPDATE meeting_recording_setup SET state='ready',verified_at=now(),applied_by_us=true WHERE id=$1",[f.operation.operationId]);
    const other=await f.meeting('99999999999');
    await withTransaction(f.db.session,()=>foldMeetingRecordingSetup(f.context,{sourceMeetingId:f.meetingId,targetMeetingId:other,at:f.at}));
    await f.db.session.query('DELETE FROM meetings WHERE id=$1',[f.meetingId]);
    expect(await f.read()).toMatchObject({meeting_id:other,state:'obsolete',applied_by_us:true});
    await withTransaction(f.db.session,()=>invalidateMeetingRecordingSetup(f.context,{meetingId:other,reason:'target_changed',at:f.at}));
    expect(await f.read()).toMatchObject({state:'obsolete'});
  }finally{await f.db.drop();}
});
it('invalidates committed identity changes and restore holds disable setup',async()=>{
  const f=await meetingAutoRecordingFixture();try{
    await f.db.session.query("UPDATE meetings SET state='cancelled' WHERE id=$1",[f.meetingId]);
    expect(await f.read()).toMatchObject({state:'obsolete',reason:'target_changed'});
    const {openHold}=await import('../../policy/holds.ts');
    await withTransaction(f.db.session,()=>openHold(f.context,{scopeKind:'workspace',reasonCode:'restore_in_progress',blockedActionKinds:['email_send'],sourceEventKind:'restore'}));
    const current=(await f.db.session.query<{value:{enabled:boolean}}> ("SELECT value FROM workspace_settings WHERE workspace_id=$1 AND setting_key='meeting_auto_recording' AND superseded_at IS NULL",[f.workspace])).rows[0];
    expect(current?.value.enabled).toBe(false);
  }finally{await f.db.drop();}
});
