import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { localWorkflowTransitionSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { projectLocalWorkflowReceipt, readLocalWorkspace } from '../domain/workspace/localWorkspaceReadService';
export function createLocalWorkspaceProvider(runtime: Pick<FoundationRuntime, 'withDatabase' | 'withDomain'>): LocalWorkspaceApi {
  return {
    get: () => runtime.withDatabase(database => readLocalWorkspace(database)),
    getCommitments: () => runtime.withDomain(domain => domain.getLocalCommitments()),
    transition: command => {
      const parsed = localWorkflowTransitionSchema.parse(command);
      return runtime.withDomain(domain => projectLocalWorkflowReceipt(domain.transitionWorkflow(parsed)));
    },
  };
}
