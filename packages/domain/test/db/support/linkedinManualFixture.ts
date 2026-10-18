import { randomUUID } from 'node:crypto';
import type { RepositoryContext } from '../../../db/workspaceScope.ts';
import { createPerson, addSelectedSource, readPerson } from '../../../crm/people.ts';
import { saveRelationship } from '../../../crm/relationships.ts';
import { claimEndpoint } from '../../../crm/endpoints.ts';
import { registerSocialManualDestination } from '../../../social/manualDestination.ts';

/** Synthetic owner assertions built through the existing public CRM functions. */
export async function seedManualLinkedin(context: RepositoryContext, firmId: string) {
  const person = await createPerson(context, 'Sam Example');
  if (!person.ok || !person.value.personId) throw new Error('person fixture');
  const personId = person.value.personId;
  await addSelectedSource(context, { personId, sourceKey: randomUUID(), excerpt: 'Owner selected synthetic profile and firm relationship.', occurredAt: '2026-10-01T12:00:00.000Z' });
  const source = (await readPerson(context, personId))!.sources[0]!;
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash! };
  const envelope = { commandId: randomUUID(), clientVersion: '1.0.51' };
  const relationship = await saveRelationship(context, { ...envelope, personId, firmId, status: 'current', startDate: null, endDate: null, evidence });
  if (!relationship.ok || !relationship.value.relationshipId) throw new Error('relationship fixture');
  const endpoint = await claimEndpoint(context, { ...envelope, personId, firmId: null, kind: 'linkedin', value: `https://www.linkedin.com/in/synthetic-${randomUUID()}`, shared: false, status: 'current', startDate: null, endDate: null, evidence });
  if (!endpoint.ok || !endpoint.value.claimId) throw new Error('endpoint fixture');
  const accountId = randomUUID();
  const account = await registerSocialManualDestination(context, { accountId, platform: 'linkedin', accountKind: 'profile', externalId: `synthetic-${accountId}`, displayName: 'Owner manual account' });
  if (!account.ok) throw new Error('account fixture');
  return { ledgerId: randomUUID(), accountId, personId, firmId, claimId: endpoint.value.claimId, claimRevision: 1, relationshipId: relationship.value.relationshipId, relationshipRevision: 1 };
}
