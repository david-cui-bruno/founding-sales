import { localCompanyInputSchema, localCompanyCreateRequestSchema } from '../../shared/contracts/localCompanyIntakeContract';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { linkCompanyPersonRequestSchema, localWorkflowTransitionSchema, selectedCompanySchema, selectedResearchSchema, localCompanyResearchStatusSchema, type SelectedResearch, type LocalCompanyResearchStatus, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { projectLocalWorkflowReceipt, readLocalWorkspace } from '../domain/workspace/localWorkspaceReadService';
import { AccountRepository } from '../domain/accounts/accountRepository';
import { SystemClock } from '../domain/support/clock';
import { UuidGenerator } from '../domain/support/idGenerator';
/** Main-only execution capability. Status remains a separate storage-only read. */
export type SelectedCompanyResearchPort = {
  researchCompany(input: SelectedResearch): Promise<LocalCompanyResearchStatus>;
};
export function createLocalWorkspaceProvider(runtime: Pick<FoundationRuntime, 'withDatabase' | 'withDomain'>,
  research?: { current(): SelectedCompanyResearchPort | null }): LocalWorkspaceApi {
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const validateStatus = (selected: SelectedResearch, value: unknown): LocalCompanyResearchStatus => {
    const result = localCompanyResearchStatusSchema.parse(value);
    if (result.accountId !== selected.accountId || result.commandId !== selected.commandId) throw new Error('Selected research identity mismatch');
    return result;
  };
  const readStatus = (selected: SelectedResearch) => runtime.withDatabase(database =>
    validateStatus(selected, new AccountRepository({ database, clock, ids }).readSelectedResearch(selected)));
  const unavailable = (saved: LocalCompanyResearchStatus, reason: string): LocalCompanyResearchStatus =>
    saved.state === 'not_recorded' ? { ...saved, state: 'held', reason } : saved;
  return {
    getCallSettings: () => runtime.withDomain(domain => domain.getCallSettings()),
    updateCallSettings: input => runtime.withDomain(domain => domain.updateCallSettings(input)),
    linkCompanyPerson: async input => {
      const parsed = linkCompanyPersonRequestSchema.parse(input);
      return runtime.withDomain(domain => domain.linkLocalCompanyPerson(parsed));
    },
    getCompanyResearchStatus: async input => {
      try {
        const selected = Object.freeze(selectedResearchSchema.parse(input));
        return await readStatus(selected);
      } catch { throw new Error('LOCAL_COMPANY_RESEARCH_STATUS_FAILED'); }
    },
    researchCompany: async input => {
      try {
        const selected = Object.freeze(selectedResearchSchema.parse(input));
        const saved = await readStatus(selected);
        // A readable database is not permission to execute against an unavailable domain.
        try { await runtime.withDomain((): void => undefined); }
        catch { return unavailable(saved, 'domain_unavailable'); }
        const current = research?.current() ?? null;
        if (!current) return unavailable(saved, 'research_unavailable');
        return validateStatus(selected, await current.researchCompany(selected));
      } catch { throw new Error('LOCAL_COMPANY_RESEARCH_FAILED'); }
    },
    getCompany: async input => {
      const { accountId } = selectedCompanySchema.parse(input);
      // Storage availability is not domain readiness or permission to research/mutate.
      return runtime.withDatabase(database => {
        const repo = new AccountRepository({ database, clock, ids });
        return repo.readLocalCompanyDetail(accountId, clock.now());
      });
    },
    reviewCompany: async input => { const parsed = localCompanyInputSchema.parse(input); return runtime.withDomain(domain => domain.reviewLocalCompany(parsed)); },
    createCompany: async input => { const parsed = localCompanyCreateRequestSchema.parse(input); return runtime.withDomain(domain => domain.createLocalCompany(parsed)); },
    getCompanyCreateStatus: async input => { const parsed = localCompanyCreateRequestSchema.parse(input); return runtime.withDomain(domain => domain.getLocalCompanyCreateStatus(parsed)); },
    get: () => runtime.withDatabase(database => readLocalWorkspace(database)),
    getCommitments: () => runtime.withDomain(domain => domain.getLocalCommitments()),
    transition: command => {
      const parsed = localWorkflowTransitionSchema.parse(command);
      return runtime.withDomain(domain => projectLocalWorkflowReceipt(domain.transitionWorkflow(parsed)));
    },
  };
}
