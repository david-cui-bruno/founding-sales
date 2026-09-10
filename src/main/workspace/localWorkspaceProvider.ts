import { localCompanyInputSchema, localCompanyCreateRequestSchema } from '../../shared/contracts/localCompanyIntakeContract';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { localWorkflowTransitionSchema, selectedCompanySchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { projectLocalWorkflowReceipt, readLocalWorkspace } from '../domain/workspace/localWorkspaceReadService';
import { AccountRepository } from '../domain/accounts/accountRepository';
import { SystemClock } from '../domain/support/clock';
import { UuidGenerator } from '../domain/support/idGenerator';
export function createLocalWorkspaceProvider(runtime: Pick<FoundationRuntime, 'withDatabase' | 'withDomain'>): LocalWorkspaceApi {
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  return {
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
