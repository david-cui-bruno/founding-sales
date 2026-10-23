import { randomBytes } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { readReplyDraftContext } from '@fss/domain/replies/composer.ts';
import { generateReplyDraft, type HumanReplyDraftPort } from '@fss/domain/replies/composerGeneration.ts';
import { authorizationForMailbox } from '@fss/domain/outreach/authorization.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { QueryResultRowLike } from '@fss/domain/db/queryable.ts';
import { routeReplyComposer } from '../../../api/src/routes/replyComposer.ts';
import type { AuthDeps } from '../../../api/src/auth/config.ts';
import type { RoutingOptions, ApiRequest } from '../../../api/src/routes/types.ts';
import { createBrowserHandler } from '../../src/server/browser.ts';
import { COOKIE_NAMES, sealCookie } from '../../src/server/cookies.ts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { ReplyAttempt, REPLY_PENDING_KEY } from '../../src/client/ReplyAttempt.ts';

// Keep context assembly, mailbox authorization, generation, API and browser/client
// adapters real. Only repository leaf reads, paid ledger and authentication are fixtures.
const seams = vi.hoisted(() => ({ message: vi.fn(), body: vi.fn(), target: vi.fn(), firm: vi.fn(),
  attempt: vi.fn(), reserve: vi.fn(), calling: vi.fn(), settle: vi.fn(), principal: vi.fn(), context: vi.fn(), authenticate: vi.fn(), route: vi.fn() }));
vi.mock('@fss/domain/mail/messages.ts', () => ({ readMessage: seams.message, readMessageBody: seams.body }));
vi.mock('@fss/domain/mail/matching.ts', () => ({ directSendTargetOf: seams.target }));
vi.mock('@fss/domain/crm/firms.ts', () => ({ readFirm: seams.firm }));
vi.mock('@fss/domain/suppression/effective.ts', () => ({ firstSuppressed: async () => null }));
vi.mock('@fss/domain/policy/holds.ts', () => ({ listApplicableHolds: async () => [] }));
vi.mock('@fss/domain/outreach/facts.ts', () => ({ readApprovedAnswerBlocks: async () => ({ ok: true, value: [] }) }));
vi.mock('@fss/domain/research/ledger.ts', () => ({ workspaceBusinessZone: async () => 'America/New_York', readCreditSpend: async () => ({ todayCents: 0, monthToDateCents: 0 }) }));
vi.mock('@fss/domain/research/reservations.ts', () => ({ readAttempt: seams.attempt, reserveAttempt: seams.reserve, markCalling: seams.calling, settleAttempt: seams.settle }));
vi.mock('@fss/domain/policy/sendGate.ts', () => ({ lockSendGateForDispatch: async () => {} }));
vi.mock('@fss/domain/research/ceilings.ts', () => ({ lockResearchBudget: async () => {} }));
vi.mock('@fss/domain/research/settings.ts', () => ({ readResearchSettings: async () => ({ enabled: true, dailyCostCeilingCents: 1000, monthlyCostCeilingCents: 10000 }) }));
vi.mock('@fss/domain/policy/clock.ts', () => ({ databaseNow: async () => new Date().toISOString() }));
vi.mock('../../../api/src/routes/routeSupport.ts', () => ({ requirePrincipal: seams.principal, contextForPrincipal: seams.context, runRouteCommand: vi.fn() }));
vi.mock('../../../api/src/auth/sessions.ts', () => ({ authenticate: seams.authenticate, endSession: vi.fn() }));
vi.mock('../../../api/src/server.ts', () => ({ route: seams.route }));

const id = '10000000-0000-4000-8000-000000000001';
const commandId = '20000000-0000-4000-8000-000000000002';
const principal = { workspaceId: id, userId: id, deviceId: id, sessionId: id, role: 'salesperson', membershipStatus: 'active', deviceStatus: 'active' };
const message = { id, mailboxId: id, direction: 'incoming', matched: true, metadataOnly: false, headerFrom: 'person@example.test', headerTo: ['owner@example.test'], headerCc: [], subject: 'Question', rfcMessageId: 'question@example.test', providerThreadId: id, referenceMessageIds: [], listId: null, autoSubmitted: null, internalDate: '2026-10-23T06:00:00Z' };
let mailbox: { owner_user_id: string; email_address: string; provider_account_id: string | null; status: string; sync_state: string; generation: number };
let authorization: { revision: number; enabled: boolean; owner: string; account: string; address: string } | null;
let afterAssembly: () => void;
let afterSettlement: () => void;
let consumed: boolean;
const ctx = repositoryContext(workspaceScope(id, { kind: 'user', userId: id, role: 'salesperson' }), {
  async query<Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) {
    let rows: QueryResultRowLike[] = [];
    if (sql.includes('FROM gmail_prospecting_authorizations a JOIN mailboxes')) {
      if (authorization) rows = [{ revision: authorization.revision, enabled: authorization.enabled,
        matches: (values?.[4] === false || mailbox.status === 'connected') && authorization.owner === mailbox.owner_user_id
          && authorization.account === mailbox.provider_account_id && authorization.address === mailbox.email_address
          && mailbox.owner_user_id === values?.[2] && mailbox.provider_account_id === values?.[3] }];
    } else if (sql.includes('SELECT owner_user_id')) rows = [{ ...mailbox }];
    else if (sql.includes('SELECT e.id,e.version')) rows = [{ id, version: 1, address: 'person@example.test', contact_id: id }];
    else if (sql.includes('UNION SELECT email_address')) rows = [{ address: 'owner@example.test' }];
    else if (sql.includes('SELECT m.id,m.direction')) rows = [{ id, direction: 'incoming', internal_date: new Date(message.internalDate), body_text: 'Private original', truncated: false }];
    else if (sql.includes('FROM meetings')) afterAssembly();
    return { rows: rows as Row[], rowCount: rows.length };
  },
});
const count = vi.fn(async () => 100);
const prepare = vi.fn(async () => ({ raw: JSON.stringify({ text: 'Private paid suggestion', factRefs: [], unsupportedClaims: [] }), costCents: 1, costEstimated: false }));
const port: HumanReplyDraftPort = { providerKey: 'aws_bedrock.outreach_reply', countInputTokens: count, prepareReplyDraft: prepare };
const origin = 'https://localhost:8443';
const key = randomBytes(32);
const auth = { now: () => new Date(), config: { oidc: { redirectUri: `${origin}/browser/callback` }, supportedClientVersions: { minimum: '1.0.0', ceiling: '1.x', incompatible: [] } } } as unknown as AuthDeps;
const options = { auth } as RoutingOptions;
const handler = createBrowserHandler({ origin, cookieKey: key, clientVersion: '1.0.0', withRequest: async work => work({ auth, api: options }) });

beforeEach(() => {
  vi.resetAllMocks();
  mailbox = { owner_user_id: id, email_address: 'owner@example.test', provider_account_id: id, status: 'connected', sync_state: 'ready', generation: 1 };
  authorization = { revision: 1, enabled: true, owner: id, account: id, address: mailbox.email_address };
  afterAssembly = () => {};
  afterSettlement = () => {};
  consumed = false;
  seams.message.mockResolvedValue(message);
  seams.body.mockResolvedValue({ text: 'Private original', truncated: false });
  seams.target.mockResolvedValue({ id, firmId: id, contactId: id, opportunityId: null, outreachPlanId: null });
  seams.firm.mockResolvedValue({ id, assigned_user_id: id, status: 'active', time_zone: 'America/New_York' });
  seams.attempt.mockImplementation(async () => consumed ? { id, state: 'settled' } : null);
  seams.reserve.mockImplementation(async () => { consumed = true; return { id }; });
  seams.calling.mockResolvedValue(true);
  seams.settle.mockImplementation(async () => { afterSettlement(); });
  count.mockResolvedValue(100);
  prepare.mockResolvedValue({ raw: JSON.stringify({ text: 'Private paid suggestion', factRefs: [], unsupportedClaims: [] }), costCents: 1, costEstimated: false });
  seams.principal.mockResolvedValue({ ok: true, principal });
  seams.context.mockReturnValue({ ok: true, context: ctx });
  seams.authenticate.mockResolvedValue({ authenticated: true, principal });
  seams.route.mockImplementation(async (method: string, path: string, _options: unknown, request: ApiRequest) => routeReplyComposer({ ...request, method, path }, options, port));
});

it.each(['disconnected', 'syncing'])('classifies authorized %s as operational, keeping other authorization callers strict', async state => {
  if (state === 'disconnected') mailbox.status = 'disconnected';
  else mailbox.sync_state = 'syncing';
  expect(await readReplyDraftContext(ctx, { messageId: id })).toEqual({ ok: false, reason: 'mailbox_not_ready' });
  if (state === 'disconnected') expect(await authorizationForMailbox(ctx, id)).toMatchObject({ allowed: false });
});
it.each(['absent', 'revoked', 'account', 'address', 'owner', 'unknown'] as const)('never classifies %s authorization as merely operational', async change => {
  mailbox.status = 'disconnected';
  if (change === 'absent') authorization = null;
  else if (change === 'revoked') authorization!.enabled = false;
  else if (change === 'unknown') mailbox.provider_account_id = null;
  else authorization![change] = 'changed';
  expect(await readReplyDraftContext(ctx, { messageId: id })).toEqual({ ok: false, reason: 'mailbox_unavailable' });
});
it.each(['sync', 'connection', 'revocation', 'identity', 'assignment', 'revision'] as const)('revalidates %s after context assembly waits without stale prose', async change => {
  afterAssembly = () => {
    if (change === 'sync') mailbox.sync_state = 'syncing';
    if (change === 'connection') mailbox.status = 'disconnected';
    if (change === 'revocation') authorization!.enabled = false;
    if (change === 'identity') mailbox.provider_account_id = 'replacement';
    if (change === 'revision') authorization!.revision++;
    if (change === 'assignment') seams.firm.mockResolvedValue({ id, assigned_user_id: commandId, status: 'active' });
  };
  const expected = ['sync', 'connection'].includes(change) ? 'mailbox_not_ready' : change === 'assignment' ? 'not_assigned' : 'owner_changed';
  expect(await readReplyDraftContext(ctx, { messageId: id })).toEqual({ ok: false, reason: expected });
});
it.each(['sync', 'connection'] as const)('withholds a settled paid result after %s loss and restores exact-attempt recovery', async change => {
  const source = await readReplyDraftContext(ctx, { messageId: id, factRefs: [] });
  if (!source.ok) throw new Error(source.reason);
  const input = { messageId: id, commandId, clientVersion: '1.0.0', sourceRevision: source.value.sourceRevision, factRefs: [], envelope: source.value.envelope };
  afterSettlement = () => { if (change === 'sync') mailbox.sync_state = 'syncing'; else mailbox.status = 'disconnected'; };
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'mailbox_not_ready' });
  expect(seams.settle).toHaveBeenCalledWith(ctx, expect.objectContaining({ outcome: { kind: 'settled', cents: 1 } }));
  mailbox.status = 'connected'; mailbox.sync_state = 'ready';
  expect(await generateReplyDraft(ctx, input, port)).toEqual({ ok: false, reason: 'generation_already_attempted' });
  expect(seams.reserve).toHaveBeenCalledWith(ctx, expect.objectContaining({ subjectId: commandId }));
  expect(count).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
});

it.each(['session', 'firm', 'source', 'revocation'] as const)('preserves %s refusal after paid settlement even alongside readiness loss', async change => {
  const source = await readReplyDraftContext(ctx, { messageId: id, factRefs: [] });
  if (!source.ok) throw new Error(source.reason);
  let current = true;
  afterSettlement = () => {
    mailbox.sync_state = 'syncing';
    if (change === 'session') current = false;
    if (change === 'firm') seams.firm.mockResolvedValue({ id, assigned_user_id: commandId, status: 'active' });
    if (change === 'source') seams.message.mockResolvedValue(null);
    if (change === 'revocation') authorization!.enabled = false;
  };
  const reason = { session: 'session_changed', firm: 'not_assigned', source: 'message_unavailable', revocation: 'mailbox_unavailable' }[change];
  expect(await generateReplyDraft(ctx, { messageId: id, commandId, clientVersion: '1.0.0', sourceRevision: source.value.sourceRevision, factRefs: [], envelope: source.value.envelope }, port, async () => current)).toEqual({ ok: false, reason });
  expect(prepare).toHaveBeenCalledOnce();
  expect(seams.settle).toHaveBeenCalledWith(ctx, expect.objectContaining({ outcome: { kind: 'settled', cents: 1 } }));
});

function browser() {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const cookie = `${COOKIE_NAMES.access}=${sealCookie(key, origin, COOKIE_NAMES.access, { kind: 'access', token: 't'.repeat(50), csrf: 'c'.repeat(43), expiresAt })}`;
  const responses: { status: number; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url), origin);
    const result = await handler({ method: init?.method ?? 'GET', path: parsed.pathname, query: parsed.searchParams,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), origin, cookie, 'sec-fetch-site': 'same-origin' },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (!result) throw new Error('Unhandled fixture request');
    responses.push({ status: result.status, body: result.body });
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  const newClient = () => new BrowserClient({ fetch: fetcher, storage, navigate: () => {}, randomUUID: () => commandId });
  const client = newClient();
  const attempt = new ReplyAttempt(client, storage, () => commandId);
  return { client, attempt, storage, responses, newClient };
}
it.each(['sync', 'connection'] as const)('actual adapter/API/domain/client retains settled custody through %s loss, reload and explicit recovery', async change => {
  const b = browser();
  try {
    await b.client.refresh();
    const source = await b.attempt.context(id);
    afterSettlement = () => { if (change === 'sync') mailbox.sync_state = 'syncing'; else mailbox.status = 'disconnected'; };
    expect(await b.attempt.requestSuggestion(source, false)).toEqual({ status: 'refused', replayed: false, reason: 'mailbox_not_ready' });
    const retained = b.storage.getItem(REPLY_PENDING_KEY);
    expect(b.attempt.pending(id)?.commandId).toBe(commandId);
    expect(JSON.stringify(b.responses.at(-1))).not.toContain('Private');
    expect(b.responses.at(-1)?.status).toBe(200);
    expect(b.client.current?.status).toBe('signed_in');
    b.attempt.dispose();
    b.client.dispose();
    const restoredClient = b.newClient();
    const reloaded = new ReplyAttempt(restoredClient, b.storage, () => { throw new Error('No replacement UUID'); });
    try {
      expect(b.storage.getItem(REPLY_PENDING_KEY)).toBe(retained);
      await restoredClient.refresh();
      await expect(reloaded.context(id)).rejects.toMatchObject({ reason: 'refused' });
      expect(b.storage.getItem(REPLY_PENDING_KEY)).toBe(retained);
      mailbox.status = 'connected'; mailbox.sync_state = 'ready';
      const fresh = await reloaded.context(id);
      expect(fresh.sourceRevision).toBe(source.sourceRevision);
      expect(await reloaded.requestSuggestion(fresh, true)).toEqual({ status: 'refused', replayed: true, reason: 'generation_already_attempted' });
      expect(b.storage.getItem(REPLY_PENDING_KEY)).toBe(retained);
      expect(count).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
      expect(seams.reserve).toHaveBeenCalledOnce();
      expect(seams.reserve).toHaveBeenCalledWith(ctx, expect.objectContaining({ subjectId: commandId }));
    } finally { reloaded.dispose(); restoredClient.dispose(); }
  } finally { b.attempt.dispose(); b.client.dispose(); }
});
it('genuine authorization revocation after paid settlement remains global409 and clears browser custody', async () => {
  const b = browser();
  try {
    await b.client.refresh();
    const source = await b.attempt.context(id);
    afterSettlement = () => { authorization!.enabled = false; mailbox.sync_state = 'syncing'; };
    await expect(b.attempt.requestSuggestion(source, false)).rejects.toMatchObject({ reason: 'refused' });
    expect(b.responses.at(-1)).toEqual({ status: 409, body: { error: 'browser_request_refused' } });
    expect(b.client.current).toBeNull();
    expect(b.storage.getItem(REPLY_PENDING_KEY)).toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
  } finally { b.attempt.dispose(); b.client.dispose(); }
});

it.each(['revoked', 'absent', 'not_ready', 'message_unavailable', 'revoked_during_assembly', 'revision_during_assembly'] as const)('actual context refresh handles %s without broad refusal invalidation', async change => {
  const b = browser();
  try {
    await b.client.refresh();
    const source = await b.attempt.context(id);
    await b.attempt.requestSuggestion(source, false);
    const first = b.attempt.pending(id);
    if (!first) throw new Error('Expected retained paid attempt');
    // A second schema-valid IDs-only record represents another message's custody.
    // The real ReplyAttempt reader must clear the entire collection on auth loss.
    const secondId = '30000000-0000-4000-8000-000000000003';
    b.storage.setItem(REPLY_PENDING_KEY, JSON.stringify({ version: 2, records: [first,
      { ...first, messageId: secondId, commandId: '40000000-0000-4000-8000-000000000004' }] }));
    expect(b.attempt.pending(secondId)).not.toBeNull();
    const retained = b.storage.getItem(REPLY_PENDING_KEY);
    if (change === 'revoked') authorization!.enabled = false;
    if (change === 'absent') authorization = null;
    if (change === 'not_ready') mailbox.sync_state = 'syncing';
    if (change === 'message_unavailable') seams.message.mockResolvedValue(null);
    // These waits exercise composer owner_changed through the real API's
    // privateAuthorityRefusal, not the browser's mailbox_unavailable translation.
    let assemblyWaits = 0;
    if (change === 'revoked_during_assembly') afterAssembly = () => { assemblyWaits++; authorization!.enabled = false; };
    if (change === 'revision_during_assembly') afterAssembly = () => { assemblyWaits++; authorization!.revision++; };
    const epoch = b.client.epoch;
    await expect(b.attempt.context(id)).rejects.toMatchObject({ reason: 'refused' });
    if (change === 'revoked' || change === 'absent' || change.endsWith('_during_assembly')) {
      expect(b.responses.at(-1)).toEqual({ status: 401, body: { error: 'browser_request_refused' } });
      expect(b.client.epoch).toBeGreaterThan(epoch);
      expect(b.client.current).toBeNull();
      expect(b.attempt.pending(id)).toBeNull();
      expect(b.attempt.pending(secondId)).toBeNull();
      expect(b.storage.getItem(REPLY_PENDING_KEY)).toBeNull();
    } else {
      expect(b.responses.at(-1)).toEqual({ status: 200, body: { ok: false,
        reason: change === 'not_ready' ? 'mailbox_not_ready' : 'message_unavailable' } });
      expect(b.client.current?.status).toBe('signed_in');
      expect(b.storage.getItem(REPLY_PENDING_KEY)).toBe(retained);
    }
    if (change.endsWith('_during_assembly')) expect(assemblyWaits).toBe(1);
    expect(seams.reserve).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledOnce();
  } finally { b.attempt.dispose(); b.client.dispose(); }
});
