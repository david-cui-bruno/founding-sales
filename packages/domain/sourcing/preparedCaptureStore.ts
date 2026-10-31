import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';

/** Called only by prepared research after the shared reader has locked current
 * candidates and runs. Repeating this with every source recheck makes manifest
 * erasure/state changes part of the same post-wait snapshot comparison. */
export async function withPreparedCaptureSnapshots(ctx:RepositoryContext,snapshots:readonly ManualPhoneSnapshot[]):Promise<ManualPhoneSnapshot[]> {
 if(!snapshots.length)return [];
 const captures=(await ctx.db.query<{id:string;candidate_id:string;candidate_revision:number;capture_policy_version:string;capture_state:string;prepared_capture:unknown}>(`SELECT id,candidate_id,candidate_revision,capture_policy_version,state AS capture_state,prepared_capture
 FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,[ctx.scope.workspaceId,snapshots.map(s=>s.id)])).rows;
 return snapshots.map(snapshot=>{
  const capture=captures.find(row=>row.id===snapshot.id&&row.candidate_id===snapshot.candidate_id&&row.candidate_revision===snapshot.candidate_revision);
  return {...snapshot,capture_policy_version:capture?.capture_policy_version??'legacy',capture_state:capture?.capture_state??null,prepared_capture:capture?.prepared_capture??null};
 });
}
