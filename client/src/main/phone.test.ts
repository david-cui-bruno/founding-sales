import { describe, expect, it, vi } from 'vitest';
import { todayViewSchema, type TodayCard, type TodayView } from '../../../src/shared/contracts/v1Contract';
import { DIAL_REFUSAL_SENTENCES, dialResultSchema } from '../shared/clientContract';
import { cardOfView, ClientPhone, createProductionDialLauncher, type HandoffLauncher, type HeldView } from './phone';

/**
 * The Phone.app handoff's refusal rules, on an injected launcher (slice S2). Nothing here launches anything, reads
 * the OS or touches a helper: the launcher is a fake, so what is under test is the gate in front of it. The gate's
 * source of truth is the worker's own verdict on the card, not anything the renderer says.
 *
 * Every number is fictional. The injected launcher's own excluded-number rule is bypassed only where the test says
 * so; the production rules are exercised through the real `isExcludedNumber` in the excluded-number case.
 */
const NOW = Date.parse('2026-09-18T14:00:00.000Z');
const RI_PHONE = '+14015550201';

function card(over: Partial<TodayCard> = {}): TodayCard {
  return {
    firmId: 'account-ri-1', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 1',
    phone: { number: RI_PHONE, verification: 'listed' }, website: 'rifirm1.example', city: 'Providence', state: 'RI',
    timeZone: 'America/New_York', localTime: '10:00', openNow: true, dialAllowed: true, holdReason: null, holdCode: null,
    offer: 'A short introductory call.', lastOutcome: null, pendingCallback: null, nextStep: { kind: 'first_call' }, ...over,
  };
}
function view(cards: TodayCard[]): TodayView {
  return todayViewSchema.parse({
    asOf: '2026-09-18T14:00:00.000Z',
    list: {
      header: { date: '2026-09-18', builtAt: '2026-09-18T09:05:00.000Z', poolSize: cards.length,
        counts: { replies: 0, callbacks: 0, due: 0, new: cards.length }, holds: [], excluded: {}, lastTick: null, postures: [], statesWithoutPosture: [] },
      lanes: { replies: [], callbacks: [], due: [], new: cards },
    },
  });
}
const accepting = (): HandoffLauncher & { dispatched: string[] } => {
  const dispatched: string[] = [];
  return { dispatched,
    inspectCapability: async () => ({ state: 'available', reasonCode: null }),
    dispatch: async (phone: string) => { dispatched.push(phone); return { status: 'handoff_accepted', reasonCode: null }; } };
};
function phone(input: { held: HeldView | null; launcher?: HandoffLauncher | null; now?: number; excluded?: (value: string) => boolean }) {
  return new ClientPhone({ heldView: () => input.held, launcher: async () => input.launcher ?? null,
    now: () => input.now ?? NOW, ...(input.excluded ? { isExcludedNumber: input.excluded } : {}) });
}
const fresh = (cards: TodayCard[]): HeldView => ({ view: view(cards), fetchedAt: '2026-09-18T13:59:30.000Z' });

describe('the Phone.app handoff gate', () => {
  it('hands the number off when the worker allowed the dial and the view is fresh, and never dials anything else', async () => {
    const launcher = accepting();
    const result = await phone({ held: fresh([card()]), launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE });
    expect(dialResultSchema.parse(result)).toEqual({ outcome: 'handed_off', number: RI_PHONE });
    expect(launcher.dispatched).toEqual([RI_PHONE]);
  });

  it('refuses with no list, with a list older than two minutes, and with a firm the list does not name', async () => {
    const launcher = accepting();
    expect(await phone({ held: null, launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'no_view', sentence: DIAL_REFUSAL_SENTENCES.no_view });
    // Exactly two minutes is already stale: the window is "under two minutes", not "two minutes or less".
    for (const fetchedAt of ['2026-09-18T13:58:00.000Z', '2026-09-18T13:00:00.000Z', 'not an instant']) {
      expect(await phone({ held: { view: view([card()]), fetchedAt }, launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
        .toEqual({ outcome: 'refused', reason: 'view_stale', sentence: DIAL_REFUSAL_SENTENCES.view_stale });
    }
    expect(await phone({ held: fresh([card()]), launcher, excluded: () => false }).dial({ firmId: 'account-nobody', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'card_unknown', sentence: DIAL_REFUSAL_SENTENCES.card_unknown });
    expect(await phone({ held: { view: todayViewSchema.parse({ asOf: '2026-09-18T14:00:00.000Z', list: null, reason: 'not_built_yet', postures: [], statesWithoutPosture: [] }), fetchedAt: '2026-09-18T13:59:30.000Z' },
      launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'card_unknown', sentence: DIAL_REFUSAL_SENTENCES.card_unknown });
    expect(launcher.dispatched).toEqual([]);
  });

  it('refuses a card the worker held, a suppressed firm before anything else, and a number that is not the card\'s', async () => {
    const launcher = accepting();
    expect(await phone({ held: fresh([card({ dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours' })]), launcher, excluded: () => false })
      .dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'dial_not_allowed', sentence: DIAL_REFUSAL_SENTENCES.dial_not_allowed });
    // Suppressed is checked before dialAllowed, so the reason David reads is the real one even on a card that also says allowed.
    expect(await phone({ held: fresh([card({ dialAllowed: true, holdReason: 'suppressed', holdCode: 'suppressed' })]), launcher, excluded: () => false })
      .dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'suppressed', sentence: DIAL_REFUSAL_SENTENCES.suppressed });
    for (const number of ['+14015550299', '4015550201', ` ${RI_PHONE}`, `${RI_PHONE}\n`]) {
      expect(await phone({ held: fresh([card()]), launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number }))
        .toEqual({ outcome: 'refused', reason: 'number_mismatch', sentence: DIAL_REFUSAL_SENTENCES.number_mismatch });
    }
    expect(await phone({ held: fresh([card({ phone: null })]), launcher, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'number_mismatch', sentence: DIAL_REFUSAL_SENTENCES.number_mismatch });
    expect(launcher.dispatched).toEqual([]);
  });

  it('refuses the numbers the production rules exclude, through the real excluded-number check', async () => {
    const launcher = accepting();
    // The reserved fictional block, a service code, a plant-test exchange and a short code, each on its own card.
    for (const number of ['+14015550150', '+1401911 0201'.replace(/\s/g, ''), '+14019580201', '+1401']) {
      const result = await phone({ held: fresh([card({ phone: { number, verification: 'listed' } })]), launcher })
        .dial({ firmId: 'account-ri-1', number });
      expect({ number, result }).toEqual({ number, result: { outcome: 'refused', reason: 'number_excluded', sentence: DIAL_REFUSAL_SENTENCES.number_excluded } });
    }
    // A thrown excluded-number check is a refusal, never a pass.
    expect(await phone({ held: fresh([card()]), launcher, excluded: () => { throw new Error('fictional'); } }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'number_excluded', sentence: DIAL_REFUSAL_SENTENCES.number_excluded });
    expect(launcher.dispatched).toEqual([]);
  });

  it('says the route is unavailable with no launcher, with one that inspects unavailable, and with one that throws', async () => {
    const unavailable = DIAL_REFUSAL_SENTENCES.route_unavailable;
    expect(await phone({ held: fresh([card()]), launcher: null, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'route_unavailable', sentence: unavailable });
    const held = fresh([card()]);
    const inspectUnavailable: HandoffLauncher = { inspectCapability: async () => ({ state: 'unavailable', reasonCode: 'phone_route_unverified' }),
      dispatch: vi.fn(async () => ({ status: 'unavailable' as const, reasonCode: 'phone_route_unverified' })) };
    expect(await phone({ held, launcher: inspectUnavailable, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'route_unavailable', sentence: unavailable });
    expect(inspectUnavailable.dispatch).not.toHaveBeenCalled();
    const throwing: HandoffLauncher = { inspectCapability: async () => { throw new Error('fictional'); }, dispatch: async () => ({ status: 'unknown', reasonCode: null }) };
    expect(await phone({ held, launcher: throwing, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'route_unavailable', sentence: unavailable });
    const rejecting = new ClientPhone({ heldView: () => held, launcher: async () => { throw new Error('fictional'); }, now: () => NOW, isExcludedNumber: () => false });
    expect(await rejecting.dial({ firmId: 'account-ri-1', number: RI_PHONE })).toEqual({ outcome: 'refused', reason: 'route_unavailable', sentence: unavailable });
  });

  it('reports an uncertain handoff as unknown, never as a call, and a refused dispatch as an excluded number', async () => {
    const held = fresh([card()]);
    const uncertain: HandoffLauncher = { inspectCapability: async () => ({ state: 'available', reasonCode: null }),
      dispatch: async () => ({ status: 'unknown', reasonCode: 'handoff_uncertain' }) };
    expect(dialResultSchema.parse(await phone({ held, launcher: uncertain, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE })))
      .toEqual({ outcome: 'unknown', reason: 'handoff_uncertain', sentence: DIAL_REFUSAL_SENTENCES.handoff_uncertain });
    const refusing: HandoffLauncher = { inspectCapability: async () => ({ state: 'available', reasonCode: null }),
      dispatch: async () => ({ status: 'refused', reasonCode: 'invalid_target' }) };
    expect(await phone({ held, launcher: refusing, excluded: () => false }).dial({ firmId: 'account-ri-1', number: RI_PHONE }))
      .toEqual({ outcome: 'refused', reason: 'number_excluded', sentence: DIAL_REFUSAL_SENTENCES.number_excluded });
  });

  it('finds the card in whichever lane it stands in, and none in an empty answer', () => {
    const replies = card({ firmId: 'account-reply-1', lane: 'replies', reason: 'reply_waiting', nextStep: { kind: 'reply' } });
    const built = todayViewSchema.parse({ ...view([card()]), list: { ...view([card()]).list!, lanes: { replies: [replies], callbacks: [], due: [], new: [card()] } } });
    expect(cardOfView(built, 'account-reply-1')?.lane).toBe('replies');
    expect(cardOfView(built, 'account-ri-1')?.lane).toBe('new');
    expect(cardOfView(built, 'account-nobody')).toBeNull();
  });

  it('has no phone route at all off macOS or in an unpackaged build, which is what a development run is', async () => {
    const options = { clientDirectory: '/tmp/fictional-client', isPackaged: false, resourcesPath: '/Fictional/Callie.app/Contents/Resources', parentExecutablePath: '/Fictional/Callie.app/Contents/MacOS/Callie' };
    expect(await createProductionDialLauncher({ ...options, platform: 'darwin' })()).toBeNull();
    expect(await createProductionDialLauncher({ ...options, isPackaged: true, platform: 'linux' })()).toBeNull();
    // A packaged macOS build whose resources path is not a real bundle resolves to no route rather than throwing.
    expect(await createProductionDialLauncher({ ...options, isPackaged: true, platform: 'darwin', resourcesPath: '/not/a/bundle' })()).toBeNull();
  });
});
