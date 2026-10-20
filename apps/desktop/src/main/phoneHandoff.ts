import { randomUUID } from 'node:crypto';
import { phoneHandoffResultSchema } from '@fss/contracts';
import type { AuthedClient } from './authedClient.ts';
import type { DialHandoff } from './dialHandoff.ts';

interface Target {
  readonly expectedNationalDncReceiptId?: string | null;
  readonly firmId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly e164: string;
}
export interface PhoneHandoffAnswer {
  readonly notice: string;
  readonly attemptId?: string;
}

/** Main-process gate. A duplicate/lost-answer command is reconciled, NEVER dispatched again. */
export function createPhoneHandoff(deps: { readonly api: AuthedClient; readonly handoff: DialHandoff;
  readonly monotonic?: () => number; readonly wallNow?: () => number }) {
  const monotonic = deps.monotonic ?? (() => performance.now());
  const wallNow = deps.wallNow ?? (() => Date.now());
  const pending = new Map<string, { commandId: string; attemptId?: string; expectedNationalDncReceiptId: string | null }>();
  const opened = new Set<string>();
  let busy = false;
  let generation = 0;
  return {
    forget(): void { generation += 1; pending.clear(); },
    complete(attemptId: string): void {
      for (const [key, entry] of pending) if (entry.attemptId === attemptId) pending.delete(key);
    },
    async dispatch(target: Target, current: () => boolean): Promise<PhoneHandoffAnswer> {
      if (busy) return { notice: 'handoff_reconciliation_required' };
      busy = true;
      const mine = generation;
      const live = (): boolean => current() && generation === mine;
      try {
        const setup = await deps.handoff.checkSetup();
        if (!live()) return { notice: 'handoff_reconciliation_required' };
        if (!setup.ready) return { notice: setup.reason };
        const key = `${target.firmId}:${target.routeId}`;
        const entry = pending.get(key) ?? { commandId: randomUUID(), expectedNationalDncReceiptId: target.expectedNationalDncReceiptId ?? null };
        pending.set(key, entry);
        const start = monotonic();
        const response = await deps.api.command('/dial/handoff', {
          firmId: target.firmId, routeId: target.routeId, routeVersion: target.routeVersion,
          ...(entry.expectedNationalDncReceiptId === null ? {} : { expectedNationalDncReceiptId: entry.expectedNationalDncReceiptId }),
        }, value => phoneHandoffResultSchema.parse(value), { commandId: entry.commandId });
        // An ambiguous network/parse failure retains this command for nonactionable reconciliation.
        if (!response.ok) {
          const refused = !response.offline && typeof response.refusal === 'object' && response.refusal !== null &&
            'status' in response.refusal && response.refusal.status === 'refused';
          if (refused) pending.delete(key);
          return { notice: refused ? response.reason : 'handoff_reconciliation_required' };
        }
        const result = response.value;
        entry.attemptId = result.attemptId;
        if (!live()) return { notice: 'handoff_reconciliation_required' };
        const identity = { attemptId: result.attemptId };
        if (!result.actionable || opened.has(result.attemptId)) return { ...identity, notice: 'handoff_reconciliation_required' };
        if (result.nationalDnc?.status === 'not_checked_owner_risk'
          ? !entry.expectedNationalDncReceiptId || result.nationalDnc.receiptId !== entry.expectedNationalDncReceiptId
          : entry.expectedNationalDncReceiptId !== null) return { ...identity, notice: 'handoff_reconciliation_required' };
        if (result.firmId !== target.firmId || result.routeId !== target.routeId || result.e164 !== target.e164 ||
            monotonic() - start >= result.validForMilliseconds || wallNow() >= Date.parse(result.expiresAt)) {
          return { ...identity, notice: 'handoff_reconciliation_required' };
        }
        // Mark used BEFORE the OS port. A synchronous throw can still mean dispatch.
        opened.add(result.attemptId);
        try {
          const outcome = await deps.handoff.open({ telUri: result.telUri, e164: result.e164 });
          return { ...identity, notice: outcome.status === 'opened' ? 'dial_opened' : outcome.status === 'opened_unknown' ? 'dial_opened_unknown' : outcome.reason };
        } catch { return { ...identity, notice: 'dial_opened_unknown' }; }
      } finally { busy = false; }
    },
  };
}
