import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { TERRITORY_MAIL_SCOPE_SKIPS, TERRITORY_MAIL_SCOPE_TICK_LIMIT, territoryMailScopeSince } from '../src/territoryMailScope';
import { createWorkerAccountRepository, accountKey } from '../src/workerAccountRepository';
import { TerritoryPolicyRepository } from '../src/territoryPolicyRepository';
import { DynamoDispatchRepository } from '../src/dispatchRepository';
import { DynamoThreadIntakeRepository } from '../src/threadIntakeRepository';
import { googleScopes } from '../src/googleGrantCapabilities';
import { DynamoStore } from '../src/dynamoStore';
import { buildScheduledRunRecord } from '../src/tickLog';
import { REPLY_TEMPLATE_SEEDS, seededReplyTemplateHash } from '../../../../src/main/outreach/templates/replyTemplateSeeds';
import { accountRecordSchema } from '../../../../src/shared/contracts/accountRecordContract';
import { replyTemplateCommandSchema, territoryPolicyCommandSchema, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, TERRITORY_CALL_POLICY_SUBJECT,
  territoryMailScopeCommandId } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { REPLY_TEMPLATE_SUBJECT } from '../../../../src/shared/contracts/replyTemplateContract';
import type { ResearchSetupProfile } from '../src/researchSetup';

/**
 * A territory firm actually receives its first email (D13, lane 41), on the real worker seam: the real
 * scheduled tick, the real territory policy, the real standing template approval, the real
 * `configure-owner` through the real owner command coordinator, the real mail poll, the real dispatch
 * repository and the real sender cap, with every HTTP boundary injected. No real network, no AWS, no key
 * values. The one "send" here is a recorded POST to an injected Gmail boundary.
 *
 * The chain this proves end to end: the firm's own page publishes an address, lane 39's finder records it
 * as a cited claim, that claim becomes an email route, the tick configures the firm's mail scope from the
 * grant under David's standing template approval, the next tick's poll completes, and the walk sends.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY_ZERO = '2026-09-01T12:00:00.000Z';
/** Day 7 of the sequence, when the T4 email step falls due. */
const DAY_SEVEN = '2026-09-08T13:00:00.000Z';
const SENDER = 'sender@example.invalid';
const T4 = REPLY_TEMPLATE_SEEDS.find(seed => seed.id === 'T4')!;

const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 },
  reviewedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2026-10-28T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const,
  placesSearchCostMicros: 35000 };

async function fixture(options: { grant?: boolean; firms?: number; claim?: boolean } = {}) {
  const db = new ConditionalCommandHarness();
  let now = DAY_ZERO;
  const shared = { dynamo: db, tableName: 'fictional-territory-first-email', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(shared);
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  const bearer = `Bearer ${pair.credential}`;
  const dynamoStore = new DynamoStore(shared);
  let sends = 0; let polls = 0;
  const sent: { to: string; raw: string }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'fictional-access', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600,
        scope: `openid email ${googleScopes.send} ${googleScopes.relevant_read}` });
    }
    if (href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: SENDER, email_verified: true });
    const target = new URL(href);
    if (target.hostname === 'gmail.googleapis.com') {
      if (target.pathname.endsWith('/messages/send')) {
        sends++;
        const raw = typeof init?.body === 'string' ? Buffer.from((JSON.parse(init.body) as { raw: string }).raw, 'base64url').toString('utf8') : '';
        sent.push({ to: /^To: (.+)$/m.exec(raw)?.[1]?.trim() ?? '', raw });
        return Response.json({ id: `sent${sends}`, threadId: `thread${sends}` });
      }
      if (target.pathname.endsWith('/profile')) return Response.json({ historyId: '1' });
      if (target.pathname.endsWith('/history')) { polls++; return Response.json({ historyId: '2', history: [] }); }
      if (target.pathname.endsWith('/messages')) { polls++; return Response.json({ messages: [] }); }
      throw new Error('unconfigured fictional gmail boundary');
    }
    return Response.json({ places: [] });
  };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch,
    config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 7) } });
  const connectGrant = async () => {
    const grant = await authorization.beginGoogleGrant(pair.pairingId, ['send', 'relevant_read']);
    await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  };
  if (options.grant !== false) await connectGrant();
  const coordinator = new OwnerCommandCoordinator({ auth, authorization });
  const accounts = createWorkerAccountRepository(shared);
  const policy = new DynamoDispatchRepository(shared, authorization);
  const threads = new DynamoThreadIntakeRepository(shared);
  const research = { loadCredentials: async () => ({ apiKey: 'fictional', model: 'fictional-reviewed-model' }),
    loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }), resolve: async () => ['93.184.216.34'],
    pageHttp: async () => new Response('<p>fictional</p>', { headers: { 'content-type': 'text/html' } }) };
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(descriptor), credentialParameterDeclared: true, placesCredentialParameterDeclared: true };

  /**
   * One Places-born firm exactly as the research coordinator materialises it, carrying the cited
   * `business_email` claim lane 39's finder records and NO email route of its own: the route under test
   * is the one the claim itself becomes.
   */
  const addFirm = async (n: number) => {
    const account = await accounts.create({ commandId: uuid(100 + n), name: `Fictional PM ${n}`, domain: `fictional-${n}.example` });
    const address = `office@fictional-${n}.example`;
    const listingText = JSON.stringify({ id: `place-${n}`, displayName: account.name, formattedAddress: '5 Fictional Row, Providence, RI 02903',
      nationalPhoneNumber: '(401) 555-0201', websiteUri: `https://fictional-${n}.example/` });
    const pageText = `Fictional PM ${n}. Write to ${address} for anything about your building.`;
    const listing = { id: `place-${n}`, url: `https://places.example.invalid/${n}`, fetchedAt: DAY_ZERO,
      sha256: createHash('sha256').update(listingText).digest('hex'), excerpt: listingText, permitted: true };
    const published = { id: `page-${n}`, url: `https://fictional-${n}.example/`, fetchedAt: DAY_ZERO,
      sha256: createHash('sha256').update(pageText).digest('hex'), excerpt: pageText, permitted: true };
    await accounts.recordFetchedSource({ accountId: account.id, source: listing });
    await accounts.recordFetchedSource({ accountId: account.id, source: published });
    await accounts.admitEvidence({ commandId: uuid(300 + n), accountId: account.id, expectedVersion: 1, sources: [listing, published],
      claims: options.claim === false ? [] : [{ key: 'business_email', kind: 'fact', value: address, selection: 'role_mailbox', evidenceIds: [published.id] }],
      routes: [{ id: `route-phone-${n}`, accountId: account.id, personId: null, channel: 'phone', value: `+1401555${String(200 + n).padStart(4, '0')}`,
        purpose: 'business', evidenceIds: [listing.id], verification: 'listed' }] });
    return { account, address, published };
  };
  const firms: Awaited<ReturnType<typeof addFirm>>[] = [];
  for (let n = 1; n <= (options.firms ?? 1); n++) firms.push(await addFirm(n));
  const account = firms[0]!.account;

  let commands = 0;
  const territoryCommand = (payload: TerritoryPolicyCommand['payload']) => territoryPolicyCommandSchema.parse({ commandId: uuid(++commands),
    workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
  const approvePolicy = () => coordinator.apply(territoryCommand({ kind: 'policy.approve', expectedRevision: 0, definition: DEFAULT }), bearer);
  const pausePolicy = () => coordinator.apply(territoryCommand({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' }), bearer);
  const approveTemplate = (id: 'T4' | 'T5' = 'T4') => {
    const seed = REPLY_TEMPLATE_SEEDS.find(entry => entry.id === id)!;
    return coordinator.apply(replyTemplateCommandSchema.parse({ commandId: uuid(++commands + 600), workspaceId: 'ws', accountId: REPLY_TEMPLATE_SUBJECT,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'reply-template', payload: { kind: 'template-approve', templateId: id, revision: 1,
        subject: seed.subject, body: seed.body, contentHash: seededReplyTemplateHash(id) } }), bearer);
  };
  const pauseTemplates = () => coordinator.apply(replyTemplateCommandSchema.parse({ commandId: uuid(++commands + 700), workspaceId: 'ws',
    accountId: REPLY_TEMPLATE_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'reply-template',
    payload: { kind: 'template-pause', paused: true } }), bearer);
  const territory = new TerritoryPolicyRepository(shared);
  const tick = (signal = new AbortController().signal) =>
    createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(signal);
  const emailRoutes = async (accountId = account.id) =>
    accountRecordSchema.parse((await dynamoStore.get<unknown>(accountKey(accountId)))!.data).routes.filter(route => route.channel === 'email');
  return { db, shared, auth, pair, bearer, coordinator, accounts, account, firms, policy, territory, threads, tick, fetch, dynamoStore,
    approvePolicy, pausePolicy, approveTemplate, pauseTemplates, connectGrant, emailRoutes,
    sends: () => sends, sent: () => sent, polls: () => polls, advance: (value: string) => { now = value; }, now: () => now,
    /** The plain-text body of one recorded message, decoded from its base64 transfer encoding. */
    body: (index: number) => {
      const raw = sent[index]?.raw ?? '';
      const separator = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
      const at = raw.indexOf(separator);
      return at < 0 ? raw : Buffer.from(raw.slice(at + separator.length).replace(/\s+/g, ''), 'base64').toString('utf8');
    } };
}

describe('a territory firm receives its first email', () => {
  it('turns the cited business email claim into one email route, idempotently across research revisions', async () => {
    const f = await fixture();
    const routes = await f.emailRoutes();
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route).toMatchObject({ accountId: f.account.id, channel: 'email', value: f.firms[0]!.address,
      purpose: 'business', verification: 'published', personId: null, version: 1, evidenceIds: [f.firms[0]!.published.id] });
    // The citation is the firm's own page, the same source whose excerpt and sha carry the address.
    const record = accountRecordSchema.parse((await f.dynamoStore.get<unknown>(accountKey(f.account.id)))!.data);
    expect(record.sources.find(source => source.id === route.evidenceIds[0])?.excerpt).toContain(f.firms[0]!.address);
    // The phone route the Places listing admitted is untouched.
    expect(record.routes.filter(item => item.channel === 'phone').map(item => item.verification)).toEqual(['listed']);

    // Research runs again on the next revision and reads the same page again: one fact recorded twice, not two routes.
    const published = f.firms[0]!.published;
    await f.accounts.admitEvidence({ commandId: uuid(401), accountId: f.account.id, expectedVersion: record.account.version,
      sources: [published], claims: [{ key: 'business_email', kind: 'fact', value: f.firms[0]!.address, selection: 'role_mailbox', evidenceIds: [published.id] }], routes: [] });
    expect(await f.emailRoutes()).toEqual(routes);
    // A revision carrying a different address is refused whole, and the route already recorded stays as it is.
    await expect(f.accounts.admitEvidence({ commandId: uuid(402), accountId: f.account.id,
      expectedVersion: accountRecordSchema.parse((await f.dynamoStore.get<unknown>(accountKey(f.account.id)))!.data).account.version,
      sources: [published], claims: [{ key: 'business_email', kind: 'fact', value: 'other@fictional-1.example', selection: 'role_mailbox', evidenceIds: [published.id] }], routes: [] }))
      .rejects.toThrow('business_email_conflict');
    expect(await f.emailRoutes()).toEqual(routes);

    // A firm that publishes none gets no claim and therefore no email route, truthfully.
    const none = await fixture({ claim: false });
    expect(await none.emailRoutes()).toEqual([]);
  });

  it('configures the firm\'s mail scope exactly once, under a ready grant and a standing approval', async () => {
    const f = await fixture();
    await f.approvePolicy();
    await f.approveTemplate();
    // Nothing is configured before the tick: the policy wrote the firm a no-mail owner source.
    expect(await f.threads.scope(f.account.id, 'mailbox')).toBeNull();
    const first = await f.tick();
    expect(first.mailScopes).toMatchObject({ scanned: 1, configured: 1, failed: 0 });
    expect(f.sends()).toBe(0);
    const scope = await f.threads.scope(f.account.id, 'mailbox');
    // The scope names exactly the firm's own published inbox and the window the configuration opened.
    expect(scope).toMatchObject({ accountId: f.account.id, mailboxSubject: 'mailbox', revision: 1,
      participantAddresses: [f.firms[0]!.address], knownThreadIds: [], since: territoryMailScopeSince(DAY_ZERO) });
    // The command is the one its derived id names, and it is stored under that id.
    const commandId = territoryMailScopeCommandId(f.account.id, 'mailbox');
    expect(f.db.inspect(`COMMAND#${commandId}`)).toMatchObject({ receipt: { commandId, status: 'applied' } });

    // A replayed tick configures nothing a second time: the firm's own scope says it is done.
    const second = await f.tick();
    expect(second.mailScopes).toMatchObject({ scanned: 1, configured: 0, failed: 0, skipped: { scope_configured: 1 } });
    expect((await f.threads.scope(f.account.id, 'mailbox'))!.revision).toBe(1);
  });

  it('skips a firm under each missing condition and configures nothing', async () => {
    // (b) No template carries a standing approval: the permission this plumbing sits under does not exist yet.
    const unapproved = await fixture();
    await unapproved.approvePolicy();
    const noTemplate = await unapproved.tick();
    expect(noTemplate.mailScopes).toMatchObject({ configured: 0, skipped: { no_template_approved: 1 } });
    expect(await unapproved.threads.scope(unapproved.account.id, 'mailbox')).toBeNull();
    // An approval that exists but is paused is not permission to send either.
    await unapproved.approveTemplate();
    await unapproved.pauseTemplates();
    expect((await unapproved.tick()).mailScopes).toMatchObject({ configured: 0, skipped: { no_template_approved: 1 } });
    expect(await unapproved.threads.scope(unapproved.account.id, 'mailbox')).toBeNull();

    // (a) No correspondence grant for the workspace mailbox.
    const ungranted = await fixture({ grant: false });
    await ungranted.approvePolicy();
    await ungranted.approveTemplate();
    expect((await ungranted.tick()).mailScopes).toMatchObject({ configured: 0, skipped: { grant_not_ready: 1 } });
    expect(await ungranted.threads.scope(ungranted.account.id, 'mailbox')).toBeNull();
    // The same firm, once the grant is connected, is configured on the next tick and not before.
    await ungranted.connectGrant();
    expect((await ungranted.tick()).mailScopes).toMatchObject({ configured: 1 });

    // The firm has no email route, because its page published no address.
    const noAddress = await fixture({ claim: false });
    await noAddress.approvePolicy();
    await noAddress.approveTemplate();
    expect((await noAddress.tick()).mailScopes).toMatchObject({ configured: 0, skipped: { no_email_route: 1 } });
    expect(await noAddress.threads.scope(noAddress.account.id, 'mailbox')).toBeNull();

    // The standing policy is paused: the sweep reads the policy and stops, so the scope step reaches no firm
    // at all rather than reaching one and refusing it. Nothing is scanned and nothing is configured.
    const paused = await fixture();
    await paused.approvePolicy();
    await paused.approveTemplate();
    await paused.pausePolicy();
    expect((await paused.tick()).mailScopes).toMatchObject({ scanned: 0, configured: 0, failed: 0, skipped: { policy_paused: 0 } });
    expect(await paused.threads.scope(paused.account.id, 'mailbox')).toBeNull();
  });

  it('recovers its own abandoned reservation of the derived command id, and never another pairing\'s', async () => {
    const f = await fixture();
    await f.approvePolicy();
    await f.approveTemplate();
    const commandId = territoryMailScopeCommandId(f.account.id, 'mailbox');
    const claimKey = `OWNER_COMMAND_CLAIM#${commandId}`;
    // What one lost transaction leaves behind: the tick's own claim of its own derived id, fingerprinting an
    // authority version that can no longer be applied. The firm would otherwise be stuck behind it forever.
    await f.dynamoStore.transact([f.dynamoStore.put(claimKey, { fingerprint: 'f'.repeat(64), pairingId: f.pair.pairingId, at: DAY_ZERO }, null)]);
    expect((await f.tick()).mailScopes).toMatchObject({ configured: 1, failed: 0 });
    expect((await f.threads.scope(f.account.id, 'mailbox'))!.revision).toBe(1);

    // A claim another pairing holds is never touched, and the firm is left exactly as it is.
    const other = await fixture();
    await other.approvePolicy();
    await other.approveTemplate();
    const held = { fingerprint: 'f'.repeat(64), pairingId: '00000000-0000-4000-8000-00000000abcd', at: DAY_ZERO };
    await other.dynamoStore.transact([other.dynamoStore.put(`OWNER_COMMAND_CLAIM#${territoryMailScopeCommandId(other.account.id, 'mailbox')}`, held, null)]);
    expect((await other.tick()).mailScopes).toMatchObject({ configured: 0, failed: 1 });
    expect(await other.threads.scope(other.account.id, 'mailbox')).toBeNull();
    expect(other.db.inspect(`OWNER_COMMAND_CLAIM#${territoryMailScopeCommandId(other.account.id, 'mailbox')}`)).toEqual(held);
  });

  it('bounds the firms of one tick and carries the counts into the tick record', async () => {
    expect(TERRITORY_MAIL_SCOPE_TICK_LIMIT).toBe(25);
    const f = await fixture({ firms: 30 });
    await f.approvePolicy();
    // The approval receipt sweeps ten firms inline and the first scheduled sweep enrolls the other twenty.
    // No template carries a standing approval yet, so every firm the sweep reached is counted as waiting on one.
    const before = await f.tick();
    expect(before.mailScopes).toMatchObject({ scanned: 20, configured: 0, skipped: { no_template_approved: 20 } });

    await f.approveTemplate();
    // The sweep wrapped its cursor, so this tick reaches all thirty firms and the bound is what stops it.
    const first = await f.tick();
    expect(first.mailScopes).toMatchObject({ scanned: TERRITORY_MAIL_SCOPE_TICK_LIMIT, configured: TERRITORY_MAIL_SCOPE_TICK_LIMIT, failed: 0 });
    const second = await f.tick();
    expect(second.mailScopes).toMatchObject({ scanned: 30, configured: 5, failed: 0, skipped: { scope_configured: 25 } });
    const record = buildScheduledRunRecord(second, { at: DAY_ZERO, durationMs: 10 });
    // The record's skip names are exactly the closed list and nothing else can enter it.
    expect(Object.keys(record.territory!.mailScopesSkipped).sort()).toEqual([...TERRITORY_MAIL_SCOPE_SKIPS].sort());
    expect(record.territory).toMatchObject({ mailScopesConfigured: 5,
      mailScopesSkipped: { policy_paused: 0, no_template_approved: 0, grant_not_ready: 0, not_enrolled: 0, no_email_route: 0, scope_configured: 25 } });
    // Each of the thirty firms has exactly one scope, naming its own published inbox and no other.
    for (const firm of f.firms) {
      expect((await f.threads.scope(firm.account.id, 'mailbox'))!.participantAddresses).toEqual([firm.address]);
    }
    // No day of the sequence has arrived for any of them, and nothing here sends in any case.
    expect(f.sends()).toBe(0);
  });

  it('sends the first email on the tick after the poll, and records the reason until then', async () => {
    const f = await fixture();
    await f.approvePolicy();
    await f.approveTemplate();
    await f.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    f.advance(DAY_SEVEN);
    // Tick one: the step is due, the scope does not exist yet, so the step holds and the scope is configured.
    const one = await f.tick();
    expect(one.mailScopes).toMatchObject({ configured: 1 });
    expect(one.sequenceEmails).toMatchObject({ due: 1, sent: 0, held: 1 });
    expect(f.sends()).toBe(0);
    const held = (await f.territory.readEnrollmentRecord(f.account.id))!.data.heldSteps;
    expect(held.map(step => [step.templateId, step.reason])).toEqual([['T4', 'mailbox_not_connected'], ['T5', 'mailbox_not_connected']]);
    // Tick two: the configurations phase polls the newly configured mailbox, and the walk sends.
    const two = await f.tick();
    expect(two.mailPolls).toBe(1);
    expect(two.sequenceEmails).toMatchObject({ due: 1, sent: 1, held: 0 });
    expect(f.sends()).toBe(1);
    expect(f.sent().map(message => message.to)).toEqual([f.firms[0]!.address]);
    const record = (await f.territory.readEnrollmentRecord(f.account.id))!.data;
    expect(record.sentSteps?.map(step => step.templateId)).toEqual(['T4']);
    expect(record.heldSteps.map(step => step.templateId)).toEqual(['T5']);
    // A third tick sends nothing: the step is recorded as sent and the scope is already configured.
    const three = await f.tick();
    expect(three.sequenceEmails).toMatchObject({ due: 0, sent: 0 });
    expect(three.mailScopes).toMatchObject({ configured: 0, skipped: { scope_configured: 1 } });
    expect(f.sends()).toBe(1);
    // The text that went out is the approved T4 text with the firm's own name and city substituted, and the
    // outcome the desktop syncs names the T4 action the worker minted for that step. Two ticks from David's
    // approval to the firm's first email: the scope on tick one, the poll and the send on tick two.
    expect(f.body(0)).toBe(T4.body.replaceAll('{firm}', 'Fictional PM 1').replaceAll('{city}', 'Providence').replaceAll('\n', '\r\n'));
    const outcomes = (await f.dynamoStore.eventsAfter(null)).events.filter(event => event.kind === 'action.outcome');
    expect(outcomes.map(event => event.kind === 'action.outcome' ? [event.payload.actionId.startsWith('template-email-T4-'), event.payload.state] : null))
      .toEqual([[true, 'dispatching'], [true, 'provider_accepted']]);
    expect(f.polls()).toBeGreaterThan(0);
  });
});
