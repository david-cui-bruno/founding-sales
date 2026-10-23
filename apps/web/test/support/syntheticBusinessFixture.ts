import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createTestDatabase, CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { createFirm } from '@fss/domain/crm/firms.ts';
import { createContact } from '@fss/domain/crm/contacts.ts';
import { recordMessage, storeMessageBody } from '@fss/domain/mail/messages.ts';
import { recordMatches } from '@fss/domain/mail/matching.ts';
import { setProspectingAuthorization } from '@fss/domain/outreach/authorization.ts';
import { reserveLocalBrowserDatabase } from './database.ts';

const address = z.email().refine(value => value.endsWith('@example.com'));
const message = z.object({ id: z.string().regex(/^SYN-[A-D]-0[1-4]$/u), direction: z.enum(['inbound', 'outbound']), from: address, to: z.array(address), sentAt: z.string(), subject: z.string().startsWith('[SYNTHETIC DEMO]'), body: z.string() });
// Deliberately strips expected: oracle prose never becomes observed product input.
export const syntheticCorpusSchema = z.object({ provenance: z.literal('synthetic-demo-only'), cases: z.array(z.object({ id: z.enum(['A', 'B', 'C', 'D']), title: z.string(), firm: z.string(), participants: z.array(z.object({ name: z.string(), email: address, role: z.string() })), messages: z.array(message).length(4) })).length(4) });
export type SyntheticCase = z.infer<typeof syntheticCorpusSchema>['cases'][number];

/** A local domain-only fixture. No auth/provider stub, browser, inference or send port. */
export async function startSyntheticBusiness() {
  const release = await reserveLocalBrowserDatabase();
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    database = await createTestDatabase();
    const db = database.session;
    const storagePath = (await db.query<{ data_directory: string }>('SHOW data_directory')).rows[0]!.data_directory;
    const postgresPid = Number((await readFile(join(storagePath, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    const resources = { storagePath, postgresPid, database: database.name, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], browser: 'not used', sendingEnabled: false };
    console.log('SYNTHETIC_BUSINESS_OWNED', JSON.stringify(resources));
    const workspaceId = (await db.query<{ id: string }>("INSERT INTO workspaces(slug,display_name) VALUES($1,'Synthetic business demonstration only') RETURNING id", [`synthetic-${randomUUID()}`])).rows[0]!.id;
    const userId = (await db.query<{ id: string }>("INSERT INTO users(google_sub,email,display_name) VALUES($1,'evan.alder@example.com','Evan Alder (invented)') RETURNING id", [`synthetic-${randomUUID()}`])).rows[0]!.id;
    await db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, userId]);
    const ctx = repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'admin' }), db);
    const mailboxId = (await db.query<{ id: string }>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,sync_state,history_id,history_id_updated_at,baseline_from_at,baseline_completed_at,coverage_watermark_at) VALUES($1,$2,'evan.alder@example.com','synthetic-demo-only','ready','1000',now(),now()-interval '30 days',now(),now()) RETURNING id", [workspaceId, userId])).rows[0]!.id;
    // Fixture-only source access. This is not sending enablement or owner consent evidence.
    const authorized = await withTransaction(db, () => setProspectingAuthorization(ctx, { mailboxId, expectedRevision: 0, enabled: true, basis: 'owner_reported_google_permission' }));
    assert.equal(authorized.ok, true);
    return {
      db, ctx, workspaceId, userId, mailboxId, resources,
      seed: async (input: SyntheticCase) => {
        const firm = await withTransaction(db, () => createFirm(ctx, { name: input.firm, regionCode: 'NY', assignedUserId: userId, researchAlreadyQualified: true }));
        assert(firm.ok, JSON.stringify(firm));
        const person = input.participants[0]!;
        const contact = await withTransaction(db, () => createContact(ctx, { firmId: firm.value.id, fullName: person.name }));
        assert(contact.ok, JSON.stringify(contact));
        await db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','synthetic-demo-only')", [workspaceId, firm.value.id, contact.value.id, person.email]);
        const sourceIds: Record<string, string> = {};
        for (const source of input.messages) {
          const recorded = await withTransaction(db, () => recordMessage(ctx, { mailboxId, metadata: { providerMessageId: source.id, providerThreadId: `synthetic-${input.id}`, rfcMessageId: `${source.id}@example.com`, direction: source.direction === 'inbound' ? 'incoming' : 'outgoing', internalDate: source.sentAt, headerFrom: source.from, headerTo: source.to, headerCc: [], subject: source.subject, referenceMessageIds: [], inReplyTo: null, autoSubmitted: null, listId: null, labelIds: [], attachments: [] } }));
          sourceIds[source.id] = recorded.message.id;
          await withTransaction(db, () => recordMatches(ctx, { messageId: recorded.message.id, candidates: [{ firmId: firm.value.id, contactId: contact.value.id, opportunityId: null, rule: 'participant', viaClosedOpportunity: false }] }));
          await withTransaction(db, () => storeMessageBody(ctx, { messageId: recorded.message.id, text: source.body, truncated: false }));
        }
        const latestInbound = input.messages.filter(value => value.direction === 'inbound').at(-1)!;
        return { firmId: firm.value.id, contactId: contact.value.id, recipient: person.email, sourceIds, messageId: sourceIds[latestInbound.id]! };
      },
      stop: async () => {
        try { await database!.drop(); }
        finally { await release(); }
        await access(storagePath).then(() => { throw new Error('Owned cluster directory remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        assert.throws(() => process.kill(postgresPid, 0), { code: 'ESRCH' });
        assert.equal(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE], undefined);
        assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE], undefined);
        console.log('SYNTHETIC_BUSINESS_OWNED_PID_DIRECTORY_DATABASE_TEMPLATE_ABSENT');
      },
    };
  } catch (error) {
    try { await database?.drop(); } finally { await release(); }
    throw error;
  }
}
