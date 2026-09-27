import { describe, expect, it } from 'vitest';

/** Wait for something another task does, without a fixed tick. */
async function eventually(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { createMailboxBridge } from '../src/main/mailboxBridge.ts';
import { createReplyBridge } from '../src/main/replyBridge.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import { guardIdentity, resetBridges, type Forgettable } from '../src/main/identityReset.ts';
import { BRIDGE_ANSWERS, FIXTURE_IDS } from './support/bridgeAnswers.ts';

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

const UUID = FIXTURE_IDS.firm;
const OPPORTUNITY_ID = FIXTURE_IDS.opportunity;
const SEQUENCE_ID = FIXTURE_IDS.sequence;



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
  /**
   * Stop answering. Some bridges read on demand — `settings.state()` asks again when it
   * is holding nothing — so "empty after the reset" is only a real claim when the
   * server can give them nothing: what is left is what was kept in this process.
   */
  serveNothing(): void;
  /**
   * Hold the *next* call inside the server until `release` is called. Only the next:
   * the reset that runs while it is held reads through the same server, and holding
   * everything would deadlock the test rather than order it.
   */
  holdNextCall(): void;
  release(): void;
  /** Whether at least one call is waiting inside the server now. */
  holding(): boolean;
} {
  const answered: string[] = [];
  let serving = true;
  let holdNext = 0;
  const waiting: (() => void)[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.13',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async url => {
      const path = new URL(url).pathname;
      answered.push(path);
      if (holdNext > 0) {
        holdNext -= 1;
        await new Promise<void>(resolve => {
          waiting.push(resolve);
        });
      }
      const body = serving ? BRIDGE_ANSWERS[path] : undefined;
      // Anything this file has not written an answer for is a refusal, so a bridge that
      // needed it fails its own "before" assertion rather than looking empty by accident.
      return await Promise.resolve(
        body === undefined ? { status: 404, body: { error: 'not_found' } } : { status: 200, body },
      );
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
  return {
    named,
    answered,
    serveNothing: () => {
      serving = false;
    },
    holdNextCall: () => {
      holdNext += 1;
    },
    release: () => {
      for (const resume of waiting.splice(0)) resume();
    },
    holding: () => waiting.length > 0,
  };
}

/**
 * One read per bridge, the one a view makes when it opens, and the field of the state
 * it must fill. The field is what makes this check a check: a bridge that answered its
 * read with nothing would be "empty" after the reset without the reset doing anything.
 */
const FIRST_READ: Readonly<
  Record<string, { readonly method: string; readonly input: unknown; readonly holds: (state: unknown) => boolean }>
> = Object.freeze({
  today: { method: 'expand', input: { firmId: UUID }, holds: field('expanded') },
  replies: { method: 'refresh', input: {}, holds: field('cards') },
  crm: { method: 'openFirm', input: { firmId: UUID }, holds: field('firm') },
  /*
   * The list of sequences is read fresh on every `state()`, and a state with no choice
   * on it falls back to the first of the list. So what this bridge *holds* is which
   * sequence the last person had open — the fixture offers two and the test opens the
   * second, which is why the fallback is visible as "not holding".
   */
  sequences: {
    method: 'openSequence',
    input: { sequenceId: SEQUENCE_ID },
    holds: state => (state as { selectedSequenceId?: unknown } | null)?.selectedSequenceId === SEQUENCE_ID,
  },
  settings: { method: 'show', input: { screen: 'settings' }, holds: field('settings') },
  mailbox: { method: 'state', input: undefined, holds: field('status') },
});

/** Whether a state's named field is holding something. */
function field(name: string): (state: unknown) => boolean {
  return state => {
    const value = (state as Record<string, unknown> | null)?.[name];
    if (value === null || value === undefined) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  };
}

/** Read every bridge until it is holding a snapshot of this person's work. */
async function populated(named: ReadonlyMap<string, Forgettable & Record<string, unknown>>): Promise<void> {
  for (const [name, read] of Object.entries(FIRST_READ)) {
    const bridge = named.get(name);
    if (bridge === undefined) throw new Error(`no bridge named ${name}`);
    const call = bridge[read.method] as (argument?: unknown) => Promise<unknown>;
    const state = await call.call(bridge, read.input);
    expect(read.holds(state), `${name}.${read.method} filled nothing`).toBe(true);
  }
}

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

  it('empties a bridge that is really holding something, and every one of them', async () => {
    const generation = { value: 1 };
    const { named, serveNothing } = bridgesUnder(generation);
    await populated(named);

    // The transition: what `registerWindows` does at the announcement.
    generation.value = 2;
    await resetBridges([...named.values()]);
    serveNothing();

    for (const [name, read] of Object.entries(FIRST_READ)) {
      const bridge = named.get(name);
      if (bridge === undefined) throw new Error(`no bridge named ${name}`);
      const state = (await (bridge['state'] as () => Promise<unknown>).call(bridge)) as Record<string, unknown>;
      expect(read.holds(state), `${name} is still holding the last person's work`).toBe(false);
    }
  });

  it('answers the empty state when a read outlives the session it began under', async () => {
    for (const [name, read] of Object.entries(FIRST_READ)) {
      const generation = { value: 1 };
      const { named } = bridgesUnder(generation);
      const bridge = named.get(name);
      if (bridge === undefined) throw new Error(`no bridge named ${name}`);
      const call = bridge[read.method] as (argument?: unknown) => Promise<unknown>;

      const started = call.call(bridge, read.input);
      // Somebody signed out while that read was on the wire.
      generation.value = 2;
      const late = await started;

      // Not merely "equal to forget()": the field that read fills is empty, so the late
      // answer carries nothing of the person who asked for it.
      expect(read.holds(late), `${name}.${read.method} answered from the last session`).toBe(false);
      expect(late, `${name}.${read.method} is not the empty state`).toEqual(await bridge.forget());
    }
  });

  it('forgets which firm carried which opportunity, so the next board offers nothing of the last', async () => {
    /*
     * The CRM bridge remembers the opportunity of every firm page it opened, and merges
     * that into the next board read — the board the *server* sends carries an id only
     * for a firm this caller may change. Left across a transition, the map offered the
     * next person a stage change on the last person's firm, naming an opportunity id
     * that is not theirs.
     */
    const generation = { value: 1 };
    const { named } = bridgesUnder(generation);
    const crm = named.get('crm');
    if (crm === undefined) throw new Error('no crm bridge');
    const opened = (await (crm['openFirm'] as (input: unknown) => Promise<unknown>).call(crm, { firmId: UUID })) as {
      readonly firm: unknown;
    };
    expect(opened.firm).not.toBeNull();
    const before = (await (crm['openPipeline'] as () => Promise<unknown>).call(crm)) as {
      readonly pipeline: { readonly opportunityIdByFirmId: Record<string, string> } | null;
    };
    // The firm page told this window, and the board took it: that is the behaviour the
    // reset has to undo, and asserting it here is what stops this passing vacuously.
    expect(before.pipeline?.opportunityIdByFirmId[UUID]).toBe(OPPORTUNITY_ID);

    generation.value = 2;
    await resetBridges([crm]);

    const after = (await (crm['openPipeline'] as () => Promise<unknown>).call(crm)) as {
      readonly pipeline: { readonly opportunityIdByFirmId: Record<string, string> } | null;
    };
    expect(after.pipeline?.opportunityIdByFirmId).toEqual({});
  });

  it('does not repopulate a bridge when the stale read lands after the reset', async () => {
    for (const [name, read] of Object.entries(FIRST_READ)) {
      const generation = { value: 1 };
      const { named, serveNothing, holdNextCall, release, holding } = bridgesUnder(generation);
      const bridge = named.get(name);
      if (bridge === undefined) throw new Error(`no bridge named ${name}`);
      const call = bridge[read.method] as (argument?: unknown) => Promise<unknown>;

      // Held inside the server, so the order is the test's and not the scheduler's: the
      // read is on the wire, the person leaves, the reset runs, and only then does the
      // answer arrive.
      holdNextCall();
      const started = call.call(bridge, read.input);
      await eventually(() => holding(), `${name} to reach the server`);
      generation.value = 2;
      await resetBridges([bridge]);
      release();
      await started;
      serveNothing();

      // What the next person's first look at this view finds.
      const state = await (bridge['state'] as () => Promise<unknown>).call(bridge);
      expect(read.holds(state), `${name} was refilled by a read from the last session`).toBe(false);
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

  it('clears again when the session moves during a clear, and stops after three passes', async () => {
    /*
     * `forget()` is asynchronous. A transition landing while one is running can put
     * something into the bridge behind it — the clear returns having missed it. So the
     * generation is taken before each clear and checked after, and the clear repeats.
     * The bound is three: a Mac transitioning continuously is being cleared by those
     * transitions anyway, and an unbounded loop here would never answer the caller.
     */
    let generation = 1;
    const clears: number[] = [];
    const held: { release: (() => void) | null } = { release: null };
    const host = {
      read: async () => await Promise.resolve('the answer'),
      forget: async (): Promise<string> => {
        clears.push(generation);
        // Held open, so the test can move the session while this clear is running.
        await new Promise<void>(resolve => {
          held.release = resolve;
        });
        return 'empty';
      },
    };
    const guarded = guardIdentity(host, () => generation);

    const started = guarded.read();
    generation = 2;
    // Let the read finish and reach the first clear.
    await eventually(() => held.release !== null, 'the first clear to start');

    // Every clear finds the session has moved again, so every one is repeated.
    for (let pass = 0; pass < 4; pass += 1) {
      const waiting = held.release;
      held.release = null;
      generation += 1;
      waiting?.();
      await eventually(() => held.release !== null || clears.length >= 3, 'the next clear');
      if (held.release === null) break;
    }
    held.release?.();

    expect(await started).toBe('empty');
    expect(clears).toHaveLength(3);
  });

  it('stops clearing as soon as one clear finishes with nothing moving under it', async () => {
    let generation = 1;
    let clears = 0;
    const host = {
      read: async () => await Promise.resolve('the answer'),
      forget: async (): Promise<string> => {
        clears += 1;
        return await Promise.resolve('empty');
      },
    };
    const guarded = guardIdentity(host, () => generation);

    const started = guarded.read();
    generation = 2;

    expect(await started).toBe('empty');
    expect(clears).toBe(1);
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
