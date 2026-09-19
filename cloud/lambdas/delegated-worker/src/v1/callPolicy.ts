import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { callPolicyViewSchema, v1StateCodeSchema, type CallPolicyView, type SetCallPolicyCommand } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { CALL_WINDOW_DAYS, CALL_WINDOW_FLOOR, narrowCallWindow, type CallWindow } from './callWindow';

/**
 * `SETTINGS#calls` (FSS target design section 2; slice S5): the call hours David narrowed the code floor to, and
 * the per-state narrowing under them.
 *
 * The floor is Monday to Friday, 08:00 to 20:00 on the firm's own clock, fixed in code. Settings may only make it
 * smaller. The seam is S1's `callWindow.narrowCallWindow`, called here and never forked: a window is admissible
 * exactly when narrowing it leaves it unchanged, which is the same arithmetic the dial evaluation runs, so the
 * hours David sees on the card and the hours this control accepts can never drift apart.
 *
 * Storing hours is not permission to call. The dial evaluation still computes `dialAllowed` at request time from
 * the firm's own zone, and a firm whose state has no calling posture is held whatever these hours say.
 */

export const CALL_POLICY_KEY = 'SETTINGS#calls';

const minuteOfDay = z.number().int().min(0).max(24 * 60);
const windowSchema = z.strictObject({ startMinute: minuteOfDay, endMinute: minuteOfDay });
export const callPolicyRecordSchema = z.strictObject({
  version: z.literal(1),
  /** The window every state uses unless `byState` names a narrower one. Always inside the floor. */
  window: windowSchema,
  byState: z.array(z.strictObject({ state: v1StateCodeSchema, window: windowSchema })).max(60),
  capPerRun: z.number().int().positive().max(1000).nullable(),
  revision: z.number().int().positive(),
  updatedAt: accountInstantSchema,
  updatedBy: z.string().min(1).max(80),
});
export type CallPolicyRecord = z.infer<typeof callPolicyRecordSchema>;

/** Whether the floor contains this window exactly: narrowing it changes nothing. The seam decides, not a copy of it. */
export function insideFloor(window: CallWindow): boolean {
  const narrowed = narrowCallWindow(window);
  return narrowed.startMinute === window.startMinute && narrowed.endMinute === window.endMinute;
}

export async function readCallPolicy(store: DynamoStore): Promise<{ record: CallPolicyRecord | null; rev: number | null }> {
  const row = await store.get<unknown>(CALL_POLICY_KEY);
  if (!row) return { record: null, rev: null };
  const parsed = callPolicyRecordSchema.safeParse(row.data);
  return { record: parsed.success ? parsed.data : null, rev: row.rev };
}

/** The window that applies to one state: the per-state narrowing when there is one, otherwise the policy's own. */
export function windowForState(record: CallPolicyRecord | null, state: string | null): CallWindow {
  if (!record) return CALL_WINDOW_FLOOR;
  const narrower = state === null ? undefined : record.byState.find(entry => entry.state === state);
  return narrowCallWindow(narrower ? narrower.window : record.window);
}

/** The section as Settings shows it, with the floor beside it so the page can say what may not be widened. */
export function callPolicyView(record: CallPolicyRecord | null): CallPolicyView {
  return callPolicyViewSchema.parse({
    floor: { days: [...CALL_WINDOW_DAYS], window: { ...CALL_WINDOW_FLOOR } },
    window: record ? record.window : { ...CALL_WINDOW_FLOOR },
    byState: record ? record.byState.map(entry => ({ state: entry.state, window: { ...entry.window } })) : [],
    capPerRun: record?.capPerRun ?? null,
    revision: record?.revision ?? 0,
    updatedAt: record?.updatedAt ?? null,
  });
}

export type CallPolicyRefusal = 'call_policy_outside_floor' | 'call_policy_empty';

/**
 * The fenced put for one `set_call_policy`, for the router's receipt transaction. Every window in the request is
 * checked against the floor before anything is written, so a request that would widen any hour is refused whole
 * rather than partly applied; an omitted field keeps what is stored. CAS on the stored revision.
 */
export async function planSetCallPolicy(store: DynamoStore, command: SetCallPolicyCommand, updatedBy: string):
Promise<{ item: TransactWriteItem; record: CallPolicyRecord } | { refused: CallPolicyRefusal }> {
  const proposed = [...(command.window ? [command.window] : []), ...(command.byState ?? []).map(entry => entry.window)];
  for (const window of proposed) {
    if (window.startMinute >= window.endMinute) return { refused: 'call_policy_empty' };
    if (!insideFloor(window)) return { refused: 'call_policy_outside_floor' };
  }
  const held = await readCallPolicy(store);
  const base: Omit<CallPolicyRecord, 'revision' | 'updatedAt' | 'updatedBy'> = held.record
    ? { version: 1, window: held.record.window, byState: held.record.byState, capPerRun: held.record.capPerRun }
    : { version: 1, window: { ...CALL_WINDOW_FLOOR }, byState: [], capPerRun: null };
  const record = callPolicyRecordSchema.parse({
    ...base,
    ...(command.window === undefined ? {} : { window: command.window }),
    // The per-state list arrives whole: naming one state's hours replaces the list, so a state left out is back on
    // the policy's own window rather than silently keeping hours David thinks he removed.
    ...(command.byState === undefined ? {} : { byState: [...command.byState].sort((a, b) => a.state < b.state ? -1 : a.state > b.state ? 1 : 0) }),
    ...(command.capPerRun === undefined ? {} : { capPerRun: command.capPerRun }),
    revision: (held.record?.revision ?? 0) + 1,
    updatedAt: store.now(),
    updatedBy,
  });
  return { item: store.put(CALL_POLICY_KEY, record, held.rev), record };
}
