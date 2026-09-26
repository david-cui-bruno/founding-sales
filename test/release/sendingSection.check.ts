import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, mayMutate, outboundStatusResponseSchema, publishedClientVersions, wireDrift } from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../../apps/api/src/bootstrap/main.ts';
import { localNoopSuppressionJournal } from '../../apps/api/src/journal/index.ts';
import { dispatch, type ApiOptions } from '../../apps/api/src/server.ts';
import { createAuthFixture, type AuthFixture } from '../../apps/api/test/support/authFixture.ts';
import { issueSessionFor } from '../../apps/api/test/support/sessionFixture.ts';
import type { HttpAnswer, HttpSend } from '../../apps/desktop/src/main/apiClient.ts';
import { createAuthedClient } from '../../apps/desktop/src/main/authedClient.ts';
import { createAdminBridge } from '../../apps/desktop/src/main/settingsBridge.ts';
import { adminViewOf } from '../../apps/desktop/src/renderer/settingsView.ts';
import { outboundRampAnswer, outboundStatusAnswer } from '../../apps/desktop/test/support/outboundStatus.ts';

/**
 * Administration's "Sending domain and caps" reads what the API sends (release.md 8.0ae;
 * lane g69).
 *
 * From desktop 1.0.2 to 1.0.3 the section never rendered for anybody. `POST
 * /outbound/status` answers `personalGmailRecipients` as `{ automated, direct, total }`
 * (`personalGmailRecipientsInWindow` in `packages/domain/outbound/domainGuard.ts`, passed
 * through by `apps/api/src/routes/outbound.ts`), and the desktop parsed it as
 * `z.number()`. Every answer was `unreadable_answer`, the bridge kept nothing, the
 * section was absent, and Home's sidebar said "Domain not read". Nothing was logged: the
 * API had answered 200. The desktop's unit fixture said `personalGmailRecipients: 1` —
 * the same wrong number as the parser — so its suite was green the whole time.
 *
 * The API and the desktop are two packages with no schema between them for this route,
 * so this check is the place both are real at once: the real route over a real database
 * and a real session, into the real desktop bridge and view.
 *
 * ## The vacuous-pass traps, named
 *
 * **A fixture that agrees with the parser.** That is the defect itself. Closed twice:
 * the route's own answer goes through the desktop's own parser here, and the desktop's
 * unit fixture (`apps/desktop/test/support/outboundStatus.ts`) is held to the route's
 * answer key for key and type for type, so the unit suite cannot drift back into
 * agreeing with itself either.
 *
 * **A posture read that never reaches the per-mailbox ramps.** The ramp comes from a
 * second read, per mailbox, whose ids come from `/diagnostics`. A seeded mailbox with a
 * ramp row makes the section's ramp line exist only if both reads parsed.
 *
 * **A build the API refuses.** The fix ships in desktop 1.0.4, and a client above the
 * API's published maximum is refused every sign-in, renewal and command.
 */

const FIRST_VERSION_WITH_THE_FIX = '1.0.4';
const DOMAIN = 'sending.example.test';

/** A value's shape: every key, sorted, down to the type of each leaf. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, shapeOf(entry)]),
    );
  }
  return typeof value;
}

describe('8.0ae: the sending section parses the API’s own answer (lane g69)', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let noDomainToken: string;
  let mailboxId: string;
  const options = (): ApiOptions => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  /** The desktop's transport, bound to the real dispatcher instead of a socket. */
  const through = (calls: string[]): HttpSend => async (url, init) => {
    const parsed = new URL(url);
    calls.push(`${init.method} ${parsed.pathname}`);
    const result = await dispatch(
      {
        method: init.method,
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: init.headers,
        body: init.body === undefined ? undefined : (JSON.parse(init.body) as Readonly<Record<string, unknown>>),
      },
      options(),
    );
    // What a socket would carry: the body as JSON, so a Date is a string here as it is there.
    const answer: HttpAnswer = { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) };
    return answer;
  };

  const bridgeFor = (token: string, calls: string[] = []) =>
    createAdminBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: FIRST_VERSION_WITH_THE_FIX,
        accessToken: async () => await Promise.resolve(token),
        send: through(calls),
      }),
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
    });

  /** One `/outbound/status` answer, straight from the route. */
  const statusAnswer = async (token: string, body: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const answer = await through([])('https://api.example.test/outbound/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(answer.status).toBe(200);
    return answer.body;
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    noDomainToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin, { deviceLabel: 'Beta Mac' })).accessToken;
    const workspaceId = fixture.alpha.workspaceId;
    await fixture.db.query('INSERT INTO sending_domains (workspace_id, domain, is_primary) VALUES ($1, $2, true)', [
      workspaceId,
      DOMAIN,
    ]);
    const mailbox = await fixture.db.query<{ id: string }>(
      'INSERT INTO mailboxes (workspace_id, owner_user_id, email_address) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, fixture.alpha.salesperson.userId, `sales.g69@${fixture.hostedDomain}`],
    );
    mailboxId = mailbox.rows[0]?.id ?? '';
    await fixture.db.query('INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id) VALUES ($1, $2)', [workspaceId, mailboxId]);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('renders the section from the real route’s answer: the checklist and the mailbox’s ramp', async () => {
    const calls: string[] = [];
    const state = await bridgeFor(adminToken, calls).state();

    expect(calls).toEqual(expect.arrayContaining(['POST /outbound/status', 'GET /diagnostics']));
    expect(state.sendingReadError).toBeNull();
    expect(state.sendingAdmin?.domain?.domain).toBe(DOMAIN);
    expect(state.sendingAdmin?.ramps.map(ramp => [ramp.mailboxId, ramp.effectiveCap])).toEqual([[mailboxId, 5]]);

    const view = adminViewOf(state);
    expect(view.sendingUnread).toBeNull();
    expect(view.sendingAdmin?.domainLine).toBe(`${DOMAIN}: authentication incomplete — still needed: spf, dkim, dmarc, postmaster review.`);
    expect(view.sendingAdmin?.ramps.map(ramp => ramp.line)).toEqual(['0 healthy days, cap 5.']);
  });

  it('renders "No sending domain is configured." for a workspace without one, rather than nothing', async () => {
    const state = await bridgeFor(noDomainToken).state();
    expect(state.sendingReadError).toBeNull();
    expect(adminViewOf(state).sendingAdmin?.domainLine).toBe('No sending domain is configured.');
  });

  it('holds the desktop’s unit fixture to the route: the same keys, the same types, all the way down', async () => {
    const plain = await statusAnswer(adminToken, {});
    expect(wireDrift(outboundStatusResponseSchema, plain)).toEqual([]);
    expect(shapeOf(plain)).toEqual(shapeOf(outboundStatusAnswer()));

    const named = await statusAnswer(adminToken, { mailboxId });
    expect(wireDrift(outboundStatusResponseSchema, named)).toEqual([]);
    expect(shapeOf(named)).toEqual(shapeOf(outboundStatusAnswer({ ramp: outboundRampAnswer(mailboxId) })));

    const none = await statusAnswer(noDomainToken, {});
    expect(wireDrift(outboundStatusResponseSchema, none)).toEqual([]);
    expect(shapeOf(none)).toEqual(shapeOf(outboundStatusAnswer({ domain: null })));
  });

  it('is a build the deployed API accepts', () => {
    expect(compareVersions(publishedClientVersions(CONTAINER_CLIENT_VERSIONS).maximum, FIRST_VERSION_WITH_THE_FIX)).toBeGreaterThanOrEqual(0);
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, FIRST_VERSION_WITH_THE_FIX)).toBe(true);
    // The installed builds keep working until they take the update.
    expect(CONTAINER_CLIENT_VERSIONS.minimum).toBe('1.0.0');
  });
});
