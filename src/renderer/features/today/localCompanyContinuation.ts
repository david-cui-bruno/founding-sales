import type { AccountEvidenceReceipt } from '../../../shared/contracts/accountContract';
import { accountEvidenceReceiptSchema, type LinkCompanyPersonRequest, type LocalCompanyResearchStatus, type SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';

const epochBrand = Symbol('first-use-epoch');
const executionBrand = Symbol('research-execution');
const linkExecutionBrand = Symbol('link-execution');
const observationBrand = Symbol('research-observation');
export type FirstUseEpoch = Readonly<{ [epochBrand]: true }>;
export type ResearchExecutionToken = Readonly<{ [executionBrand]: true }>;
export type ResearchObservationToken = Readonly<{ [observationBrand]: true }>;
export type LinkExecutionToken = Readonly<{ [linkExecutionBrand]: true }>;
export type FirstUseReview = {
  accountId: string | null; personId: string | null; role: string; relationship: string;
  sourceQuotes: { sourceId: string; quote: string }[];
};
export type FirstUseState = {
  review: FirstUseReview;
  link: Readonly<{ request: LinkCompanyPersonRequest; outcome: 'pending' | 'unknown' | 'known' }> | null;
  selectedAccountId: string | null;
  research: Readonly<{
    request: Readonly<SelectedResearch>;
    outcome: 'pending' | 'unknown' | 'known';
    status: LocalCompanyResearchStatus | null;
  }> | null;
};
export interface FirstUseContinuation {
  snapshot(): Readonly<FirstUseState>;
  subscribe(listener: () => void): () => void;
  captureEpoch(): FirstUseEpoch;
  isCurrent(epoch: FirstUseEpoch): boolean;
  selectAccount(epoch: FirstUseEpoch, accountId: string | null): boolean;
  updateReview(epoch: FirstUseEpoch, review: FirstUseReview): boolean;
  discardReview(epoch: FirstUseEpoch): boolean;
  beginLink(epoch: FirstUseEpoch, request: LinkCompanyPersonRequest): LinkExecutionToken | null;
  settleLink(token: LinkExecutionToken, result: { outcome: 'known'; receipt: AccountEvidenceReceipt } | { outcome: 'unknown' }): boolean;
  beginResearch(epoch: FirstUseEpoch, request: Readonly<SelectedResearch>): ResearchExecutionToken | null;
  settleResearch(token: ResearchExecutionToken, result: { outcome: 'known'; status: LocalCompanyResearchStatus } | { outcome: 'unknown' }): boolean;
  beginResearchStatus(epoch: FirstUseEpoch, request: Readonly<SelectedResearch>): ResearchObservationToken | null;
  acceptResearchStatus(token: ResearchObservationToken, status: LocalCompanyResearchStatus): boolean;
}

const copyStatus = (status: LocalCompanyResearchStatus): LocalCompanyResearchStatus => Object.freeze({
  ...status, receipt: status.receipt === null ? null : Object.freeze({ ...status.receipt }),
});
const matches = (request: Readonly<SelectedResearch>, status: LocalCompanyResearchStatus) =>
  status !== null && typeof status === 'object'
  && status.accountId === request.accountId && status.commandId === request.commandId
  && (status.receipt === null || status.receipt !== null && typeof status.receipt === 'object'
    && status.receipt.accountId === request.accountId);

// Always copy, including when a caller has only shallow-frozen the outer object.
const immutableCopy = <T,>(value: T): T => {
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutableCopy(item))) as T;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]))) as T;
  }
  return value;
};
const emptyReview = (): FirstUseReview => immutableCopy({ accountId: null, personId: null, role: '', relationship: '', sourceQuotes: [] });
const dirtyReview = (review: FirstUseReview) => review.personId !== null || !!review.role || !!review.relationship || review.sourceQuotes.length > 0;

/** One bundle per existing intake Owner. No transport, timers, or global state. */
export function createLocalCompanyContinuation() {
  let active = false;
  let epoch: FirstUseEpoch = Object.freeze({ [epochBrand]: true });
  let state: Readonly<FirstUseState> = Object.freeze({ selectedAccountId: null, research: null, review: emptyReview(), link: null });
  let execution: ResearchExecutionToken | null = null;
  let linkExecution: LinkExecutionToken | null = null;
  let observation: ResearchObservationToken | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: FirstUseState) => {
    state = Object.freeze({ ...next, link: next.link === null ? null : Object.freeze(next.link), research: next.research === null ? null : Object.freeze(next.research) });
    for (const listener of listeners) listener();
  };
  const isCurrent = (candidate: FirstUseEpoch) => active && candidate === epoch;
  const lifecycle = (nextActive: boolean) => {
    // Fence every token family before notifying any subscriber.
    active = nextActive;
    epoch = Object.freeze({ [epochBrand]: true });
    execution = null;
    observation = null;
    linkExecution = null;
    publish({ ...state, link: state.link?.outcome === 'pending' ? { ...state.link, outcome: 'unknown' } : state.link, research: state.research?.outcome === 'pending'
      ? { ...state.research, outcome: 'unknown' } : state.research });
  };
  const continuation: FirstUseContinuation = {
    snapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    captureEpoch: () => epoch,
    isCurrent,
    selectAccount: (candidate, accountId) => {
      if (!isCurrent(candidate)) return false;
      if (state.selectedAccountId !== accountId) publish({ ...state, selectedAccountId: accountId });
      return true;
    },
    updateReview: (candidate, review) => {
      if (!isCurrent(candidate) || review.accountId !== state.selectedAccountId
        || state.link && state.link.outcome !== 'known'
        || dirtyReview(state.review) && state.review.accountId !== review.accountId) return false;
      publish({ ...state, review: immutableCopy(review) });
      return true;
    },
    discardReview: candidate => {
      if (!isCurrent(candidate) || state.link && state.link.outcome !== 'known') return false;
      publish({ ...state, review: emptyReview() });
      return true;
    },
    beginLink: (candidate, input) => {
      if (!isCurrent(candidate) || state.selectedAccountId !== input.accountId || execution !== null
        || dirtyReview(state.review) && state.review.accountId !== input.accountId) return null;
      const previous = state.link;
      if (previous && (previous.outcome === 'pending'
        || previous.outcome === 'unknown' && previous.request !== input)) return null;
      const request = previous?.request === input ? previous.request : immutableCopy(input);
      const token: LinkExecutionToken = Object.freeze({ [linkExecutionBrand]: true });
      linkExecution = token;
      publish({ ...state, link: { request, outcome: 'pending' } });
      return token;
    },
    settleLink: (token, result) => {
      const current = state.link;
      if (!active || linkExecution !== token || !current) return false;
      linkExecution = null;
      const receipt = result.outcome === 'known' ? accountEvidenceReceiptSchema.safeParse(result.receipt) : null;
      const known = receipt?.success && receipt.data.accountId === current.request.accountId;
      publish({ ...state, link: { ...current, outcome: known ? 'known' : 'unknown' } });
      return true;
    },
    beginResearch: (candidate, input) => {
      if (!isCurrent(candidate) || state.selectedAccountId !== input.accountId) return null;
      const previous = state.research;
      if (state.link && state.link.outcome !== 'known' && previous?.request !== input) return null;
      if (previous) {
        if (previous.request === input) {
          if (previous.outcome === 'pending' || previous.status?.state === 'parked') return null;
        } else if (previous.outcome !== 'known' || !previous.status
          || !['completed', 'parked', 'held'].includes(previous.status.state)) return null;
      }
      const request = Object.isFrozen(input) ? input : Object.freeze({ ...input });
      const token: ResearchExecutionToken = Object.freeze({ [executionBrand]: true });
      execution = token;
      observation = null;
      publish({ ...state, research: { request, outcome: 'pending', status: previous?.request === request ? previous.status : null } });
      return token;
    },
    settleResearch: (token, result) => {
      const current = state.research;
      if (!active || execution !== token || !current) return false;
      execution = null;
      observation = null;
      if (result.outcome === 'known' && matches(current.request, result.status)) {
        publish({ ...state, research: { ...current, outcome: 'known', status: copyStatus(result.status) } });
      } else publish({ ...state, research: { ...current, outcome: 'unknown' } });
      return true;
    },
    beginResearchStatus: (candidate, request) => {
      if (!isCurrent(candidate) || state.research?.request !== request) return null;
      const token: ResearchObservationToken = Object.freeze({ [observationBrand]: true });
      observation = token;
      return token;
    },
    acceptResearchStatus: (token, status) => {
      const current = state.research;
      if (!active || observation !== token || !current || !matches(current.request, status)) return false;
      observation = null;
      publish({ ...state, research: { ...current, outcome: execution ? 'pending' : 'known', status: copyStatus(status) } });
      return true;
    },
  };
  return { continuation, activate: () => lifecycle(true), invalidate: () => lifecycle(false) };
}
