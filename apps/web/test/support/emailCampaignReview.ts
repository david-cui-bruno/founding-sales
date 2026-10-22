import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EmailCampaignAdmission } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { previewDeletion, commitDeletion } from '@fss/domain/retention/deletion.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import type { ThinHostApp } from './thinHostApp.ts';
import type { QualifiedResearchSeed } from './qualifiedResearchSeed.ts';

/** Ordinary synthetic-data erasure owner, not raw SQL deletion or a new route. */
export async function deleteCampaignSubject(app: ThinHostApp, admission: EmailCampaignAdmission, targetKind: 'contact' | 'firm') {
  const f = app.fixture;
  const context = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const preview = await withTransaction(f.db, async () => previewDeletion(context, {
    targetKind, firmId: admission.firmId, ...(targetKind === 'contact' ? { contactId: admission.contactId } : {}),
  }));
  assert(preview.ok, preview.ok ? '' : preview.reason);
  const journal = recordingSuppressionJournal();
  const committed = await withTransaction(f.db, async () => commitDeletion(context, {
    requestId: preview.value.requestId, previewHash: preview.value.previewHash, commandId: randomUUID(), journal,
  }));
  assert(committed.ok, committed.ok ? '' : committed.reason);
  return committed.value;
}

/** Independent email observation ages out while native citations stay fresh. */
export async function separateExpiringCampaignEmail(app: ThinHostApp, seed: QualifiedResearchSeed, expiresInMs: number) {
  const db = app.fixture.db;
  const row = (await db.query<{ observations: Record<string, unknown>[]; facts: Record<string, unknown>[] }>(
    'SELECT observations,facts FROM sourcing_qualification_runs WHERE id=$1', [seed.selection.runId],
  )).rows[0]!;
  const native = row.observations[0]!;
  const emailId = randomUUID();
  const expiresAt = new Date(Date.now() + expiresInMs);
  const blocks = native['blocks'] as { id: string; text: string }[];
  const email = { ...native, id: emailId, blocks: blocks.filter(block => block.id === 'email'), retrievedAt: new Date(expiresAt.getTime() - 7 * 86400000).toISOString() };
  const observations = [{ ...native, blocks: blocks.filter(block => block.id !== 'email') }, email];
  const facts = row.facts.map(fact => fact['kind'] === 'business_email' ? { ...fact, observationId: emailId } : fact);
  await db.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,facts=$3::jsonb WHERE id=$1', [seed.selection.runId, JSON.stringify(observations), JSON.stringify(facts)]);
  return { expiresAt, emailId, nativeRetrievedAt: native['retrievedAt'] };
}

/** Real PostgreSQL wait at a product write, never an injected clock or query result.
 * Only an owned disposable database is altered and the trigger is always removed. */
export async function delayCampaignWrite(app: ThinHostApp, table: 'outreach_email_campaigns' | 'outreach_email_campaign_admissions') {
  const db = app.fixture.db;
  await db.query("CREATE FUNCTION campaign_review_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END; $$");
  await db.query(`CREATE TRIGGER campaign_review_wait BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION campaign_review_wait()`);
  return async () => {
    await db.query(`DROP TRIGGER campaign_review_wait ON ${table}`);
    await db.query('DROP FUNCTION campaign_review_wait()');
  };
}
