import {isDeepStrictEqual} from 'node:util';
import type {ManualPhoneChoice,manualPhoneSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import {manualPhoneSnapshots,recheckManualPhoneSnapshots,type ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {projectPreparedPhoneChoice} from './manualProspectPhoneChoice.ts';
import {withPreparedCaptureSnapshots} from './preparedCaptureStore.ts';
import {lockPreparedCaptureDependencies} from './preparedCaptureDependencies.ts';
import {withPreparedSourceDeadlines} from './preparedSourceDeadlines.ts';
/** Capture authority (ADR0033) plus each permitted page's own source deadline, from the prepared brief's shared collection. */
export async function withPreparedPhoneSnapshots(ctx:RepositoryContext,rows:readonly ManualProspectRow[],snapshots:ManualPhoneSnapshot[]):Promise<ManualPhoneSnapshot[]>{
 return withPreparedSourceDeadlines(ctx,rows,await withPreparedCaptureSnapshots(ctx,snapshots));
}
export type PreparedPhoneChoiceRead=
 |{ok:false;reason:'authority_changed'}
 |{ok:true;matched:false}
 |{ok:true;matched:true;phone:z.infer<typeof manualPhoneSchema>|null};
/** Current prepared-source reading of one stored/proposed choice (ADR0034). Caller holds the
 * source lifecycle, candidate and membership locks. Same lock order as the prepared reads: lifecycle,
 * ancestors, one sorted evidence union, then repeated principal checks and an after-wait clock.
 * `matched` is false when the choice does not name this candidate's latest qualification run. */
export async function readPreparedPhoneChoice(ctx:RepositoryContext,row:ManualProspectRow,choice:ManualPhoneChoice,authority:()=>Promise<boolean>):Promise<PreparedPhoneChoiceRead>{
 await lockPreparedCaptureDependencies(ctx,[row]);
 const before=await withPreparedPhoneSnapshots(ctx,[row],await manualPhoneSnapshots(ctx,[row]));
 if(before[0]?.id!==choice.runId)return {ok:true,matched:false};
 if(!await authority())return {ok:false,reason:'authority_changed'};
 const checked=await withPreparedPhoneSnapshots(ctx,[row],await recheckManualPhoneSnapshots(ctx,[row],before));
 if(!await authority())return {ok:false,reason:'authority_changed'};
 const current=await withPreparedPhoneSnapshots(ctx,[row],await recheckManualPhoneSnapshots(ctx,[row],before));
 const now=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(!isDeepStrictEqual(before,checked)||!isDeepStrictEqual(before,current))return {ok:true,matched:true,phone:null};
 return {ok:true,matched:true,phone:projectPreparedPhoneChoice(current[0],choice,now)};
}
