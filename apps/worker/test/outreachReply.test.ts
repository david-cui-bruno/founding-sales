import {expect,it,vi} from 'vitest';
import type {QueryResultRowLike,SessionQueryable} from '@fss/domain/db/queryable.ts';
import * as maintenance from '@fss/domain/outreach/replyRun.ts';
import * as attribution from '@fss/domain/sourcing/attribution.ts';
import * as handler from '../src/handlers/outreach.ts';
it('has no automatic incoming job handler',()=>{expect('outreachReplyHandler' in handler).toBe(false);});
it.each([false,true])('runs retained maintenance without creating jobs regardless of historical enabled settings=%s',async(enabled)=>{
 const calls:string[]=[];
 const session:SessionQueryable={async query<R extends QueryResultRowLike>(sql:string){
  calls.push(sql);
  const rows:unknown[]=sql.startsWith('SELECT w.id')?[{id:'10000000-0000-4000-8000-000000000001'}]:sql.includes('outreach_settings')?[{routine_replies_enabled:enabled}]:[];
  return {rows:rows as R[],rowCount:rows.length};
 }};
 const lock=vi.spyOn(maintenance,'tryLockRoutineWorkspace').mockResolvedValue(true);
 const expiry=vi.spyOn(maintenance,'expireRoutineReplies').mockResolvedValue();
 const reconcile=vi.spyOn(attribution,'reconcileEmailAttribution').mockResolvedValue(0);
 try{
  expect(await handler.outreachReplySource().find(session,'2026-10-27T00:00:00Z')).toEqual([]);
  expect(expiry).toHaveBeenCalledTimes(1);expect(reconcile).toHaveBeenCalledTimes(1);expect(lock).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);expect(calls[0]).not.toContain('routine_replies_enabled');
  expect(calls.some(sql=>/^(INSERT|UPDATE)/u.test(sql))).toBe(false);
 }finally{vi.restoreAllMocks();}
});
it('skips a workspace whose maintenance lock is busy',async()=>{
 const session:SessionQueryable={async query<R extends QueryResultRowLike>(){return {rows:[{id:'10000000-0000-4000-8000-000000000001'}] as unknown as R[],rowCount:1};}};
 vi.spyOn(maintenance,'tryLockRoutineWorkspace').mockResolvedValue(false);
 const expiry=vi.spyOn(maintenance,'expireRoutineReplies').mockResolvedValue();const reconcile=vi.spyOn(attribution,'reconcileEmailAttribution').mockResolvedValue(0);
 try{expect(await handler.outreachReplySource().find(session,'2026-10-27T00:00:00Z')).toEqual([]);expect(expiry).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}
});
