import {randomUUID} from 'node:crypto';
import type {CallToBookingFixture} from './callToBookingCases.ts';
import type {SqlParameter} from '../../../db/queryable.ts';
type Fixture=CallToBookingFixture;
const absent='00000000-0000-4000-8000-000000004870',hash='a'.repeat(64);
async function insert(f:Fixture,table:string,row:Record<string,SqlParameter>){const columns=Object.keys(row);return await f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));}
function receipt(f:Fixture,patch:Record<string,SqlParameter>={}){return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),source_id:randomUUID(),source_revision:1,source_hash:hash,owner_user_id:f.seeded.alpha.salesperson.userId,mailbox_id:f.mail.alpha.mailboxId,account_binding:hash,event_kind:'contacted',provider_at:'2026-10-01T14:00:00Z',context_hash:hash,original_firm_ids:'{}',original_person_ids:'{}',...patch};}
export const CRM_PROGRESS_CONSTRAINT_CASES:readonly {constraint:string;run(f:Fixture):Promise<unknown>}[]=[
 ...Object.entries({source_revision:0,source_hash:'bad',account_binding:'bad',event_kind:'other',context_hash:'bad',state:'other',owner_user_id:absent,mailbox_id:absent}).map(([column,value])=>({constraint:({owner_user_id:'crm_progress_owner_fk',mailbox_id:'crm_progress_mailbox_fk'} as Record<string,string>)[column]??`crm_progress_${column}`,run:async(f:Fixture)=>await insert(f,'crm_mail_progress_receipts',receipt(f,{[column]:value}))})),
 {constraint:'crm_progress_workspace_fk',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{workspace_id:absent,state:'deleted',owner_user_id:null,mailbox_id:null}))},
 {constraint:'crm_progress_prerequisite_revision',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{prerequisite_source_id:randomUUID(),prerequisite_source_revision:0,prerequisite_source_hash:hash}))},
 {constraint:'crm_progress_prerequisite_hash',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{prerequisite_source_id:randomUUID(),prerequisite_source_revision:1,prerequisite_source_hash:'bad'}))},
 {constraint:'crm_progress_prerequisite_tuple',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{prerequisite_source_id:randomUUID()}))},
 {constraint:'crm_progress_reply_prerequisite',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{event_kind:'replied'}))},
 {constraint:'crm_progress_active_proof',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{provider_at:null}))},
 {constraint:'crm_progress_firm_ids',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{original_firm_ids:`{${f.crm.alpha.firmId},${f.crm.alpha.firmId}}`}))},
 {constraint:'crm_progress_person_ids',run:async f=>await insert(f,'crm_mail_progress_receipts',receipt(f,{original_person_ids:'{NULL}'}))},
 {constraint:'crm_progress_receipts_pkey',run:async f=>{const row=receipt(f);await insert(f,'crm_mail_progress_receipts',row);return await insert(f,'crm_mail_progress_receipts',{...row,source_id:randomUUID()});}},
 {constraint:'crm_progress_receipts_exact',run:async f=>{const row=receipt(f);await insert(f,'crm_mail_progress_receipts',row);return await insert(f,'crm_mail_progress_receipts',{...row,id:randomUUID()});}},
 {constraint:'crm_reply_resolutions_pkey',run:async f=>{const row={workspace_id:f.seeded.alpha.workspaceId,request_message_id:randomUUID()};await insert(f,'crm_mail_reply_resolutions',row);return await insert(f,'crm_mail_reply_resolutions',row);}},
 {constraint:'crm_reply_resolutions_receipt_fk',run:async f=>await insert(f,'crm_mail_reply_resolutions',{workspace_id:f.seeded.alpha.workspaceId,request_message_id:randomUUID(),sent_receipt_id:absent})},
 {constraint:'crm_reply_resolutions_workspace_fk',run:async f=>await insert(f,'crm_mail_reply_resolutions',{workspace_id:absent,request_message_id:randomUUID()})},
 {constraint:'crm_mail_progress_scan_cursors_pkey',run:async f=>{await insert(f,'crm_mail_progress_scan_cursors',{workspace_id:f.seeded.alpha.workspaceId});return await insert(f,'crm_mail_progress_scan_cursors',{workspace_id:f.seeded.alpha.workspaceId});}},
 {constraint:'crm_mail_progress_scan_cursors_workspace_id_fkey',run:async f=>await insert(f,'crm_mail_progress_scan_cursors',{workspace_id:absent})},
];
