import { randomUUID } from 'node:crypto';
import type { AuthFixture } from '../../../api/test/support/authFixture.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordMessage, storeMessageBody } from '@fss/domain/mail/messages.ts';
import { recordMatches } from '@fss/domain/mail/matching.ts';
import { saveAnswerBlock, approveAnswerBlock } from '@fss/domain/outreach/facts.ts';
import { promoteReply } from '@fss/domain/today/promotions.ts';
import { setProspectingAuthorization } from '@fss/domain/outreach/authorization.ts';

/** Canonical API replyComposer conversation seed, using the actual fixture member.
 * No fabricated principal, capture, provider or outbound operation is involved. */
export async function seedReplyBrief(f: AuthFixture, firmId: string) {
  const owner = f.alpha.salesperson.userId;
  const workspaceId = f.alpha.workspaceId;
  const address = `owner-${randomUUID()}@example.test`;
  const recipient = `prospect-${randomUUID()}@example.test`;
  const ctx = repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId: owner, role: 'salesperson' }), f.db);
  const admin = repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const existing = (await f.db.query<{ id: string; email_address: string }>('SELECT id,email_address FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2', [workspaceId, owner])).rows[0];
  const mailbox = existing ?? (await f.db.query<{ id: string; email_address: string }>(`INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,sync_state,history_id,history_id_updated_at,baseline_from_at,baseline_completed_at,coverage_watermark_at) VALUES($1,$2,$3,$3,'ready','1000',now(),now()-interval '30 days',now(),now()) RETURNING id,email_address`, [workspaceId, owner, address])).rows[0]!;
  const contact = (await f.db.query<{ id: string }>('INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,$3) RETURNING id', [workspaceId, firmId, 'Robin Reply Brief Fixture'])).rows[0]!;
  const stage = (await f.db.query<{ id: string }>('SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1', [workspaceId])).rows[0]!;
  const opportunity = (await f.db.query<{ id: string }>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,$3,now()) RETURNING id', [workspaceId, firmId, stage.id])).rows[0]!;
  await f.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','fixture')", [workspaceId, firmId, contact.id, recipient]);
  const auth = (await f.db.query<{ revision: number }>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2', [workspaceId, mailbox.id])).rows[0];
  await withTransaction(f.db, () => setProspectingAuthorization(admin, { mailboxId: mailbox.id, expectedRevision: auth?.revision ?? 0, enabled: true, basis: 'owner_reported_google_permission' }));
  const id = randomUUID();
  const message = await withTransaction(f.db, () => recordMessage(ctx, { mailboxId: mailbox.id, metadata: { providerMessageId: id, providerThreadId: id, rfcMessageId: `${id}@example.test`, direction: 'incoming', internalDate: new Date().toISOString(), headerFrom: recipient, headerTo: [mailbox.email_address], headerCc: [], subject: 'Synthetic preparation question', referenceMessageIds: [], inReplyTo: null, autoSubmitted: null, listId: null, labelIds: [], attachments: [] } }));
  await withTransaction(f.db, () => recordMatches(ctx, { messageId: message.message.id, candidates: [{ firmId, contactId: contact.id, opportunityId: opportunity.id, rule: 'participant', viaClosedOpportunity: false }] }));
  await withTransaction(f.db, () => storeMessageBody(ctx, { messageId: message.message.id, text: 'Could we discuss the synthetic maintenance plan?', truncated: false }));
  await withTransaction(f.db, () => promoteReply(ctx, { firmId, contactId: contact.id, messageId: message.message.id, receivedAt: new Date().toISOString() }));
  const saved = await withTransaction(f.db, () => saveAnswerBlock(admin, { kind: 'product', text: 'Callie helps existing property teams coordinate maintenance requests.' }));
  if (!saved.ok) throw new Error(saved.reason);
  const approved = await withTransaction(f.db, () => approveAnswerBlock(admin, { id: saved.value.id, version: 1 }));
  if (!approved.ok) throw new Error(approved.reason);
  await f.db.query("INSERT INTO firm_prepared_briefs(workspace_id,firm_id,brief,sources,observed_on,prepared_by) VALUES($1,$2,'Robin is the operations lead.\nUses a maintenance portal.\n240 doors.','[]'::jsonb,DATE '2026-09-20','Synthetic partner')", [workspaceId, firmId]);
  const run = await f.db.query<{ id: string }>("INSERT INTO research_runs(workspace_id,firm_id,revision,trigger,completed_at,outcome) VALUES($1,$2,1,'sweep',now(),'completed') RETURNING id", [workspaceId, firmId]);
  const evidence = await f.db.query<{ id: string }>("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash) VALUES($1,$2,'company_page','https://workflow.example.test/maintenance',$3) RETURNING id", [workspaceId, firmId, 'e'.repeat(64)]);
  await f.db.query("INSERT INTO firm_facts(workspace_id,firm_id,run_id,evidence_id,key,block_id,quote,retrieved_at) VALUES($1,$2,$3,$4,'maintenance_workflow','b1','Residents submit requests through the portal.',TIMESTAMPTZ '2026-10-01 12:00:00Z')", [workspaceId, firmId, run.rows[0]!.id, evidence.rows[0]!.id]);
  return { messageId: message.message.id, mailboxId: mailbox.id, contactId: contact.id, recipient, ctx, admin, factRef: { id: saved.value.id, version: 1 } };
}
