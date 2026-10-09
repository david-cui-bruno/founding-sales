import {mailProgressDependency} from '@fss/domain/crm/progress.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import type {DueWorkSource} from './schedulerPass.ts';
/** Database-only progress projection; it never acquires bodies or sends messages. */
export function crmMailProgressSource():DueWorkSource{return {name:'crm-mail-progress',find:async session=>{
 const rows=(await session.query<{workspace_id:string;source_id:string;source_revision:number;content_hash:string}>("SELECT workspace_id,source_id,source_revision,content_hash FROM crm_mail_sources WHERE availability='available' ORDER BY workspace_id,source_id LIMIT 100")).rows;
 const jobs:JobSpecification[]=[];
 for(const row of rows){const dependency=await mailProgressDependency(session,row.workspace_id,row.source_id);if(!dependency)continue;jobs.push({workspaceId:row.workspace_id,kind:'crm.mail_progress',idempotencyKey:`crm-progress:${row.source_id}:${row.source_revision}:${dependency.hash}`,payload:{sourceId:row.source_id,sourceRevision:row.source_revision,contentHash:row.content_hash,dependencyHash:dependency.hash},maxAttempts:3});}
 return jobs;
}};}
