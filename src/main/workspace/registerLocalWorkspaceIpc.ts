import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
export function registerLocalWorkspaceIpc(provider: LocalWorkspaceApi, isTrustedRendererUrl?: (url: string) => boolean): () => void {
  const disposers: (() => void)[] = [];
  const cleanup = () => {
    const errors: unknown[] = [];
    for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
    return errors;
  };
  try {
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get', requestSchema: null, responseSchema: localWorkspaceSnapshotSchema, safeErrorCode: 'LOCAL_WORKSPACE_READ_FAILED', handler: () => provider.get(), isTrustedRendererUrl }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get-commitments', requestSchema: null, responseSchema: localCommitmentsSnapshotSchema, safeErrorCode: 'LOCAL_COMMITMENTS_READ_FAILED', handler: () => provider.getCommitments(), isTrustedRendererUrl }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:transition', requestSchema: localWorkflowTransitionSchema, responseSchema: localWorkflowReceiptSchema, safeErrorCode: 'LOCAL_WORKFLOW_TRANSITION_FAILED', handler: command => provider.transition(command), isTrustedRendererUrl }));
  } catch (error) {
    const errors = cleanup();
    if (errors.length) throw new AggregateError([error, ...errors], 'Local workspace registration rollback failed');
    throw error;
  }
  return () => { const errors = cleanup(); if (errors.length) throw new AggregateError(errors, 'Local workspace cleanup failed'); };
}
