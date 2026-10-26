import { z } from 'zod';
import { callingFollowUpListSchema, callingFollowUpReadSchema, callingFollowUpSavedSchema, callingFollowUpSaveInputSchema, callingReceiptSchema,
  type CallingFollowUpMetadata, type CallingFollowUpSaveInput, type CallingFollowUpView } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { type CallingFollowUpPending, type CallingFollowUpAttempt } from './CallingFollowUpPending.ts';

const contentError = z.strictObject({ error: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u) });
const saveAnswer = z.union([
  z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: callingFollowUpSavedSchema }),
  z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u) }), contentError,
]);
export type CallingFollowUpOutcome = { state: 'accepted'; draftId: string; revision: number } | { state: 'refused' } | { state: 'unknown' };
export class CallingFollowUpUnavailable extends Error {}
const check = (current: () => boolean): void => { if (!current()) throw Error('Follow-up view changed'); };
const exactAcceptance = (held: CallingFollowUpAttempt, result: { draftId: string; revision: number }): void => {
  if (result.draftId !== held.draftId || result.revision !== held.expectedRevision + 1) throw Error('Follow-up acceptance changed');
};

/** Closed current reads and explicit writes. Transport/content uncertainty never replays a save. */
export class CallingFollowUpDispatch {
  constructor(readonly client: BrowserClient, readonly custody: CallingFollowUpPending) {}
  async list(afterId: string | undefined, current: () => boolean) {
    check(current);
    const result = await this.client.request('/calling/follow-ups/list', z.union([callingFollowUpListSchema, contentError]), afterId ? { afterId } : {}, () => { check(current); });
    check(current);
    if ('error' in result) throw new CallingFollowUpUnavailable('Follow-ups unavailable');
    if (new Set(result.drafts.map(value => value.draftId)).size !== result.drafts.length) throw new CallingFollowUpUnavailable('Ambiguous follow-up metadata');
    return result;
  }
  async read(metadata: Pick<CallingFollowUpMetadata, 'draftId' | 'revision'>, current: () => boolean): Promise<CallingFollowUpView> {
    check(current);
    const result = await this.client.request('/calling/follow-ups/read', z.union([callingFollowUpReadSchema, contentError]), {
      draftId: metadata.draftId, expectedRevision: metadata.revision,
    }, () => { check(current); });
    check(current);
    if ('error' in result) throw new CallingFollowUpUnavailable('Current follow-up unavailable');
    if (result.draft.draftId !== metadata.draftId || result.draft.revision !== metadata.revision) throw new CallingFollowUpUnavailable('Follow-up revision changed');
    return result.draft;
  }
  async save(raw: CallingFollowUpSaveInput, current: () => boolean): Promise<CallingFollowUpOutcome> {
    const input = callingFollowUpSaveInputSchema.parse(raw);
    return this.custody.exclusive(input.draftId, current, async () => {
      if (this.custody.read(input.draftId)) return { state: 'unknown' };
      const { held, payload } = await this.custody.prepare(input, current);
      try {
        // The browser gateway injects its configured version. It is not part of the payload hash.
        const answer = await this.client.request('/calling/follow-ups/save', saveAnswer, { ...payload, commandId: held.commandId }, () => {
          check(current); this.custody.assert(held);
        });
        check(current);
        if ('error' in answer) return { state: 'unknown' };
        if (answer.status === 'accepted') {
          exactAcceptance(held, answer.result); this.custody.complete(held);
          return { state: 'accepted', ...answer.result };
        }
        this.custody.complete(held);
        return { state: 'refused' };
      } catch { return { state: 'unknown' }; }
    });
  }
  async reconcile(held: CallingFollowUpAttempt, current: () => boolean): Promise<CallingFollowUpOutcome> {
    return this.custody.exclusive(held.draftId, current, async () => {
      this.custody.assert(held);
      const receipt = await this.client.request('/calling/follow-ups/receipt', callingReceiptSchema, {
        operation: 'save', commandId: held.commandId, payloadSHA256: held.payloadSHA256,
      }, () => { check(current); this.custody.assert(held); });
      check(current);
      if (receipt.state === 'unknown') return { state: 'unknown' };
      if (receipt.state === 'accepted') {
        if (receipt.acceptance.operation !== 'save') throw Error('Follow-up receipt operation changed');
        exactAcceptance(held, receipt.acceptance.result); this.custody.complete(held);
        return { state: 'accepted', ...receipt.acceptance.result };
      }
      this.custody.complete(held);
      return { state: 'refused' };
    });
  }
}
