import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { TERRITORY_EMAIL_TICK_SEND_LIMIT } from '../src/sequenceEmailWalker';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { TerritoryPolicyRepository } from '../src/territoryPolicyRepository';
import { DynamoDispatchRepository, dispatchIntentKey } from '../src/dispatchRepository';
import { campaignEnrollmentKey } from '../src/workerCampaignRepository';
import { mailSuppressionKey } from '../src/threadIntakeRepository';
import { executionAuthorityKey } from '../src/executionRepository';
import { googleScopes } from '../src/googleGrantCapabilities';
import { DynamoStore } from '../src/dynamoStore';
import { buildScheduledRunRecord } from '../src/tickLog';
import { listAttempts } from '../src/v1/attempts';
import { REPLY_TEMPLATE_SEEDS, seededReplyTemplateHash } from '../../../../src/main/outreach/templates/replyTemplateSeeds';
import { templateSequenceEmailActionId, templateSequenceEmailCommandId, templateSequenceEmailTemplateId } from '../../../../src/shared/outreach/templateSequenceEmail';
import { ownerCommandSchema, ownerSourceKey, territoryPolicyCommandSchema, replyTemplateCommandSchema, type OwnerCommand,
  type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, TERRITORY_CALL_POLICY_SUBJECT } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { REPLY_TEMPLATE_SUBJECT } from '../../../../src/shared/contracts/replyTemplateContract';
import type { ResearchSetupProfile } from '../src/researchSetup';

/**
 * The walker that sends a due sequence email step, on the real worker seam: the real scheduled tick, the real
 * territory policy, the real standing template approval, the real dispatch repository, the real execution
 * repository, the real intake barrier and the real sender cap, with every HTTP boundary injected. No real
 * network, no AWS, no key values, and nothing here installs, deploys, grants, calls or sends for real.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY_ZERO = '2026-09-01T12:00:00.000Z';
/** Day 7 of the sequence, when the T4 email step falls due. */
const DAY_SEVEN = '2026-09-08T13:00:00.000Z';
/** Past day 21, when T5's step is due as well. */
const DAY_TWENTY_TWO = '2026-09-23T13:00:00.000Z';
const RECIPIENT = 'office@fictional-1.example';
const SENDER = 'sender@example.invalid';
const T4 = REPLY_TEMPLATE_SEEDS.find(seed => seed.id === 'T4')!;
const T5 = REPLY_TEMPLATE_SEEDS.find(seed => seed.id === 'T5')!;

const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 },
  reviewedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2026-10-28T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const,
  placesSearchCostMicros: 35000 };

async function fixture(options: { city?: boolean; claim?: boolean; route?: boolean; firms?: number } = {}) {
  const db = new ConditionalCommandHarness();
  let now = DAY_ZERO;
  const store = { now: () => now };
  const shared = { dynamo: db, tableName: 'fictional-sequence-email', workspaceId: 'ws', clock: store };
  const auth = new WorkerAuth(shared);
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  const bearer = `Bearer ${pair.credential}`;
  const dynamoStore = new DynamoStore(shared);
  let sends = 0;
  const sent: { to: string; raw: string }[] = [];
  let polls = 0;
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
        const body = rfc822(init);
        sent.push({ to: /^To: (.+)$/m.exec(body)?.[1]?.trim() ?? '', raw: body });
        return Response.json({ id: `sent${sends}`, threadId: `thread${sends}` });
      }
      if (target.pathname.endsWith('/profile')) return Response.json({ historyId: '1' });
      if (target.pathname.endsWith('/history')) { polls++; return Response.json({ historyId: '2', history: [] }); }
      if (target.pathname.endsWith('/messages')) return Response.json({ messages: [] });
      throw new Error('unconfigured fictional gmail boundary');
    }
    // The Places discovery boundary of the research phase: a page of no results costs nothing and creates nothing.
    return Response.json({ places: [] });
  };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch,
    config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 7) } });
  const grant = await authorization.beginGoogleGrant(pair.pairingId, ['send', 'relevant_read']);
  await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const coordinator = new OwnerCommandCoordinator({ auth, authorization });
  const accounts = createWorkerAccountRepository(shared);
  const policy = new DynamoDispatchRepository(shared, authorization);
  const research = { loadCredentials: async () => ({ apiKey: 'fictional', model: 'fictional-reviewed-model' }),
    loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }), resolve: async () => ['93.184.216.34'],
    pageHttp: async () => new Response('<p>fictional</p>', { headers: { 'content-type': 'text/html' } }) };
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(descriptor), credentialParameterDeclared: true, placesCredentialParameterDeclared: true };

  // Places-born firms exactly as the research coordinator materialises them, plus the published business
  // inbox lane 39's finder records as a cited claim and the email route the mail intake scope is built from.
  const recipientFor = (n: number) => n === 1 ? RECIPIENT : `office@fictional-${n}.example`;
  const addFirm = async (n: number) => {
    const account = await accounts.create({ commandId: uuid(100 + n), name: `Fictional PM ${n}`, domain: `fictional-${n}.example` });
    const address = recipientFor(n);
    const listingText = options.city === false ? 'no listing here'
      : JSON.stringify({ id: `place-${n}`, displayName: account.name, formattedAddress: '5 Fictional Row, Providence, RI 02903',
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
        purpose: 'business', evidenceIds: [listing.id], verification: 'listed' },
        ...(options.route === false ? [] : [{ id: `route-email-${n}`, accountId: account.id, personId: null, channel: 'email' as const,
          value: address, purpose: 'business' as const, evidenceIds: [published.id], verification: 'published' as const }])] });
    return { account, address };
  };
  const firms: { account: { id: string; name: string }; address: string }[] = [];
  for (let n = 1; n <= (options.firms ?? 1); n++) firms.push(await addFirm(n));
  const account = firms[0]!.account;

  let commands = 0;
  const territoryCommand = (payload: TerritoryPolicyCommand['payload']) => territoryPolicyCommandSchema.parse({ commandId: uuid(++commands),
    workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
  await coordinator.apply(territoryCommand({ kind: 'policy.approve', expectedRevision: 0, definition: DEFAULT }), bearer);

  const territory = new TerritoryPolicyRepository(shared);
  const tick = (signal = new AbortController().signal) =>
    createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(signal);
  /** The mailbox hop a founder's desktop makes for one firm: the mailbox subject he connected plus its mail scope.
   *  Lane 41's tick now does exactly this for a firm the policy already enrolled, so the hop is a no-op for a firm
   *  the tick has already reached: the live authority version and configuration revision are read rather than assumed. */
  const configureMailbox = async (accountId = account.id) => {
    const configuration = await dynamoStore.get<{ revision: number; mailboxSubject: string | null }>(ownerSourceKey(accountId));
    if (!configuration || configuration.data.mailboxSubject !== null) return null;
    const authority = await dynamoStore.get<{ authority: { generation: number }; version: number }>(executionAuthorityKey(accountId));
    if (!authority) return null;
    const command: OwnerCommand = ownerCommandSchema.parse({ commandId: uuid(++commands + 400), workspaceId: 'ws', accountId,
      expectedAuthorityGeneration: authority.data.authority.generation, expectedVersion: authority.data.version,
      kind: 'configure-owner', payload: { expectedConfigurationRevision: configuration.data.revision,
        configuration: { version: 1, workspaceId: 'ws', accountId, pairingId: pair.pairingId, revision: configuration.data.revision + 1,
          state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null },
        mailScope: { expectedEnvelopeRevision: null, since: DAY_ZERO } } });
    return coordinator.apply(command, bearer);
  };
  const configureEveryMailbox = async () => { for (const firm of firms) await configureMailbox(firm.account.id); };
  /** The standing approval, through the real owner command: the exact seeded text and its own sha256. */
  const approveTemplate = async (id: 'T4' | 'T5' = 'T4') => {
    const seed = id === 'T4' ? T4 : T5;
    return coordinator.apply(replyTemplateCommandSchema.parse({ commandId: uuid(++commands + 600), workspaceId: 'ws', accountId: REPLY_TEMPLATE_SUBJECT,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'reply-template', payload: { kind: 'template-approve', templateId: id, revision: 1,
        subject: seed.subject, body: seed.body, contentHash: seededReplyTemplateHash(id) } }), bearer);
  };
  return { db, shared, store, auth, pair, bearer, coordinator, accounts, account, firms, policy, territory, tick, fetch,
    configureMailbox, configureEveryMailbox, approveTemplate, dynamoStore, sends: () => sends, sent: () => sent, polls: () => polls,
    advance: (value: string) => { now = value; }, now: () => now,
    stepIds: async () => {
      const record = await territory.readEnrollmentRecord(account.id);
      return (record?.data.heldSteps ?? []).map(step => step.stepId);
    } };
}

/** The raw RFC822 the injected Gmail boundary was handed, so a test can read exactly what would have gone out. */
function rfc822(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') return '';
  try {
    const raw = (JSON.parse(body) as { raw?: unknown }).raw;
    return typeof raw === 'string' ? Buffer.from(raw, 'base64url').toString('utf8') : body;
  } catch { return body; }
}
/** The plain-text body of that message, decoded from its base64 transfer encoding. */
function messageText(raw: string): string {
  const separator = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const index = raw.indexOf(separator);
  if (index < 0) return raw;
  return Buffer.from(raw.slice(index + separator.length).replace(/\s+/g, ''), 'base64').toString('utf8');
}

describe('the worker walks a due sequence email step', () => {
  it('sends the approved T4 text once, records the step as sent and never sends it again', async () => {
    const f = await fixture();
    await f.approveTemplate();
    await f.configureMailbox();
    await f.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    const steps = await f.stepIds();
    expect(steps).toHaveLength(2);
    f.advance(DAY_SEVEN);
    const first = await f.tick();
    expect(f.sends()).toBe(1);
    expect(first.sequenceEmails).toMatchObject({ scanned: 1, due: 1, sent: 1, held: 0, failed: 0 });
    const record = await f.territory.readEnrollmentRecord(f.account.id);
    expect(record?.data.sentSteps).toEqual([{ stepId: steps[0], templateId: 'T4',
      commandId: templateSequenceEmailCommandId({ accountId: f.account.id, templateId: 'T4', stepId: steps[0]! }), sentAt: DAY_SEVEN }]);
    expect(record?.data.heldSteps.map(step => step.stepId)).toEqual([steps[1]]);
    // The send is one `send` attempt in the diagnostics log, naming the step and template but never the address or the text.
    const sendAttempts = await listAttempts(f.dynamoStore, { kind: 'send' });
    expect(sendAttempts).toEqual([expect.objectContaining({ outcome: 'ok', reason: null, ref: f.account.id,
      detail: { code: 'provider_accepted', firmId: f.account.id, commandId: templateSequenceEmailCommandId({ accountId: f.account.id, templateId: 'T4', stepId: steps[0]! }) } })]);
    expect(JSON.stringify(sendAttempts)).not.toContain(RECIPIENT);
    expect(await listAttempts(f.dynamoStore, { kind: 'hold' })).toEqual([]);
    // The text that went out is the approved text with the firm's own name and city, and nothing else.
    const text = messageText(f.sent()[0]!.raw);
    expect(text).toBe(T4.body.replaceAll('{firm}', 'Fictional PM 1').replaceAll('{city}', 'Providence').replaceAll('\n', '\r\n'));
    expect(text).not.toContain('{firm}');
    expect(text).not.toContain('{city}');
    // A second tick walks the same firm and sends nothing: the step is recorded as sent.
    const again = await f.tick();
    expect(f.sends()).toBe(1);
    expect(again.sequenceEmails).toMatchObject({ scanned: 1, due: 0, sent: 0, held: 0 });
  });

  it('derives the command id and the action id from the firm, the template and the step, so a replayed tick reaches the same records', async () => {
    const f = await fixture();
    await f.approveTemplate();
    await f.configureMailbox();
    await f.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    const steps = await f.stepIds();
    const identity = { accountId: f.account.id, templateId: 'T4' as const, stepId: steps[0]! };
    f.advance(DAY_SEVEN);
    await f.tick();
    expect(f.sends()).toBe(1);
    const commandId = templateSequenceEmailCommandId(identity);
    const actionId = templateSequenceEmailActionId(identity);
    expect(f.db.inspect(dispatchIntentKey(commandId))).toMatchObject({ kind: 'template_sequence_email', stepId: steps[0] });
    // The action id names its template in plain text, which is how Today reads "Sent T4" from the one outcome row it stores.
    expect(templateSequenceEmailTemplateId(actionId)).toBe('T4');
    expect(templateSequenceEmailTemplateId('action')).toBeNull();
    // Every id is a function of the same three facts, so a second walk of the same step derives the same ones.
    expect(templateSequenceEmailCommandId(identity)).toBe(commandId);
    expect(templateSequenceEmailActionId({ ...identity, stepId: steps[1]! })).not.toBe(actionId);
    const outcome = (await f.dynamoStore.eventsAfter(null)).events.filter(event => event.kind === 'action.outcome'
      && event.payload.state === 'provider_accepted');
    expect(outcome.map(event => event.kind === 'action.outcome' ? event.payload.actionId : null)).toEqual([actionId]);
  });

  it('records each closed hold reason on the step instead of a single mailbox reason, and sends nothing on any of them', async () => {
    const reasons: Record<string, string> = {};
    // template_not_approved: no standing approval at all.
    const unapproved = await fixture();
    await unapproved.configureMailbox();
    await unapproved.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    unapproved.advance(DAY_SEVEN);
    await unapproved.tick();
    reasons.template_not_approved = (await unapproved.territory.readEnrollmentRecord(unapproved.account.id))!.data.heldSteps[0]!.reason;
    expect(unapproved.sends()).toBe(0);
    // The held step is one `hold` attempt with the same closed reason, and no `send` attempt exists.
    expect(await listAttempts(unapproved.dynamoStore, { kind: 'hold' })).toEqual([expect.objectContaining({ outcome: 'held', reason: 'template_not_approved', ref: unapproved.account.id,
      detail: { code: 'template_not_approved', firmId: unapproved.account.id } })]);
    expect(await listAttempts(unapproved.dynamoStore, { kind: 'send' })).toEqual([]);

    // mailbox_not_connected: the approval stands, but this firm's owner source carries no mailbox.
    const nomailbox = await fixture();
    await nomailbox.approveTemplate();
    await nomailbox.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    nomailbox.advance(DAY_SEVEN);
    await nomailbox.tick();
    reasons.mailbox_not_connected = (await nomailbox.territory.readEnrollmentRecord(nomailbox.account.id))!.data.heldSteps[0]!.reason;
    expect(nomailbox.sends()).toBe(0);

    // sender_cap_reached: the mailbox is connected and today's cap is nothing.
    const capped = await fixture();
    await capped.approveTemplate();
    await capped.configureMailbox();
    await capped.policy.configureCaps({ sender: SENDER, dailyLimit: 0 }, null);
    capped.advance(DAY_SEVEN);
    await capped.tick();
    reasons.sender_cap_reached = (await capped.territory.readEnrollmentRecord(capped.account.id))!.data.heldSteps[0]!.reason;
    expect(capped.sends()).toBe(0);

    // template_variable_missing: T4 names {city} and this firm's listing does not state one.
    const nocity = await fixture({ city: false });
    await nocity.approveTemplate();
    await nocity.configureMailbox();
    await nocity.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    nocity.advance(DAY_SEVEN);
    await nocity.tick();
    reasons.template_variable_missing = (await nocity.territory.readEnrollmentRecord(nocity.account.id))!.data.heldSteps[0]!.reason;
    expect(nocity.sends()).toBe(0);

    // no_business_email: nothing recorded a published inbox for this firm.
    const noclaim = await fixture({ claim: false });
    await noclaim.approveTemplate();
    await noclaim.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    noclaim.advance(DAY_SEVEN);
    await noclaim.tick();
    reasons.no_business_email_or_mailbox = (await noclaim.territory.readEnrollmentRecord(noclaim.account.id))!.data.heldSteps[0]!.reason;
    expect(noclaim.sends()).toBe(0);

    expect(reasons).toMatchObject({ template_not_approved: 'template_not_approved', mailbox_not_connected: 'mailbox_not_connected',
      sender_cap_reached: 'sender_cap_reached', template_variable_missing: 'template_variable_missing' });
  });

  it('bounds the sends of one tick and carries the counts into the tick record', async () => {
    const f = await fixture();
    await f.approveTemplate();
    await f.configureMailbox();
    await f.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    f.advance(DAY_SEVEN);
    const report = await f.tick();
    expect(TERRITORY_EMAIL_TICK_SEND_LIMIT).toBe(25);
    const record = buildScheduledRunRecord(report, { at: DAY_SEVEN, durationMs: 10 });
    expect(record.territory).toMatchObject({ emailsSent: 1, emailsHeld: 0, reentered: 0 });
    const held = buildScheduledRunRecord({ ...report, sequenceEmails: { ...report.sequenceEmails!, sent: 0, held: 3 } },
      { at: DAY_SEVEN, durationMs: 10 });
    expect(held.territory).toMatchObject({ emailsSent: 0, emailsHeld: 3 });
  });

  it('stops at the per-tick send bound and finishes the rest on the next tick', async () => {
    // Thirteen firms past day twenty-one have twenty-six due steps between them: both email steps of the
    // default sequence, T4 on day seven and T5 on day twenty-one, with no call outcome in between.
    const f = await fixture({ firms: 13 });
    await f.approveTemplate('T4');
    await f.approveTemplate('T5');
    // The approval receipt sweeps only the first ten firms inline; the scheduled sweep enrolls the rest.
    await f.tick();
    await f.configureEveryMailbox();
    // A daily cap well above the bound, so the tick's own bound is the only thing that stops the walk.
    await f.policy.configureCaps({ sender: SENDER, dailyLimit: 200 }, null);
    f.advance(DAY_TWENTY_TWO);
    const first = await f.tick();
    // The bound stops the walk at the twenty-fifth step, so the twenty-sixth is not even evaluated this tick.
    expect(first.sequenceEmails).toMatchObject({ due: TERRITORY_EMAIL_TICK_SEND_LIMIT, sent: TERRITORY_EMAIL_TICK_SEND_LIMIT, held: 0, failed: 0 });
    expect(f.sends()).toBe(TERRITORY_EMAIL_TICK_SEND_LIMIT);
    const second = await f.tick();
    expect(second.sequenceEmails).toMatchObject({ due: 1, sent: 1 });
    expect(f.sends()).toBe(26);
    // Two per firm, each to the firm's own published inbox, and no address twice over.
    expect(new Set(f.sent().map(message => message.to)).size).toBe(13);
    expect(f.sent().filter(message => message.to === RECIPIENT)).toHaveLength(2);
  });

  it('never emails a firm that answered, and never emails while the policy is paused', async () => {
    const paused = await fixture();
    await paused.approveTemplate();
    await paused.configureMailbox();
    await paused.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    await paused.coordinator.apply(territoryPolicyCommandSchema.parse({ commandId: uuid(900), workspaceId: 'ws',
      accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy',
      payload: { kind: 'policy.set-state', expectedRevision: 1, state: 'paused' } }), paused.bearer);
    paused.advance(DAY_SEVEN);
    const report = await paused.tick();
    expect(paused.sends()).toBe(0);
    expect(report.sequenceEmails).toMatchObject({ scanned: 0, due: 0, sent: 0, held: 0 });

    const stopped = await fixture();
    await stopped.approveTemplate();
    await stopped.configureMailbox();
    await stopped.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    const enrollmentKey = campaignEnrollmentKey((await stopped.territory.readEnrollmentRecord(stopped.account.id))!.data.enrollmentId);
    const enrollment = stopped.db.inspect(enrollmentKey) as { state: string; version: number };
    await stopped.dynamoStore.transact([stopped.dynamoStore.put(enrollmentKey, { ...enrollment, state: 'conversation' }, 1)]);
    stopped.advance(DAY_SEVEN);
    const after = await stopped.tick();
    expect(stopped.sends()).toBe(0);
    expect(after.sequenceEmails).toMatchObject({ due: 0, sent: 0 });

    // An opted-out firm is left entirely alone: no send, and no hold reason written on its step either,
    // because none of the five would be true of it.
    const suppressed = await fixture();
    await suppressed.approveTemplate();
    await suppressed.configureMailbox();
    await suppressed.policy.configureCaps({ sender: SENDER, dailyLimit: 40 }, null);
    await suppressed.dynamoStore.transact([suppressed.dynamoStore.put(mailSuppressionKey(suppressed.account.id), { reason: 'opt_out' }, null)]);
    const steps = await suppressed.stepIds();
    suppressed.advance(DAY_SEVEN);
    const quiet = await suppressed.tick();
    expect(suppressed.sends()).toBe(0);
    expect(quiet.sequenceEmails).toMatchObject({ due: 0, sent: 0, held: 0, failed: 0 });
    const record = await suppressed.territory.readEnrollmentRecord(suppressed.account.id);
    expect(record!.data.heldSteps.map(step => step.reason)).toEqual(['mailbox_not_connected', 'mailbox_not_connected']);
    expect(record!.data.heldSteps.map(step => step.stepId)).toEqual(steps);
  });
});
