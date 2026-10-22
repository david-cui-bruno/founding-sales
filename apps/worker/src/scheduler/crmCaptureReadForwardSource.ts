import type { DueWorkSource } from './schedulerPass.ts';
/** Same one-minute ceiling as ordinary mail sync. One bounded page per job. */
export function crmCaptureReadForwardSource(enabled:boolean):DueWorkSource{return {name:'crm-capture-read-forward',async find(session){
 if(!enabled)return [];
 const rows=(await session.query<{workspace_id:string;recovery_id:string;bucket:string}>(`SELECT p.workspace_id,p.recovery_id,floor(extract(epoch FROM clock_timestamp())/60)::text AS bucket FROM crm_capture_read_progress p JOIN crm_capture_read_recoveries r ON r.workspace_id=p.workspace_id AND r.id=p.recovery_id WHERE r.state='verified' AND p.state IN ('pending','current','scanning') AND (p.last_scan_at IS NULL OR p.last_scan_at<=clock_timestamp()-interval '1 minute') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.workspace_id=p.workspace_id AND j.kind='crm.capture_read_forward' AND j.payload->>'recoveryId'=p.recovery_id::text AND j.state IN ('queued','running')) ORDER BY p.last_scan_at NULLS FIRST,p.recovery_id LIMIT 20`)).rows;
 return rows.map(row=>({workspaceId:row.workspace_id,kind:'crm.capture_read_forward',idempotencyKey:`capture-read-forward:${row.recovery_id}:${row.bucket}`,payload:{recoveryId:row.recovery_id},maxAttempts:1}));
 }};}
