import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboundStatusResponseSchema, wireDrift } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  type AuthFixture,
} from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The four admin surfaces of at-most-once sending, through the real dispatcher.
 *
 * The rules are tested against a real PostgreSQL in `@fss/domain/outbound`. What is
 * proved here is the wiring, and three parts of it have been wrong in other systems:
 *
 *   * a salesperson cannot reach any of them, and learns nothing by trying;
 *   * the authentication gate refuses to open on an incomplete checklist, so 12.7's
 *     "SPF, DKIM, and DMARC must pass before automated sending is enabled" cannot be
 *     satisfied by a client that simply asks twice;
 *   * a cap raise above 75 is refused rather than silently clamped.
 */
describe('the outbound admin routes', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const DOMAIN = 'sending.example.test';

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    await fixture.db.query(
      "INSERT INTO sending_domains (workspace_id, domain, is_primary) VALUES ($1, $2, true)",
      [fixture.alpha.workspaceId, DOMAIN],
    );
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every outbound path without a session and to a salesperson', async () => {
    for (const path of [
      '/outbound/resolve',
      '/outbound/authentication',
      '/outbound/cap',
      '/outbound/domain',
      '/outbound/status',
    ]) {
      expect((await post(path, null, command())).status, path).toBe(401);
      const forbidden = await post(path, salespersonToken, command());
      expect(forbidden.status, path).toBe(403);
      // Nothing about what exists on the other side.
      expect(JSON.stringify(forbidden.body)).not.toContain(DOMAIN);
    }
  });

  it('12.7: records the admin checklist and refuses to enable sending on an incomplete one', async () => {
    const partial = await post(
      '/outbound/authentication',
      adminToken,
      command({
        domain: DOMAIN,
        spfPass: true,
        dkimPass: true,
        dmarcPass: false,
        postmasterReviewed: true,
        automatedSendingEnabled: true,
      }),
    );
    // 409: the request was well formed and the state of the world refused it.
    expect(partial.status).toBe(409);
    expect(partial.body['status']).toBe('refused');
    expect(partial.body['reason']).toBe('authentication_incomplete');

    const complete = await post(
      '/outbound/authentication',
      adminToken,
      command({
        domain: DOMAIN,
        spfPass: true,
        dkimPass: true,
        dmarcPass: true,
        postmasterReviewed: true,
        automatedSendingEnabled: true,
      }),
    );
    expect(complete.status).toBe(200);
    const result = complete.body['result'] as Record<string, unknown>;
    expect(result['authenticationPasses']).toBe(true);
    expect(result['automatedSendingEnabled']).toBe(true);
    // 12.6's guard is reported, not invented by the client.
    expect(result['personalGmailGuardPer24h']).toBe(4000);
  });

  it('12.7: closes the gate again the moment a leg of the checklist stops passing', async () => {
    const regressed = await post(
      '/outbound/authentication',
      adminToken,
      command({
        domain: DOMAIN,
        spfPass: true,
        dkimPass: false,
        dmarcPass: true,
        postmasterReviewed: true,
        automatedSendingEnabled: false,
      }),
    );
    const result = regressed.body['result'] as Record<string, unknown>;
    expect(result['automatedSendingEnabled']).toBe(false);

    // Put it back for the tests that follow.
    await post(
      '/outbound/authentication',
      adminToken,
      command({
        domain: DOMAIN,
        spfPass: true,
        dkimPass: true,
        dmarcPass: true,
        postmasterReviewed: true,
        automatedSendingEnabled: true,
      }),
    );
  });

  it('12.7: refuses a raise above 75 rather than clamping it', async () => {
    const mailbox = await fixture.db.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId, `sales.cap@${fixture.hostedDomain}`],
    );
    const mailboxId = mailbox.rows[0]?.id ?? '';

    const tooHigh = await post('/outbound/cap', adminToken, command({ mailboxId, raiseTo: 90 }));
    expect(tooHigh.status).toBe(409);
    expect(tooHigh.body['status']).toBe('refused');
    expect(tooHigh.body['reason']).toBe('raise_above_limit');

    const raised = await post('/outbound/cap', adminToken, command({ mailboxId, raiseTo: 75 }));
    expect((raised.body['result'] as { effectiveCap: number }).effectiveCap).toBe(75);

    // And lowering wins over the raise, because an incident is today.
    const lowered = await post('/outbound/cap', adminToken, command({ mailboxId, raiseTo: 75, lowerTo: 5 }));
    expect((lowered.body['result'] as { effectiveCap: number }).effectiveCap).toBe(5);
  });

  it('12.5: refuses to resolve a fence that is not unknown_terminal', async () => {
    const refused = await post(
      '/outbound/resolve',
      adminToken,
      command({ outboundMessageId: randomUUID(), resolution: 'delivered' }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['status']).toBe('refused');
    expect(refused.body['reason']).toBe('fence_not_ready');
  });

  it('reports the domain, the guard headroom and the doubt, and no message content', async () => {
    const status = await post('/outbound/status', adminToken, {});
    expect(status.status).toBe(200);
    // The whole answer, in the shape `@fss/contracts` declares since lane g78.
    expect(wireDrift(outboundStatusResponseSchema, status.body)).toEqual([]);
    const body = status.body as {
      domain: { domain: string; automatedSendingEnabled: boolean };
      guard: { guard: number; headroom: number; applies: boolean };
      doubt: { reconciling: number; unresolvedTerminal: number };
    };
    expect(body.domain.domain).toBe(DOMAIN);
    expect(body.guard.guard).toBe(4000);
    expect(body.guard.applies).toBe(true);
    expect(body.doubt.reconciling).toBe(0);
    expect(body.doubt.unresolvedTerminal).toBe(0);
    // Appendix F: an operational view carries no subject and no body.
    expect(JSON.stringify(body)).not.toContain('subject');
  });
});
