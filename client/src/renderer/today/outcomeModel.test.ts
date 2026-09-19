import { describe, expect, it } from 'vitest';
import { CALL_NOTE_MAX, logCallOutcomeCommandSchema, NEVER_CALL_REASON_MAX, addFirmCommandSchema, todayViewSchema,
  V1_CALL_OUTCOMES, type TodayCard, type TodayView } from '../../../../src/shared/contracts/v1Contract';
import {
  ADD_FIRM_STATES,
  addFirmCommand,
  addFirmProblem,
  emptyAddFirmDraft,
  emptyOutcomeDraft,
  firmRoute,
  logCallOutcomeCommand,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  outcomeProblem,
  outcomeSuppresses,
  withCard,
  type OutcomeDraft,
} from './outcomeModel';

/**
 * The outcome form's and the add-a-firm form's pure models (slice S2): what the ten buttons are, what a draft must
 * carry, and the command each becomes. Nothing here records, dials or sends; the command is a value.
 */
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED = '2026-09-18T14:00:00.000Z';
const draft = (over: Partial<OutcomeDraft> = {}): OutcomeDraft => ({ ...emptyOutcomeDraft(), ...over });

function card(over: Partial<TodayCard> = {}): TodayCard {
  return { firmId: 'account-ri-1', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 1',
    phone: { number: '+14015550201', verification: 'listed' }, website: null, city: 'Providence', state: 'RI',
    timeZone: 'America/New_York', localTime: '10:00', openNow: true, dialAllowed: true, holdReason: null, holdCode: null,
    offer: null, lastOutcome: null, pendingCallback: null, nextStep: { kind: 'first_call' }, ...over };
}
function view(cards: TodayCard[]): TodayView {
  return todayViewSchema.parse({ asOf: OBSERVED, list: { header: { date: '2026-09-18', builtAt: OBSERVED, poolSize: cards.length,
    counts: { replies: 0, callbacks: 0, due: 0, new: cards.length }, holds: [], excluded: {}, lastTick: null, postures: [], statesWithoutPosture: [] },
  lanes: { replies: [], callbacks: [], due: [], new: cards } } });
}

describe('the outcome form model', () => {
  it('offers exactly the contract\'s ten outcomes, each with a label, in the contract\'s order', () => {
    expect(OUTCOME_ORDER).toEqual([...V1_CALL_OUTCOMES]);
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual([...V1_CALL_OUTCOMES].sort());
    for (const label of Object.values(OUTCOME_LABELS)) expect(label.length).toBeGreaterThan(0);
  });

  it('refuses a draft with no outcome, a callback with no day or a bad day, a never-call with no reason, and over-long text', () => {
    expect(outcomeProblem(draft())).toBe('outcome_missing');
    expect(outcomeProblem(draft({ outcome: 'callback' }))).toBe('callback_date_missing');
    expect(outcomeProblem(draft({ outcome: 'callback', callbackOn: 'tuesday' }))).toBe('callback_date_invalid');
    expect(outcomeProblem(draft({ outcome: 'callback', callbackOn: '2026-13-45' }))).toBe('callback_date_invalid');
    expect(outcomeProblem(draft({ outcome: 'callback', callbackOn: '2026-09-22' }))).toBeNull();
    expect(outcomeProblem(draft({ outcome: 'voicemail', neverCall: true }))).toBe('never_call_reason_missing');
    expect(outcomeProblem(draft({ outcome: 'voicemail', neverCall: true, neverCallReason: '   ' }))).toBe('never_call_reason_missing');
    expect(outcomeProblem(draft({ outcome: 'voicemail', neverCall: true, neverCallReason: 'x'.repeat(NEVER_CALL_REASON_MAX + 1) }))).toBe('never_call_reason_too_long');
    expect(outcomeProblem(draft({ outcome: 'voicemail', note: 'x'.repeat(CALL_NOTE_MAX + 1) }))).toBe('note_too_long');
    expect(outcomeProblem(draft({ outcome: 'voicemail', note: 'x'.repeat(CALL_NOTE_MAX) }))).toBeNull();
  });

  it('names the two drafts that suppress the firm for good, so the form can warn before the button is pressed', () => {
    expect(outcomeSuppresses(draft({ outcome: 'opt_out' }))).toBe(true);
    expect(outcomeSuppresses(draft({ outcome: 'voicemail', neverCall: true }))).toBe(true);
    expect(outcomeSuppresses(draft({ outcome: 'voicemail' }))).toBe(false);
    expect(outcomeSuppresses(draft({ outcome: 'answered_not_interested' }))).toBe(false);
  });

  it('builds a command the contract accepts, with the fields the outcome needs and no others', () => {
    const plain = logCallOutcomeCommand({ commandId: COMMAND_ID, firmId: 'account-ri-1', observedAt: OBSERVED, draft: draft({ outcome: 'voicemail' }) });
    expect('command' in plain && logCallOutcomeCommandSchema.parse(plain.command)).toEqual({ commandId: COMMAND_ID, kind: 'log_call_outcome',
      firmId: 'account-ri-1', outcome: 'voicemail', observedAt: OBSERVED });
    const full = logCallOutcomeCommand({ commandId: COMMAND_ID, firmId: 'account-ri-1', observedAt: OBSERVED,
      draft: draft({ outcome: 'callback', callbackOn: ' 2026-09-22 ', note: '  Call back after ten.  ', neverCall: true, neverCallReason: '  Asked us never to call.  ' }) });
    expect('command' in full && logCallOutcomeCommandSchema.parse(full.command)).toEqual({ commandId: COMMAND_ID, kind: 'log_call_outcome',
      firmId: 'account-ri-1', outcome: 'callback', observedAt: OBSERVED, note: 'Call back after ten.', callbackOn: '2026-09-22',
      neverCall: { reason: 'Asked us never to call.' } });
    // A callback date typed against another outcome never travels: the worker only reads it for a callback.
    const other = logCallOutcomeCommand({ commandId: COMMAND_ID, firmId: 'account-ri-1', observedAt: OBSERVED, draft: draft({ outcome: 'busy', callbackOn: '2026-09-22' }) });
    expect('command' in other && 'callbackOn' in other.command).toBe(false);
    expect(logCallOutcomeCommand({ commandId: COMMAND_ID, firmId: 'account-ri-1', observedAt: OBSERVED, draft: draft() })).toEqual({ problem: 'outcome_missing' });
  });
});

describe('the add-a-firm model', () => {
  it('refuses a firm with no name, city or state, an unknown state code, neither handle and both handles', () => {
    expect(addFirmProblem(emptyAddFirmDraft())).toBe('name_missing');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street' })).toBe('city_missing');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street', city: 'Providence' })).toBe('state_missing');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street', city: 'Providence', state: 'ZZ' })).toBe('state_unknown');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street', city: 'Providence', state: 'RI' })).toBe('route_missing');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street', city: 'Providence', state: 'RI', phone: '4015550230', email: 'office@hopestreet.example' })).toBe('both_routes');
    expect(addFirmProblem({ ...emptyAddFirmDraft(), name: 'Hope Street', city: 'Providence', state: 'ri', phone: '4015550230' })).toBeNull();
    expect(ADD_FIRM_STATES).toContain('RI');
    expect(ADD_FIRM_STATES).toContain('TX');
  });

  it('builds a command the contract accepts, upper-casing the state and dropping the fields left blank', () => {
    const built = addFirmCommand({ commandId: COMMAND_ID, draft: { name: '  Hope Street Management  ', city: '  Providence ', state: 'ri',
      phone: ' (401) 555-0230 ', email: '', site: '  https://www.hopestreet.example/about ' } });
    expect('command' in built && addFirmCommandSchema.parse(built.command)).toEqual({ commandId: COMMAND_ID, kind: 'add_firm',
      name: 'Hope Street Management', city: 'Providence', state: 'RI', phone: '(401) 555-0230', site: 'https://www.hopestreet.example/about' });
    expect(addFirmCommand({ commandId: COMMAND_ID, draft: emptyAddFirmDraft() })).toEqual({ problem: 'name_missing' });
  });
});

describe('the card a command returned', () => {
  it('replaces the card in its lane, keeps the counts right, and removes the firm when the answer carries no card', () => {
    const before = view([card(), card({ firmId: 'account-ri-2', name: 'Rhode Island Firm 2' })]);
    const updated = withCard(before, 'account-ri-1', card({ lastOutcome: { outcome: 'voicemail', at: OBSERVED, note: 'Left a message.' } }));
    expect(updated.list!.lanes.new.map(entry => entry.firmId)).toEqual(['account-ri-1', 'account-ri-2']);
    expect(updated.list!.lanes.new[0]!.lastOutcome).toEqual({ outcome: 'voicemail', at: OBSERVED, note: 'Left a message.' });
    expect(updated.list!.header.counts).toEqual({ replies: 0, callbacks: 0, due: 0, new: 2 });
    const removed = withCard(before, 'account-ri-1', null);
    expect(removed.list!.lanes.new.map(entry => entry.firmId)).toEqual(['account-ri-2']);
    expect(removed.list!.header.counts).toEqual({ replies: 0, callbacks: 0, due: 0, new: 1 });
    // A firm the answer does not name, and an empty answer, are left exactly as they were.
    expect(withCard(before, 'account-nobody', null)).toBe(before);
    const empty = todayViewSchema.parse({ asOf: OBSERVED, list: null, reason: 'not_built_yet', postures: [], statesWithoutPosture: [] });
    expect(withCard(empty, 'account-ri-1', card())).toBe(empty);
  });

  it('names one firm\'s page the way the design does', () => {
    expect(firmRoute('account-ri-1')).toBe('/firms/account-ri-1');
  });
});
