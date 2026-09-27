import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { createMailboxBridge } from '../src/main/mailboxBridge.ts';
import { createReplyBridge } from '../src/main/replyBridge.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import { OPERATIONS, OPERATION_NAMES, type OperationName } from '../src/shared/operations.ts';
import { BRIDGE_ANSWERS } from './support/bridgeAnswers.ts';

/**
 * Every request a bridge makes is declared in the registry (1.0.13, P1-5).
 *
 * `Operation.calls` is what `operations.test.ts` reads to say that no deprecated route
 * has a caller left. That claim is only worth what the list is worth: a `calls` entry
 * written by hand can miss a path — Today's expansion and the Replies refresh each made
 * a call nobody had written down — or name one the bridge does not really ask for, and
 * the deprecated-route check would then be a check of a document rather than of the app.
 *
 * So this drives every operation's own host method against a recording client and
 * compares what actually went out with what the registry says. The query string counts:
 * the settings read is `/settings?include=postal_address`, and a registry that said
 * `/settings` would be describing the request the *previous* build made.
 *
 * The stub answers everything, and badly: a 200 whose body no schema accepts. That is
 * deliberate. What is being recorded is which requests a method makes, and a bridge that
 * only made its second call on a well-shaped first answer would hide that call from this
 * check — so the answers are uniform and the branches that do depend on a good answer are
 * the business of each bridge's own suite.
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

/** One request as the registry writes it: the method and the path with its query. */
function requestsOf(): { readonly seen: string[]; readonly api: ReturnType<typeof createAuthedClient> } {
  const seen: string[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.13',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const at = new URL(url);
      seen.push(`${init.method} ${at.pathname}${at.search}`);
      /*
       * A body the bridge accepts wherever `support/bridgeAnswers.ts` has one, and an
       * empty accepted envelope otherwise.
       *
       * The answers matter (P1-5). A bridge that only makes its *second* call on a
       * well-shaped first answer would otherwise never make it here, and the registry
       * would be compared with the traffic of a refused app rather than a working one:
       * that is how `today.expand`'s `/dial/check` and `replies.refresh`'s
       * `/replies/settings` stayed undeclared through the first review.
       */
      const body = BRIDGE_ANSWERS[at.pathname];
      return await Promise.resolve({
        status: 200,
        body: body ?? { status: 'accepted', replayed: false, result: {} },
      });
    },
  });
  return { seen, api };
}

const session = {
  state: async () =>
    await Promise.resolve({
      online: true,
      stale: false,
      asOf: null,
      mayMutate: true,
      device: { role: 'admin' as const },
      today: null,
    }),
  refreshToday: async () =>
    await Promise.resolve({
      online: true,
      stale: false,
      asOf: null,
      mayMutate: true,
      device: { role: 'admin' as const },
      today: null,
    }),
};

/** One call of every operation, with an input its schema accepts. */
const INPUTS: Readonly<Partial<Record<OperationName, unknown>>> = Object.freeze({
  'today.expand': { firmId: UUID },
  'today.snooze': { itemId: UUID, reason: 'later', returnAt: '2026-09-28T09:00' },
  'today.recordOutcome': { itemId: UUID, outcome: 'no_answer', note: '', callback: null },
  'today.scheduleCallback': { callLogId: UUID, localDate: '2026-09-28', localTime: '09:00' },
  'today.releasePause': { holdId: UUID },
  'replies.open': { messageId: UUID },
  'replies.confirm': { messageId: UUID, classification: 'human_reply', callback: null },
  'replies.resolve': { messageId: UUID, classification: 'human_reply' },
  'crm.openFirm': { firmId: UUID },
  'crm.saveContact': { contactId: UUID, fullName: 'Kim Placeholder', title: null, makePrimary: false },
  'crm.changeStage': { opportunityId: UUID, toStageKey: 'new', reason: null },
  'crm.resolveMerge': { sourceFirmId: UUID, targetFirmId: UUID, resolutions: [] },
  'crm.addFirm': {
    name: 'Aspen Test Wealth',
    website: '',
    timeZone: 'America/New_York',
    contactName: '',
    contactTitle: '',
    contactEmail: '',
    contactPhone: '',
  },
  'crm.enroll': { sequenceVersionId: UUID, contactId: UUID },
  'crm.checkRoute': { routeId: UUID, routeVersion: 1 },
  'sequences.openSequence': { sequenceId: UUID },
  'sequences.createSequence': { name: 'Founder plan' },
  'sequences.saveSteps': { sequenceVersionId: UUID, steps: [] },
  'sequences.saveTemplate': {
    templateVersionId: null,
    name: 'First touch',
    subject: 'A question',
    body: 'Hello,',
    signOff: 'David',
  },
  'sequences.publish': { sequenceVersionId: UUID },
  'sequences.retire': { sequenceVersionId: UUID },
  'settings.show': { screen: 'settings' },
  'settings.saveSetting': { settingKey: 'business_time_zone', value: { timeZone: 'America/New_York' }, changeNote: '' },
  'settings.openHistory': { settingKey: 'business_time_zone' },
  'settings.loadDashboard': { from: '2026-09-01T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z' },
  'settings.retireStage': { stageKey: 'new' },
  'settings.acknowledgeAlert': { alertId: UUID },
  'settings.setSendingCap': { domain: 'example.test', dailyCap: 10, note: '' },
  'settings.recordSendingAuthentication': {
    domain: 'example.test',
    spfPass: true,
    dkimPass: true,
    dmarcPass: true,
    postmasterReviewed: true,
    automatedSendingEnabled: false,
  },
  'settings.recordHolidayCalendar': { version: '2027-federal', dates: [] },
  'settings.addCallingNumber': { e164: '+14015550150', label: '' },
  'settings.retireCallingNumber': { identityId: UUID },
  'settings.allowStates': { states: ['RI'], confirmed: true, note: '' },
  'settings.revokePosture': { postureId: UUID },
  'diagnostics.requeueJob': { jobId: UUID, reason: 'the mailbox was reconnected' },
  'diagnostics.resolveSend': { outboundMessageId: UUID, resolution: 'delivered' },
});

type Host = Readonly<Record<string, ((input?: unknown) => Promise<unknown>) | undefined>>;

function hostsFor(api: ReturnType<typeof createAuthedClient>): Readonly<Record<string, Host>> {
  return {
    today: createTodayBridge({
      api,
      session,
      // Never reached: nothing in this file presses Call, and `today.dial` is a channel
      // of its own rather than an operation.
      handoff: createDialHandoff({
        driver: {
          inspectVerifiedHandler: async () => await Promise.resolve('verified' as const),
          isVerifiedHandlerCurrent: () => true,
          openTelUri: async () => await Promise.resolve(),
        },
      }),
    }) as unknown as Host,
    replies: createReplyBridge({ api, session }) as unknown as Host,
    crm: createCrmBridge({ api, session, clientVersion: '1.0.13' }) as unknown as Host,
    sequences: createSequenceBridge({ api, session }) as unknown as Host,
    settings: createAdminBridge({ api, session }) as unknown as Host,
    mailbox: createMailboxBridge({
      api,
      session,
      openExternally: async () => await Promise.resolve(),
    }) as unknown as Host,
  };
}

describe('the registry records the traffic the bridges actually make', () => {
  it('declares every request, method and query string included', async () => {
    const undeclared: string[] = [];
    for (const name of OPERATION_NAMES) {
      // Diagnostics is answered from `operationHost.ts` against the client directly
      // rather than from a bridge; `operations.test.ts` holds its two paths.
      const [family = '', method = ''] = name.split('.');
      if (family === 'diagnostics') continue;
      const { seen, api } = requestsOf();
      const host = hostsFor(api)[family];
      const call = host?.[method];
      if (call === undefined) throw new Error(`no host method for ${name}`);
      await call(INPUTS[name] ?? {});
      const declared = new Set(OPERATIONS[name].calls.map(entry => `${entry.method} ${entry.path}`));
      for (const request of new Set(seen)) if (!declared.has(request)) undeclared.push(`${name}: ${request}`);
    }
    expect(undeclared).toEqual([]);
  });

  it('really drives the conditional second calls, so the check above is not vacuous', async () => {
    /*
     * Each of these is a call a bridge makes only when the first answer was good. They
     * are the ones the first review's version of this file could not see, and a fixture
     * that stopped being accepted would make it blind to them again — silently, because
     * "every request was declared" is trivially true of an app that made one request and
     * gave up. So the branches are named, and the traffic has to contain them.
     */
    const branches: readonly [OperationName, string][] = [
      ['today.expand', 'POST /dial/check'],
      ['replies.refresh', 'POST /replies/settings'],
      ['crm.openFirm', 'GET /sequences'],
      ['settings.show', 'GET /postures'],
    ];
    for (const [name, request] of branches) {
      const [family = '', method = ''] = name.split('.');
      const { seen, api } = requestsOf();
      const host = hostsFor(api)[family];
      const call = host?.[method];
      if (call === undefined) throw new Error(`no host method for ${name}`);
      await call(INPUTS[name] ?? {});
      expect(seen, `${name} never reached ${request}`).toContain(request);
    }
  });

  it('names the settings read with the query it actually sends', () => {
    const paths = new Set(OPERATION_NAMES.flatMap(name => OPERATIONS[name].calls.map(entry => entry.path)));
    // Migration 0020's key is only in the snapshot for a caller that asks for it, and
    // this build is that caller: a registry entry of `/settings` would be the request
    // 1.0.12 made, and the deprecated-route check would be reading the wrong list.
    expect([...paths]).toContain('/settings?include=postal_address');
    expect([...paths]).not.toContain('/settings');
  });
});
