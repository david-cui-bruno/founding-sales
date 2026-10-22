import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
interface Fixture { session: SessionQueryable; seeded: TwoWorkspaces; mail: SeededMail }
interface Case { constraint: string; run(f: Fixture): Promise<unknown> }
type Row = Record<string, unknown>;
const recovery = 'crm_capture_read_recoveries', progress = 'crm_capture_read_progress';
const absent = '00000000-0000-4000-8000-000000009999';
const insert = (f: Fixture, table: string, row: Row) => f.session.query(
 `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
async function seed(f: Fixture): Promise<Row> {
 const w = f.seeded.alpha.workspaceId, owner = f.seeded.alpha.admin.userId;
 const approval = randomUUID(), incident = randomUUID();
 await insert(f, 'crm_capability_owner_approvals', { workspace_id:w, id:approval, owner_user_id:owner, capability:'mail_capture', configuration_sha256:'a'.repeat(64), quality_tier:'provisional_owner', evaluation_reference:'constraint-catalog', limitations:['representative_quality_unverified'] });
 await insert(f, 'mailbox_provider_incidents', { workspace_id:w, id:incident, mailbox_id:f.mail.alpha.mailboxId, source_kind:'token_refresh', source_id:incident, classification:'transient', reason:'rate_limited', observed_at:'2026-10-01' });
 return { workspace_id:w, id:randomUUID(), mailbox_id:f.mail.alpha.mailboxId, generation:1, incident_id:incident, requester_user_id:owner, owner_user_id:owner, owner_approval_id:approval, controls_revision:1, policy_revision:1, recovery_binding_sha256:'a'.repeat(64), requested_at:'2026-10-02' };
}
export const CRM_CAPTURE_READ_CONSTRAINT_CASES: Case[] = [];
for (const [suffix, patch] of Object.entries({
 generation_check:{generation:0}, controls_revision_check:{controls_revision:0}, policy_revision_check:{policy_revision:0},
 recovery_binding_sha256_check:{recovery_binding_sha256:'invalid'}, state_check:{state:'sending'}, coded_outcome_check:{state:'refused',completed_at:'2026-10-03',coded_outcome:'invalid'},
 check:{state:'probing',probe_started_at:'2026-10-01'}, check1:{state:'refused',completed_at:'2026-10-01',coded_outcome:'provider_refused'},
 workspace_id_mailbox_id_fkey:{mailbox_id:absent}, workspace_id_incident_id_fkey:{incident_id:absent},
 workspace_id_requester_user_id_fkey:{requester_user_id:absent}, workspace_id_owner_user_id_fkey:{owner_user_id:absent}, workspace_id_owner_approval_id_fkey:{owner_approval_id:absent},
})) CRM_CAPTURE_READ_CONSTRAINT_CASES.push({constraint:`${recovery}_${suffix}`,run:async f=>insert(f,recovery,{...await seed(f),...patch})});
CRM_CAPTURE_READ_CONSTRAINT_CASES.push(
 {constraint:'crm_capture_read_recovery_state_times',run:async f=>insert(f,recovery,{...await seed(f),state:'verified',completed_at:'2026-10-03',coded_outcome:'capture_read_verified'})},
 {constraint:`${recovery}_pkey`,run:async f=>{const row=await seed(f);await insert(f,recovery,row);return insert(f,recovery,{...row,generation:2});}},
 {constraint:`${recovery}_workspace_id_mailbox_id_generat_key`,run:async f=>{const row=await seed(f);await insert(f,recovery,row);return insert(f,recovery,{...row,id:randomUUID()});}},
 {constraint:`${recovery}_workspace_id_id_mailbox_id_gene_key`,run:async f=>{
  const row=await seed(f);await insert(f,recovery,row);
  // The composite identity key is redundant with the PK. Isolate it from that
  // earlier unique index only inside the runner's rolled-back fixture transaction.
  await f.session.query(`ALTER TABLE ${recovery} DROP CONSTRAINT ${recovery}_pkey`);
  return insert(f,recovery,{...row,incident_id:(await seed(f))['incident_id']});
 }},
);
async function progressRow(f: Fixture): Promise<Row> {
 const row=await seed(f);await insert(f,recovery,row);
 return {workspace_id:row['workspace_id'],recovery_id:row['id'],mailbox_id:row['mailbox_id'],generation:1,forward_cutoff_at:'2026-10-02',window_from_at:'2026-10-02'};
}
for (const [suffix, patch] of Object.entries({
 generation_check:{generation:0}, revision_check:{revision:0}, state_check:{state:'sending'}, next_page_token_check:{next_page_token:'',window_to_at:'2026-10-03'},
 check:{observed_metadata:1}, coded_reason_check:{coded_reason:'invalid'},
 check1:{window_from_at:'2026-10-01'}, check2:{window_to_at:'2026-10-01'}, check3:{next_page_token:'page'},
 workspace_id_recovery_id_mailbox_fkey:{generation:2},
})) CRM_CAPTURE_READ_CONSTRAINT_CASES.push({constraint:`${progress}_${suffix}`,run:async f=>insert(f,progress,{...await progressRow(f),...patch})});
CRM_CAPTURE_READ_CONSTRAINT_CASES.push({constraint:`${progress}_visited_messages_check`,run:async f=>{
 const row=await progressRow(f);
 // Nonnegative observed_metadata <= visited_messages also implies this bound.
 // Isolate the independently enforced visited bound in the rolled-back fixture.
 await f.session.query(`ALTER TABLE ${progress} DROP CONSTRAINT ${progress}_check`);
 return insert(f,progress,{...row,visited_messages:-1});
}});
CRM_CAPTURE_READ_CONSTRAINT_CASES.push({constraint:`${progress}_pkey`,run:async f=>{const row=await progressRow(f);await insert(f,progress,row);return insert(f,progress,row);}});
