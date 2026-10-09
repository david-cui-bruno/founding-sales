import {mailProgressDependency} from '@fss/domain/crm/progress.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import type {DueWorkSource} from './schedulerPass.ts';
/** Database-only progress projection; it never acquires bodies or sends messages. */
export function crmMailProgressSource():DueWorkSource{return {name:'crm-mail-progress',find:async session=>{
 const workspaces=(await session.query<{id:string}>('SELECT id FROM workspaces ORDER BY id')).rows;
 const jobs:JobSpecification[]=[];
 for(const workspace of workspaces){
 await session.query('INSERT INTO crm_mail_progress_scan_cursors(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspace.id]);
 const cursor=(await session.query<{last_source_id:string|null}>('SELECT last_source_id FROM crm_mail_progress_scan_cursors WHERE workspace_id=$1 FOR UPDATE',[workspace.id])).rows[0]!;
 const scan=async(after:string|null)=>(await session.query<{workspace_id:string;source_id:string;source_revision:number;content_hash:string}>("SELECT workspace_id,source_id,source_revision,content_hash FROM crm_mail_sources WHERE workspace_id=$1 AND availability='available' AND ($2::uuid IS NULL OR source_id>$2) ORDER BY source_id LIMIT 100",[workspace.id,after])).rows;
 let rows=await scan(cursor.last_source_id);if(rows.length===0&&cursor.last_source_id!==null)rows=await scan(null);
 for(const row of rows){const dependency=await mailProgressDependency(session,row.workspace_id,row.source_id);if(!dependency)continue;jobs.push({workspaceId:row.workspace_id,kind:'crm.mail_progress',idempotencyKey:`crm-progress:${row.source_id}:${row.source_revision}:${dependency.hash}`,payload:{sourceId:row.source_id,sourceRevision:row.source_revision,contentHash:row.content_hash,dependencyHash:dependency.hash},maxAttempts:3});}
 await session.query('UPDATE crm_mail_progress_scan_cursors SET last_source_id=$2 WHERE workspace_id=$1',[workspace.id,rows.at(-1)?.source_id??null]);
 }
 return jobs;
}};}
