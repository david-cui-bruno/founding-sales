import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
import type {SeededMail} from './mailFixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces;mail:SeededMail}
async function seed(f:Fixture){
 const w=f.seeded.alpha.workspaceId,owner=f.seeded.alpha.salesperson.userId;
 await f.session.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision) VALUES($1,$2,$3,'provider-account',repeat('a',64),1,1)",[w,f.mail.alpha.mailboxId,owner]);
 const row=(await f.session.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash,human_decision,decision_revision) VALUES($1,$2,$3,repeat('a',64),'thread','Metadata subject','[\"alex@example.test\"]'::jsonb,now(),'uncertain','unclassified_metadata','metadata-v1',repeat('b',64),'exclude',1) RETURNING id",[w,f.mail.alpha.mailboxId,owner])).rows[0];
 if(row===undefined)throw new Error('Business constraint fixture unavailable');
 await f.session.query("INSERT INTO crm_business_decision_revisions(workspace_id,conversation_id,revision,metadata_revision,policy_revision,actor_user_id,decision) VALUES($1,$2,1,1,1,$3,'exclude')",[w,row.id,owner]);
}
const mutations=[
 ['crm_business_policies_provider_account_id_check','crm_business_policies',"provider_account_id=''"],
 ['crm_business_policies_account_binding_check','crm_business_policies',"account_binding='invalid'"],
 ['crm_business_policies_generation_check','crm_business_policies','generation=0'],
 ['crm_business_policies_revision_check','crm_business_policies','revision=0'],
 ['crm_business_policies_check','crm_business_policies',"disclosure_sha256=repeat('a',64)"],
 ['crm_business_policies_workspace_id_mailbox_id_fkey','crm_business_policies',"mailbox_id='00000000-0000-4000-8000-000000000000'"],
 ['crm_business_policies_workspace_id_owner_user_id_fkey','crm_business_policies',"owner_user_id='00000000-0000-4000-8000-000000000000'"],
 ['crm_business_conversations_account_binding_check','crm_business_conversations',"account_binding='invalid'"],
 ['crm_business_conversations_provider_thread_id_check','crm_business_conversations',"provider_thread_id=''"],
 ['crm_business_conversations_subject_check','crm_business_conversations',"subject=repeat('a',501)"],
 ['crm_business_conversations_participants_check','crm_business_conversations',"participants='[1]'::jsonb"],
 ['crm_business_conversations_metadata_availability_check','crm_business_conversations',"metadata_availability='lost'"],
 ['crm_business_conversations_category_check','crm_business_conversations',"category='arbitrary'"],
 ['crm_business_conversations_reason_check','crm_business_conversations',"reason=''"],
 ['crm_business_conversations_classifier_version_check','crm_business_conversations',"classifier_version=''"],
 ['crm_business_conversations_check','crm_business_conversations','latest_provider_at=NULL'],
 ['crm_business_conversations_metadata_revision_check','crm_business_conversations','metadata_revision=0'],
 ['crm_business_conversations_metadata_hash_check','crm_business_conversations',"metadata_hash='invalid'"],
 ['crm_business_conversations_decision_revision_check','crm_business_conversations','decision_revision=-1'],
 ['crm_business_conversations_human_decision_check','crm_business_conversations',"human_decision='approve'"],
 ['crm_business_conversations_workspace_id_mailbox_id_fkey','crm_business_conversations',"mailbox_id='00000000-0000-4000-8000-000000000000'"],
 ['crm_business_conversations_workspace_id_owner_user_id_fkey','crm_business_conversations',"owner_user_id='00000000-0000-4000-8000-000000000000'"],
 ['crm_business_conversations_check1','crm_business_conversations','decision_revision=0'],
 ['crm_business_decision_revisions_revision_check','crm_business_decision_revisions','revision=0'],
 ['crm_business_decision_revisions_metadata_revision_check','crm_business_decision_revisions','metadata_revision=0'],
 ['crm_business_decision_revisions_policy_revision_check','crm_business_decision_revisions','policy_revision=0'],
 ['crm_business_decision_revisions_decision_check','crm_business_decision_revisions',"decision='approve'"],
 ['crm_business_decision_revisio_workspace_id_conversation_id_fkey','crm_business_decision_revisions',"conversation_id='00000000-0000-4000-8000-000000000000'"],
 ['crm_business_decision_revisions_workspace_id_actor_user_id_fkey','crm_business_decision_revisions',"actor_user_id='00000000-0000-4000-8000-000000000000'"],
] as const;
export const BUSINESS_ACQUISITION_CONSTRAINT_CASES=[
 ...mutations.map(([constraint,table,assignment])=>({constraint,run:async(f:Fixture)=>{await seed(f);return f.session.query(`UPDATE ${table} SET ${assignment} WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId]);}})),
 ...['crm_business_policies','crm_business_conversations','crm_business_decision_revisions'].map(table=>({constraint:table+'_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId]);}})),
 {constraint:'crm_business_conversations_workspace_id_mailbox_id_account__key',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) SELECT workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash FROM crm_business_conversations WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
];
