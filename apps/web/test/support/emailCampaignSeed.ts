import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EmailCampaignPolicy } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { setProspectingAuthorization } from '@fss/domain/outreach/authorization.ts';
import { createTemplateVersion } from '@fss/domain/templates/templates.ts';
import { createSequence, createDraftVersion, publishVersion } from '@fss/domain/sequences/definitions.ts';
import { recordStatePosture } from '@fss/domain/policy/postures.ts';
import { POSTURE_STATEMENTS } from '@fss/domain/src/rules/statePosture.ts';
import type { ThinHostApp } from './thinHostApp.ts';
export { seedQualifiedResearch as seedCampaignResearch } from './qualifiedResearchSeed.ts';

/** Local synthetic content preparation, not live mailbox permission or campaign approval.
 * The campaign itself is approved only through the actual signed browser session. */
export async function seedEmailCampaign(app: ThinHostApp, overrides: Partial<EmailCampaignPolicy> = {}) {
  const f = app.fixture;
  const context = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const tx = <T>(work: () => Promise<T>) => withTransaction(f.db, work);
  const mailboxId = (await f.db.query<{ id: string }>(
    "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING id",
    [f.alpha.workspaceId, f.alpha.admin.userId, `campaign-${randomUUID()}@example.test`, `local-campaign-${randomUUID()}`],
  )).rows[0]!.id;
  const authorization = await tx(() => setProspectingAuthorization(context, { mailboxId, expectedRevision: 0, enabled: true, basis: 'owner_reported_google_permission' }));
  assert(authorization.ok, authorization.ok ? '' : authorization.reason);
  const templateIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const template = await tx(() => createTemplateVersion(context, {
      name: `Controlled campaign touch ${String(index + 1)}`, subject: 'A question about {firm_name}',
      body: 'Hello,\n\nA controlled local example for {firm_name}.\n\nSam Example\nCallie',
      footer: { signOff: 'Sam Example\nCallie' }, requiredVariables: ['firm_name'], approve: true,
    }));
    assert(template.ok, template.ok ? '' : template.reason);
    templateIds.push(template.value.id);
  }
  const sequence = await tx(() => createSequence(context, { name: `Controlled campaign ${randomUUID()}` }));
  assert(sequence.ok, sequence.ok ? '' : sequence.reason);
  const version = await tx(() => createDraftVersion(context, { sequenceId: sequence.value.id,
    steps: templateIds.map((templateVersionId, index) => ({ ordinal: index + 1, channel: 'email', delay: { unit: 'elapsed', hours: [0, 72, 168, 312, 480][index]! }, templateVersionId })),
  }));
  assert(version.ok, version.ok ? '' : version.reason);
  const published = await tx(() => publishVersion(context, { sequenceVersionId: version.value.sequenceVersionId }));
  assert(published.ok, published.ok ? '' : published.reason);
  const posture = await tx(() => recordStatePosture(context, { state: 'TX', effectiveFrom: new Date(Date.now() - 60_000).toISOString(), confirmedStatements: Object.keys(POSTURE_STATEMENTS) }));
  assert(posture.ok, posture.ok ? '' : posture.reason);
  const policy: EmailCampaignPolicy = { mailboxId, authorizationRevision: authorization.value.revision, sequenceVersionId: version.value.sequenceVersionId,
    regions: ['TX'], maxEnrollments: 25, dailyAdmissionLimit: 5, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...overrides };
  return { policy, templateIds, context };
}
