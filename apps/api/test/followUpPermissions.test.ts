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

  /** One approved template version, which is what a call may promise. */
  async function approvedTemplate(): Promise<string> {
    const result = (answer: { body: unknown }): Record<string, unknown> =>
      ((answer.body as { result?: unknown }).result ?? {}) as Record<string, unknown>;
    const template = await post(
      '/templates/create',
      adminToken,
      command({
        name: `Overview ${randomUUID().slice(0, 8)}`,
        subject: 'A question about {firm_name}',
        body: `Hello {contact_first_name},\n\nA note about {firm_name}.\n\nSam Example\nCallie\n${SENDING_STOP_LINE}`,
        footerSignOff: 'Sam Example\nCallie',
        requiredVariables: ['firm_name', 'contact_first_name'],
        approve: true,
      }),
    );
    expect(template.status, JSON.stringify(template.body)).toBe(200);
    return String(result(template)['id']);
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

  it('applies the assignee rule in the query, so a reassignment cannot expose rows', async () => {
    // P1-5 of the second review. The firm id used to skip the assignee predicate: the
    // route read the firm, decided, and then queried the whole firm. A reassignment
    // committing between those two reads exposed the rows. Here the firm is assigned to
    // the salesperson when the list is asked and to somebody else in the database, which
    // is the state that race produces — and the answer is empty.
    const firmId = (await fixture.db.query<{ firm_id: string }>(
      'SELECT firm_id FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, minePermissionId],
    )).rows[0]?.firm_id;
    await fixture.db.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
      fixture.alpha.workspaceId,
      firmId,
      fixture.alpha.admin.userId,
    ]);
    try {
      const answer = await post('/follow-up-permissions/list', salespersonToken, { firmId });
      // Either answer is safe; what must never happen is 200 with the firm's rows.
      const permissions = (answer.body as { permissions?: readonly { id: string }[] }).permissions ?? [];
      expect(permissions.map(permission => permission.id)).not.toContain(minePermissionId);
    } finally {
      await fixture.db.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
        fixture.alpha.workspaceId,
        firmId,
        fixture.alpha.salesperson.userId,
      ]);
    }
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

  it('records a call agreement end to end: the command, the call log, and the permission', async () => {
    // The second review of PR 332 found this path disconnected: the route parsed
    // `followUpPermission` and dropped it, and neither the form nor the contract carried
    // the template version `logCallOutcome` needs. What a person promises on a call is
    // approved bytes, and the log is where the agreement lives.
    const templateVersionId = await approvedTemplate();
    const firmId = await seedFirm(fixture, {
      name: 'Cedar Test Advisers',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    const logged = await post(
      '/calls/log',
      salespersonToken,
      command({
        firmId,
        contactId,
        outcome: 'interested',
        followUpPermission: { scope: 'single_email', templateVersionId },
      }),
    );
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);

    // The log records what was agreed…
    const { rows: log } = await fixture.db.query<{
      id: string;
      agreed_follow_up: string | null;
      agreed_template_version_id: string | null;
    }>(
      `SELECT id, agreed_follow_up, agreed_template_version_id FROM call_logs
        WHERE workspace_id = $1 AND firm_id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );
    expect(log).toHaveLength(1);
    expect(log[0]?.agreed_follow_up).toBe('single_email');
    expect(log[0]?.agreed_template_version_id).toBe(templateVersionId);

    // …and the permission rests on that log, for that person, with those bytes.
    const { rows: permission } = await fixture.db.query<{
      scope: string;
      contact_id: string;
      call_log_id: string | null;
      template_version_id: string | null;
      max_steps: number | null;
    }>(
      `SELECT scope, contact_id, call_log_id, template_version_id, max_steps
         FROM follow_up_permissions WHERE workspace_id = $1 AND firm_id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );
    expect(permission).toHaveLength(1);
    expect(permission[0]).toMatchObject({
      scope: 'single_email',
      contact_id: contactId,
      call_log_id: log[0]?.id,
      template_version_id: templateVersionId,
      max_steps: 1,
    });
  });

  it('refuses a call agreement on an outcome that agreed to nothing', async () => {
    const templateVersionId = await approvedTemplate();
    const firmId = await seedFirm(fixture, {
      name: 'Birch Test Partners',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const contactId = await seedContact(fixture, { firmId, fullName: 'Robin Example' });
    // "Call me Tuesday" is a callback task and grants no e-mail permission, whatever the
    // client sends (David, 29 September 2026).
    const logged = await post(
      '/calls/log',
      salespersonToken,
      command({
        firmId,
        contactId,
        outcome: 'callback_requested',
        callback: { localDate: '2026-10-06', localTime: '09:00', sourceTimeZone: 'America/New_York' },
        followUpPermission: { scope: 'single_email', templateVersionId },
      }),
    );
    expect(logged.status).toBe(409);
    expect(
      (await fixture.db.query('SELECT 1 FROM follow_up_permissions WHERE workspace_id = $1 AND firm_id = $2', [
        fixture.alpha.workspaceId,
        firmId,
      ])).rows,
    ).toHaveLength(0);
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
