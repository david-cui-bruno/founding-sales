import { localCompanyInputSchema, localCompanyCreateRequestSchema } from '../../shared/contracts/localCompanyIntakeContract';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { localWorkflowTransitionSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { projectLocalWorkflowReceipt, readLocalWorkspace } from '../domain/workspace/localWorkspaceReadService';
export function createLocalWorkspaceProvider(runtime: Pick<FoundationRuntime, 'withDatabase' | 'withDomain'>): LocalWorkspaceApi {
  return {
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
