import type { FoundationRuntime } from '../foundation/foundationRuntime';
import type { Clock } from '../domain/support/clock';
import { SystemClock } from '../domain/support/clock';
import type { IdGenerator } from '../domain/support/idGenerator';
import { UuidGenerator } from '../domain/support/idGenerator';
import { AccountRepository } from '../domain/accounts/accountRepository';
import { LocalCompanyDraftRepository } from '../domain/accounts/localCompanyDraftRepository';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { companyDraftPrepareReply, prepareCompanyDraftSchema, type PrepareCompanyDraft, type PreparedCompanyDraft } from '../../shared/contracts/localCompanyDraftContract';
import type { OutreachProviders } from './providers/providerTypes';
import { companyDraftFacts } from './companyDraftContext';
import { EMAIL_PLAYBOOK } from './emailPlaybook';

/** Narrow main-only capability. Neither the renderer nor this port can send or save. */
export type CompanyDraftPreparationPort = {
  prepareCompanyDraft(input: PrepareCompanyDraft): Promise<PreparedCompanyDraft>;
};
type Options = {
  runtime: Pick<FoundationRuntime, 'withDatabase' | 'withDomain'>;
  /** `status` is the same read-only setup read the email service uses, here only for the saved sender name. Without it no name is sent. */
  providers: Pick<OutreachProviders, 'generate'> & Partial<Pick<OutreachProviders, 'status'>>;
  clock?: Clock;
  ids?: IdGenerator;
};

export function createCompanyDraftPreparationService(options: Options): CompanyDraftPreparationPort & {
  invalidate(locked?: boolean): void;
  dispose(): void;
} {
  const { runtime, providers } = options;
  const clock = options.clock ?? new SystemClock(), ids = options.ids ?? new UuidGenerator();
  let epoch = 0, locked = false, disposed = false;
  // One bounded flight per workspace. No queue, persisted attempt, cache or automatic retry.
  let flight: { key: string; controller: AbortController; promise: Promise<PreparedCompanyDraft> } | null = null;
  const assertCurrent = (expected: number) => {
    if (disposed || locked || expected !== epoch) throw new Error('company_preparation_inactive');
  };
  const invalidate = (lock?: boolean) => {
    if (lock !== undefined) locked = lock;
    epoch++;
    flight?.controller.abort();
    // Retain a still-running flight, even if its adapter ignores abort, to bound work.
  };
  const observe = async (input: PrepareCompanyDraft, expected: number) => {
    assertCurrent(expected);
    // Readable storage alone is not permission to operate against a blocked domain.
    await runtime.withDomain(() => { assertCurrent(expected); });
    const result = await runtime.withDatabase(database => {
      assertCurrent(expected);
      const read = () => {
        assertCurrent(expected);
        const at = clock.now();
        const accounts = new AccountRepository({ database, clock, ids });
        const current = new LocalCompanyDraftRepository({ database, clock, ids }).get({ accountId: input.accountId, draftId: input.draftId });
        if (!current || current.stale || !current.editable || current.draft.revision !== input.expectedRevision
          || current.draft.subject !== '' || current.draft.body !== '') throw new Error('company_preparation_draft_unavailable');
        const draft = current.draft;
        const eligible = accounts.companyDraftEligibility(input.accountId, draft.recipientBinding.routeId, at, draft.publication);
        if (eligible.route.version !== draft.recipientBinding.routeVersion || eligible.email !== draft.recipientBinding.email) {
          throw new Error('company_preparation_recipient_changed');
        }
        const detail = accounts.readLocalCompanyDetail(input.accountId, at);
        const facts = companyDraftFacts(detail);
        if (!facts.length) throw new Error('company_preparation_facts_unavailable');
        // generatedAt is a read timestamp, not evidence. Fence the complete retained
        // account/source/link/route snapshot, not only the model-selected fact subset.
        const fingerprint = accountFingerprint({ draft, eligible, snapshot: detail.snapshot, sources: detail.sources, links: detail.links });
        return { fingerprint, facts, companyName: detail.snapshot.account.name, accountVersion: detail.snapshot.account.version,
          recipientBinding: draft.recipientBinding };
      };
      return database.raw.inTransaction ? read() : database.raw.transaction(read).deferred();
    });
    assertCurrent(expected);
    return result;
  };
  const run = async (input: PrepareCompanyDraft, expected: number, signal: AbortSignal): Promise<PreparedCompanyDraft> => {
    try {
      const before = await observe(input, expected);
      assertCurrent(expected);
      // The saved sender name is setup data for the sign-off: not evidence (so not fenced by the
      // fingerprint), not send permission, and never defaulted when setup is unset, locked or unreadable.
      const senderName = (await providers.status?.())?.senderName.trim() ?? '';
      assertCurrent(expected);
      const result = await providers.generate({ recipientKind: 'company_business_inbox', companyName: before.companyName,
        purpose: 'prepare_first_conversation', facts: structuredClone(before.facts), playbook: EMAIL_PLAYBOOK,
        ...(senderName ? { senderName } : {}) }, signal);
      assertCurrent(expected);
      const proposal = companyDraftPrepareReply(input).parse({ accountId: input.accountId, draftId: input.draftId,
        baseRevision: input.expectedRevision, accountVersion: before.accountVersion, recipientBinding: before.recipientBinding,
        subject: result.subject, body: result.body,
        grounding: { facts: before.facts, usedFactIds: result.evidenceIds, playbookVersion: '2026-09-08' } });
      const after = await observe(input, expected);
      assertCurrent(expected);
      if (before.fingerprint !== after.fingerprint) throw new Error('company_preparation_evidence_changed');
      return proposal;
    } catch {
      // Provider payloads, source excerpts and arbitrary exception text never escape.
      throw new Error('company_draft_preparation_failed');
    }
  };
  return {
    prepareCompanyDraft(raw) {
      const input = Object.freeze(prepareCompanyDraftSchema.parse(raw));
      assertCurrent(epoch);
      const key = accountFingerprint({ epoch, ...input });
      if (flight) {
        if (flight.key !== key) return Promise.reject(new Error('company_preparation_busy'));
        return flight.promise.then(value => structuredClone(value));
      }
      const controller = new AbortController();
      const promise = run(input, epoch, controller.signal).finally(() => {
        if (flight?.controller === controller) flight = null;
      });
      flight = { key, controller, promise };
      return promise.then(value => structuredClone(value));
    },
    invalidate,
    dispose() { disposed = true; invalidate(); },
  };
}
