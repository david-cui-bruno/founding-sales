import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE, followUpPermissionsResponseSchema } from '@fss/contracts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm, seedFollowUpPermission } from './support/crmSeed.ts';
import { DESKTOP_VERSION_UNDER_TEST, routeAnswer } from './support/wireThrough.ts';

/**
 * Who the follow-up permission endpoints answer, and who may write one
 * (migration 0025; P1-5 of the GPT-6 review of PR 332).
 *
 * The review found the list route answering for the whole workspace whenever no firm id
 * was supplied — a wider read than the same caller gets from the firm page, which is the
 * read this one belongs beside. And it found grant and revoke authorized against an
 * unlocked `readFirm` in the route, which a reassignment committing between the check
 * and the write walks straight through.
 *
 * So there are two properties here: a salesperson's list mentions only the firms they are
 * assigned, and the authorization that matters is the domain's, taken under the firm's
 * row lock inside the command's own transaction.
 */
describe('the follow-up permission endpoints', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let minePermissionId = '';
  let theirsPermissionId = '';
  let myFirmId = '';

  const command = (extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    commandId: randomUUID(),
    clientVersion: DESKTOP_VERSION_UNDER_TEST,
    ...extra,
  });

  const post = async (path: string, token: string, body: Readonly<Record<string, unknown>>) =>
    await routeAnswer(fixture, 'POST', path, token, body);

  /** A firm assigned to `assignee`, with one person and one evidenced permission. */
  async function firmWithPermission(name: string, assignedUserId: string): Promise<{ firmId: string; permissionId: string }> {
    const firmId = await seedFirm(fixture, { name, regionCode: 'RI', postalCode: '02903', assignedUserId });
    const contactId = await seedContact(fixture, { firmId, fullName: 'Kim Placeholder' });
    const sequenceVersionId = await publishedVersion();
    const permissionId = await seedFollowUpPermission(fixture, { firmId, contactId, sequenceVersionId });
    return { firmId, permissionId };
  }

  /** One published one-step version, which is what an `agreed_sequence` call agrees to. */
  async function publishedVersion(): Promise<string> {
    const result = (answer: { body: unknown }): Record<string, unknown> =>
      ((answer.body as { result?: unknown }).result ?? {}) as Record<string, unknown>;
    const template = await post(
      '/templates/create',
      adminToken,
      command({
        name: `Follow up ${randomUUID().slice(0, 8)}`,
        subject: 'A question about {firm_name}',
        body: `Hello {contact_first_name},\n\nA note about {firm_name}.\n\nSam Example\nCallie\n${SENDING_STOP_LINE}`,
        footerSignOff: 'Sam Example\nCallie',
        requiredVariables: ['firm_name', 'contact_first_name'],
        approve: true,
      }),
    );
    expect(template.status, JSON.stringify(template.body)).toBe(200);
    const templateVersionId = String(result(template)['id']);
    const sequence = await post('/sequences/create', adminToken, command({ name: `Agreed ${randomUUID().slice(0, 8)}` }));
    const draft = await post(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId: String(result(sequence)['id']),
        steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId }],
      }),
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const sequenceVersionId = String(result(draft)['sequenceVersionId']);
    const published = await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId }));
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    return sequenceVersionId;
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;

    const mine = await firmWithPermission('Northwind Test Holdings', fixture.alpha.salesperson.userId);
    myFirmId = mine.firmId;
    minePermissionId = mine.permissionId;
    theirsPermissionId = (await firmWithPermission('Rowan Test Partners', fixture.alpha.admin.userId)).permissionId;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('answers a salesperson only about the firms they are assigned, with no firm id supplied', async () => {
    const answer = await post('/follow-up-permissions/list', salespersonToken, {});
    expect(answer.status).toBe(200);
    const parsed = followUpPermissionsResponseSchema.safeParse(answer.body);
    expect(parsed.success, JSON.stringify(answer.body)).toBe(true);
    const ids = (parsed.data?.permissions ?? []).map(permission => permission.id);
    expect(ids).toContain(minePermissionId);
    expect(ids).not.toContain(theirsPermissionId);
  });

  it('answers an administrator about the whole workspace, which is their read everywhere else', async () => {
    const answer = await post('/follow-up-permissions/list', adminToken, {});
    expect(answer.status).toBe(200);
    const parsed = followUpPermissionsResponseSchema.safeParse(answer.body);
    const ids = (parsed.data?.permissions ?? []).map(permission => permission.id);
    expect(ids).toEqual(expect.arrayContaining([minePermissionId, theirsPermissionId]));
  });

  it('says nothing about a firm the caller is not assigned, even when they name it', async () => {
    const theirFirm = await post('/follow-up-permissions/list', salespersonToken, {
      firmId: (await fixture.db.query<{ firm_id: string }>(
        'SELECT firm_id FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
        [fixture.alpha.workspaceId, theirsPermissionId],
      )).rows[0]?.firm_id,
    });
    expect(theirFirm.status).toBe(404);
  });

  it('refuses a grant naming two pieces of evidence, before the domain is asked', async () => {
    const answer = await post(
      '/follow-up-permissions',
      salespersonToken,
      command({
        firmId: myFirmId,
        contactId: (await fixture.db.query<{ contact_id: string }>(
          'SELECT contact_id FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
          [fixture.alpha.workspaceId, minePermissionId],
        )).rows[0]?.contact_id,
        callLogId: randomUUID(),
        mailMessageId: randomUUID(),
      }),
    );
    expect(answer.status).toBe(409);
    expect((answer.body as { reason?: string }).reason).toBe('invalid_input');
  });

  it('refuses a revoke by a salesperson the firm is not assigned to', async () => {
    const answer = await post(
      '/follow-up-permissions/revoke',
      salespersonToken,
      command({ permissionId: theirsPermissionId }),
    );
    expect(answer.status).toBe(409);
    expect((answer.body as { reason?: string }).reason).toBe('not_assigned');
  });
});
