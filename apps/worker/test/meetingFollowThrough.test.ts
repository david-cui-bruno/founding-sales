import { afterEach, describe, expect, it } from 'vitest';
import { meetingDispatchFixture } from '@fss/domain/test/meetings/support/meetingDispatchFixture.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { scheduleMeetingFollowThrough } from '@fss/domain/meetings/followThroughJobs.ts';
import { meetingFollowThroughJobHandler } from '../src/handlers/meetingFollowThrough.ts';
import { runOnce } from '../src/runner/jobRunner.ts';

describe('meeting follow-through through the real worker', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>> | undefined;
  afterEach(async () => { await f?.world.stop(); });
  it('materializes and replays a paused plan without sending or duplicating drafts', async () => {
    f=await meetingDispatchFixture(); const x=f;
    await x.db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1',[x.workspace]);
    const registry=new HandlerRegistry().register(meetingFollowThroughJobHandler());
    for(let n=0;n<2;n++) {
      await withTransaction(x.db,async()=>{for(const job of await scheduleMeetingFollowThrough(x.db,new Date(Date.now()+n*10*60_000).toISOString())) await enqueueJob(x.db,job);});
      const result=await runOnce(x.db,{registry,owner:'meeting-follow-through-test',limit:5});
      expect(result.failed).toBe(0);
    }
    expect((await x.db.query('SELECT id FROM jobs WHERE kind=$1',['meeting.follow_through'])).rows.length).toBeGreaterThan(0);
    expect((await x.db.query('SELECT state FROM meeting_follow_through_drafts WHERE plan_id=$1',[x.planId])).rows).toEqual([{state:'ready'}]);
    expect((await x.db.query('SELECT id FROM outbound_messages')).rows).toHaveLength(0);
    expect((await x.db.query('SELECT pause_observed_at FROM meeting_follow_through WHERE id=$1',[x.planId])).rows[0]!['pause_observed_at']).not.toBeNull();
  });
});
