import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { createMailboxBridge } from '../src/main/mailboxBridge.ts';
import { createReplyBridge } from '../src/main/replyBridge.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import { guardIdentity, resetBridges, type Forgettable } from '../src/main/identityReset.ts';

/**
 * Nothing one person put on this Mac is answered to the next one (1.0.13, P0-A).
 *
 * The session manager wipes the encrypted cache and the list; this is the other half —
 * the six snapshots the main process holds per view. Until the review only the reply
 * bridge was cleared on a transition, so the CRM bridge would answer the next person's
 * first read with the last one's firm page.
 *
 * Two mechanisms, and a hole in either is the same bug: `resetBridges` clears them at
 * the announcement, and `guardIdentity` throws away a read that was already on the wire
 * when the announcement came. This drives both against all six real bridges.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

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

/**
 * The six, as `registerWindowBridges` builds them and `app.ts` resets them.
 *
 * `generation` is a box a test moves by hand: the session manager's counter in
 * production, and the one fact both mechanisms turn on.
 */
function bridgesUnder(generation: { value: number }): {
  readonly named: ReadonlyMap<string, Forgettable & Record<string, unknown>>;
  readonly answered: string[];
} {
  const answered: string[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.13',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async url => {
      answered.push(new URL(url).pathname);
      return await Promise.resolve({ status: 200, body: { status: 'accepted', replayed: false, result: {} } });
    },
  });
  const guard = <H extends Forgettable>(host: H): H => guardIdentity(host, () => generation.value);
  const named = new Map<string, Forgettable & Record<string, unknown>>([
    [
      'today',
      guard(
        createTodayBridge({
          api,
          session,
          handoff: createDialHandoff({
            driver: {
              inspectVerifiedHandler: async () => await Promise.resolve('verified' as const),
              isVerifiedHandlerCurrent: () => true,
              openTelUri: async () => await Promise.resolve(),
            },
          }),
        }),
      ) as unknown as Forgettable & Record<string, unknown>,
    ],
    ['replies', guard(createReplyBridge({ api, session })) as unknown as Forgettable & Record<string, unknown>],
    [
      'crm',
      guard(createCrmBridge({ api, session, clientVersion: '1.0.13' })) as unknown as Forgettable & Record<string, unknown>,
    ],
    ['sequences', guard(createSequenceBridge({ api, session })) as unknown as Forgettable & Record<string, unknown>],
    ['settings', guard(createAdminBridge({ api, session })) as unknown as Forgettable & Record<string, unknown>],
    [
      'mailbox',
      guard(
        createMailboxBridge({ api, session, openExternally: async () => await Promise.resolve() }),
      ) as unknown as Forgettable & Record<string, unknown>,
    ],
  ]);
  return { named, answered };
}

/** One read per bridge, the one a view makes when it opens. */
const FIRST_READ: Readonly<Record<string, readonly [string, unknown]>> = Object.freeze({
  today: ['expand', { firmId: UUID }],
  replies: ['open', { messageId: UUID }],
  crm: ['openFirm', { firmId: UUID }],
  sequences: ['openSequence', { sequenceId: UUID }],
  settings: ['show', { screen: 'settings' }],
  mailbox: ['state', undefined],
});

describe('every bridge forgets when the person changes (P0-A)', () => {
  it('has a forget on all six, and resetBridges calls every one in order', async () => {
    const generation = { value: 1 };
    const { named } = bridgesUnder(generation);
    expect([...named.keys()]).toEqual(['today', 'replies', 'crm', 'sequences', 'settings', 'mailbox']);

    const order: string[] = [];
    const watched = [...named].map(([name, bridge]) => ({
      forget: async (): Promise<unknown> => {
        order.push(name);
        return await bridge.forget();
      },
    }));
    await resetBridges(watched);

    // A seventh bridge added to the window and forgotten in `app.ts` is this list
    // failing, not a stale firm page found by somebody in production.
    expect(order).toEqual(['today', 'replies', 'crm', 'sequences', 'settings', 'mailbox']);
  });

  it('answers the empty state when a read outlives the session it began under', async () => {
    for (const [name, [method, input]] of Object.entries(FIRST_READ)) {
      const generation = { value: 1 };
      const { named } = bridgesUnder(generation);
      const bridge = named.get(name);
      if (bridge === undefined) throw new Error(`no bridge named ${name}`);
      const call = bridge[method] as (argument?: unknown) => Promise<unknown>;

      const started = call.call(bridge, input);
      // Somebody signed out while that read was on the wire.
      generation.value = 2;
      const late = await started;

      expect(late, `${name}.${method} answered from the last session`).toEqual(await bridge.forget());
    }
  });

  it('lets a read that stayed within its session through untouched', async () => {
    const generation = { value: 1 };
    const { named } = bridgesUnder(generation);
    const settings = named.get('settings');
    if (settings === undefined) throw new Error('no settings bridge');
    const show = settings['show'] as (argument: unknown) => Promise<{ readonly notice?: unknown }>;

    const answer = await show.call(settings, { screen: 'settings' });

    // The stub's answer is refused by the bridge's parse, so what comes back is its
    // own refusal notice rather than the empty state a transition would give.
    expect(answer).not.toEqual(await settings['forget']?.());
  });
});

describe('guardIdentity (P0-A)', () => {
  const hostWith = (): {
    readonly host: Forgettable & { read(): Promise<string>; label: string };
    readonly forgets: { count: number };
  } => {
    const forgets = { count: 0 };
    return {
      forgets,
      host: {
        label: 'not a function, and not wrapped',
        read: async () => await Promise.resolve('the answer'),
        forget: async () => {
          forgets.count += 1;
          return await Promise.resolve('empty');
        },
      },
    };
  };

  it('clears again and answers the empty state when the generation moved', async () => {
    let generation = 1;
    const { host, forgets } = hostWith();
    const guarded = guardIdentity(host, () => generation);

    const started = guarded.read();
    generation = 2;

    expect(await started).toBe('empty');
    // Twice: once at the announcement, once here, because whatever the late method
    // stored was stored after the first.
    expect(forgets.count).toBe(1);
  });

  it('passes the answer through and forgets nothing when it did not', async () => {
    const generation = 1;
    const { host, forgets } = hostWith();
    const guarded = guardIdentity(host, () => generation);

    expect(await guarded.read()).toBe('the answer');
    expect(forgets.count).toBe(0);
  });

  it('does not wrap forget itself, and keeps what is not a function', async () => {
    let generation = 1;
    const { host, forgets } = hostWith();
    const guarded = guardIdentity(host, () => generation);

    const started = guarded.forget();
    generation = 2;

    expect(await started).toBe('empty');
    expect(forgets.count).toBe(1);
    expect(guarded.label).toBe('not a function, and not wrapped');
  });
});
