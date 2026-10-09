import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
interface Fixture { session: SessionQueryable; seeded: TwoWorkspaces; mail: SeededMail; crm: SeededCrm }
async function seed(f: Fixture) {
 const w=f.seeded.alpha.workspaceId, owner=f.seeded.alpha.salesperson.userId, mailbox=f.mail.alpha.mailboxId, source=f.mail.alpha.messageId;
 await f.session.query("INSERT INTO crm_people(workspace_id,full_name) VALUES($1,'Catalog person')",[w]);
 const job=(await f.session.query<{id:string}>("INSERT INTO jobs(workspace_id,kind,idempotency_key,payload,not_before) VALUES($1,'crm.mail_capture','catalog-capture','{}',now()) RETURNING id",[w])).rows[0]!.id;
 await f.session.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'account',repeat('a',64),1,1,1,'disclosure-v1',repeat('b',64),'grant','policy','evaluation','release')",[w,mailbox,owner]);
 const conversation=(await f.session.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,repeat('a',64),'catalog-thread','Catalog subject','[]',now(),'uncertain','unclassified_metadata','metadata-v1',repeat('b',64)) RETURNING id",[w,mailbox,owner])).rows[0]!.id;
 const identity=(await f.session.query<{id:string}>("INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,source_id,lease_fencing_token,job_id,state) VALUES($1,$2,repeat('a',64),'catalog-message',$3,1,$4,'copied') RETURNING id",[w,mailbox,source,job])).rows[0]!.id;
 await f.session.query("INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,provider_at) VALUES($1,$2,$3,1,repeat('c',64),$4,$5,'account',repeat('a',64),1,1,1,$6,0,'disclosure-v1',repeat('b',64),'{}','parser-v1','plain_text','partial','[]','[]',now())",[w,source,identity,owner,mailbox,conversation]);
 await f.session.query("INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,firm_id,context_kind) VALUES($1,$2,1,$3,'acquired')",[w,source,f.crm.alpha.firmId]);
 await f.session.query("INSERT INTO crm_mail_acquisition_tombstones(workspace_id,capture_identity_id,source_id,owner_user_id,source_revision,content_hash,availability) VALUES($1,$2,$3,$4,2,repeat('c',64),'deleted')",[w,identity,source,owner]);
 await f.session.query("INSERT INTO crm_mail_source_intents(workspace_id,source_kind,source_id,source_revision,content_hash) VALUES($1,'mail',$2,1,repeat('c',64))",[w,source]);
}
const mutations = [
 ["crm_mail_capture_controls_provider_account_id_check", "crm_mail_capture_controls", "provider_account_id=''"],
 ["crm_mail_capture_controls_account_binding_check", "crm_mail_capture_controls", "account_binding='invalid'"],
 ["crm_mail_capture_controls_generation_check", "crm_mail_capture_controls", "generation=0"],
 ["crm_mail_capture_controls_revision_check", "crm_mail_capture_controls", "revision=0"],
 ["crm_mail_capture_controls_policy_revision_check", "crm_mail_capture_controls", "policy_revision=0"],
 ["crm_mail_capture_controls_disclosure_version_check", "crm_mail_capture_controls", "disclosure_version=''"],
 ["crm_mail_capture_controls_disclosure_sha256_check", "crm_mail_capture_controls", "disclosure_sha256='invalid'"],
 ["crm_mail_capture_controls_grant_receipt_check", "crm_mail_capture_controls", "grant_receipt=''"],
 ["crm_mail_capture_controls_provider_policy_receipt_check", "crm_mail_capture_controls", "provider_policy_receipt=''"],
 ["crm_mail_capture_controls_evaluation_receipt_check", "crm_mail_capture_controls", "evaluation_receipt=''"],
 ["crm_mail_capture_controls_release_receipt_check", "crm_mail_capture_controls", "release_receipt=''"],
 ["crm_mail_capture_identities_account_binding_check", "crm_mail_capture_identities", "account_binding='invalid'"],
 ["crm_mail_capture_identities_provider_message_id_check", "crm_mail_capture_identities", "provider_message_id='bad id'"],
 ["crm_mail_capture_identities_lease_fencing_token_check", "crm_mail_capture_identities", "lease_fencing_token=0"],
 ["crm_mail_capture_identities_state_check", "crm_mail_capture_identities", "state='invalid'"],
 ["crm_mail_sources_source_revision_check", "crm_mail_sources", "source_revision=0"],
 ["crm_mail_sources_content_hash_check", "crm_mail_sources", "content_hash='invalid'"],
 ["crm_mail_sources_provider_account_id_check", "crm_mail_sources", "provider_account_id=''"],
 ["crm_mail_sources_account_binding_check", "crm_mail_sources", "account_binding='invalid'"],
 ["crm_mail_sources_acquired_generation_check", "crm_mail_sources", "acquired_generation=0"],
 ["crm_mail_sources_controls_revision_check", "crm_mail_sources", "controls_revision=0"],
 ["crm_mail_sources_policy_revision_check", "crm_mail_sources", "policy_revision=0"],
 ["crm_mail_sources_decision_revision_check", "crm_mail_sources", "decision_revision=-1"],
 ["crm_mail_sources_disclosure_version_check", "crm_mail_sources", "disclosure_version=''"],
 ["crm_mail_sources_disclosure_sha256_check", "crm_mail_sources", "disclosure_sha256='invalid'"],
 ["crm_mail_sources_verification_receipts_check", "crm_mail_sources", "verification_receipts='[]'::jsonb"],
 ["crm_mail_sources_parser_version_check", "crm_mail_sources", "parser_version=''"],
 ["crm_mail_sources_representation_check", "crm_mail_sources", "representation='invalid'"],
 ["crm_mail_sources_completeness_check", "crm_mail_sources", "completeness='invalid'"],
 ["crm_mail_sources_passage_ranges_check", "crm_mail_sources", "passage_ranges='{}'::jsonb"],
 ["crm_mail_sources_participants_check", "crm_mail_sources", "participants='{}'::jsonb"],
 ["crm_mail_sources_raw_sender_date_check", "crm_mail_sources", "raw_sender_date=repeat('x',201)"],
 ["crm_mail_sources_availability_check", "crm_mail_sources", "availability='invalid'"],
 ["crm_mail_source_contexts_source_revision_check", "crm_mail_source_contexts", "source_revision=0"],
 ["crm_mail_source_contexts_correspondent_endpoint_hash_check", "crm_mail_source_contexts", "correspondent_endpoint_hash='invalid',person_id=(SELECT id FROM crm_people WHERE workspace_id=$1 LIMIT 1),identity_status='observed_label'"],
 ["crm_mail_source_contexts_identity_status_check", "crm_mail_source_contexts", "identity_status='invalid'"],
 ["crm_mail_source_contexts_operational_match_hash_check", "crm_mail_source_contexts", "operational_match_id=gen_random_uuid(),operational_match_hash='invalid'"],
 ["crm_mail_source_contexts_context_kind_check", "crm_mail_source_contexts", "context_kind='invalid'"],
 ["crm_mail_source_contexts_review_check", "crm_mail_source_contexts", "review='invalid'"],
 ["crm_mail_acquisition_tombstones_source_revision_check", "crm_mail_acquisition_tombstones", "source_revision=0"],
 ["crm_mail_acquisition_tombstones_content_hash_check", "crm_mail_acquisition_tombstones", "content_hash='invalid'"],
 ["crm_mail_acquisition_tombstones_availability_check", "crm_mail_acquisition_tombstones", "availability='invalid'"],
 ["crm_mail_source_intents_source_kind_check", "crm_mail_source_intents", "source_kind='invalid'"],
 ["crm_mail_source_intents_source_revision_check", "crm_mail_source_intents", "source_revision=0"],
 ["crm_mail_source_intents_content_hash_check", "crm_mail_source_intents", "content_hash='invalid'"],
 ["crm_mail_source_intents_state_check", "crm_mail_source_intents", "state='invalid'"],
 ["crm_mail_capture_controls_workspace_id_mailbox_id_fkey", "crm_mail_capture_controls", "mailbox_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_capture_controls_workspace_id_owner_user_id_fkey", "crm_mail_capture_controls", "owner_user_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_capture_identities_workspace_id_mailbox_id_fkey", "crm_mail_capture_identities", "mailbox_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_capture_identities_workspace_id_job_id_fkey", "crm_mail_capture_identities", "job_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_sources_workspace_id_source_id_fkey", "crm_mail_sources", "source_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_sources_workspace_id_capture_identity_id_fkey", "crm_mail_sources", "capture_identity_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_sources_workspace_id_owner_user_id_fkey", "crm_mail_sources", "owner_user_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_sources_workspace_id_conversation_id_fkey", "crm_mail_sources", "conversation_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_source_contexts_workspace_id_source_id_fkey", "crm_mail_source_contexts", "source_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_source_contexts_workspace_id_person_id_fkey", "crm_mail_source_contexts", "person_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_source_contexts_workspace_id_firm_id_fkey", "crm_mail_source_contexts", "firm_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_source_contexts_workspace_id_opportunity_id_fkey", "crm_mail_source_contexts", "opportunity_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_acquisition_tombston_workspace_id_capture_identit_fkey", "crm_mail_acquisition_tombstones", "capture_identity_id='00000000-0000-4000-8000-000000000000'"],
 ["crm_mail_capture_context_snapshot_body_free", "crm_mail_capture_identities", "context_snapshot='[{\"quote\":\"private text\"}]'::jsonb"],
 ["crm_mail_source_contexts_check", "crm_mail_source_contexts", "correspondent_endpoint_hash=repeat('d',64)"],
 ["crm_mail_source_contexts_check1", "crm_mail_source_contexts", "operational_match_id=gen_random_uuid()"],
 ["crm_mail_source_contexts_check2", "crm_mail_source_contexts", "person_id=NULL,firm_id=NULL"],
 ["crm_mail_source_contexts_check3", "crm_mail_source_contexts", "firm_id=NULL,person_id=(SELECT id FROM crm_people WHERE workspace_id=$1 LIMIT 1),opportunity_id='00000000-0000-4000-8000-000000000000'"],
 ] as const;
export const MAIL_CAPTURE_CONSTRAINT_CASES = [
 ...mutations.map(([constraint,table,assignment])=>({constraint,run:async(f:Fixture)=>{await seed(f);if(constraint==='crm_mail_sources_workspace_id_source_id_fkey')await f.session.query('DELETE FROM crm_mail_source_contexts WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);return f.session.query(`UPDATE ${table} SET ${assignment} WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId]);}})),
 {constraint:'crm_mail_capture_controls_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_capture_controls SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_capture_identities_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_capture_identities SELECT * FROM crm_mail_capture_identities WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_sources_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_sources SELECT * FROM crm_mail_sources WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_source_contexts_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_source_contexts SELECT * FROM crm_mail_source_contexts WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_acquisition_tombstones_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_acquisition_tombstones SELECT * FROM crm_mail_acquisition_tombstones WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_source_intents_pkey',run:async(f:Fixture)=>{await seed(f);return f.session.query('INSERT INTO crm_mail_source_intents SELECT * FROM crm_mail_source_intents WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_capture_identities_workspace_id_mailbox_id_account_key',run:async(f:Fixture)=>{await seed(f);return f.session.query("INSERT INTO crm_mail_capture_identities SELECT (jsonb_populate_record(NULL::crm_mail_capture_identities,to_jsonb(t)||jsonb_build_object('id',gen_random_uuid()))).* FROM crm_mail_capture_identities t WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_acquisition_tombston_workspace_id_capture_identity_key',run:async(f:Fixture)=>{await seed(f);return f.session.query("INSERT INTO crm_mail_acquisition_tombstones SELECT (jsonb_populate_record(NULL::crm_mail_acquisition_tombstones,to_jsonb(t)||jsonb_build_object('source_id',gen_random_uuid()))).* FROM crm_mail_acquisition_tombstones t WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'crm_mail_source_intents_workspace_id_source_kind_source_id__key',run:async(f:Fixture)=>{await seed(f);return f.session.query("INSERT INTO crm_mail_source_intents SELECT (jsonb_populate_record(NULL::crm_mail_source_intents,to_jsonb(t)||jsonb_build_object('id',gen_random_uuid()))).* FROM crm_mail_source_intents t WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
];
