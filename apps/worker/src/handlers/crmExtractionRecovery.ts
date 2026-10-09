import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
/** Financial repair is bounded and body-free. It never grants another external dispatch. */
export function crmExtractionRecoverySource():DueWorkSource{
 return {name:'crm-processing-recovery',async find(session){
  const rows=(await session.query<{workspace_id:string;generation_id:string}>(`SELECT f.workspace_id,f.generation_id FROM crm_extraction_financial_receipts f JOIN jobs j ON j.workspace_id=f.workspace_id AND j.id=f.job_id WHERE f.dispatch_state='calling' AND (j.state<>'running' OR j.lease_expires_at<=clock_timestamp()) ORDER BY f.workspace_id,f.generation_id LIMIT 100`)).rows;
  return rows.map(row=>({workspaceId:row.workspace_id,kind:'crm.extract',idempotencyKey:`crm-extract-recover:${row.generation_id}`,payload:{generationId:row.generation_id},maxAttempts:3}));
 }};
}
