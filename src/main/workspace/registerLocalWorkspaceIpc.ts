import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema } from '../../shared/contracts/localCompanyIntakeContract';
import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, selectedCompanySchema, localCompanyDetailSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
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
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:review-company', requestSchema: localCompanyInputSchema, responseSchema: localCompanyReviewSchema, safeErrorCode: 'LOCAL_COMPANY_REVIEW_FAILED', isTrustedRendererUrl, handler: async input => {
      const result = localCompanyReviewSchema.parse(await provider.reviewCompany(input));
      if (result.input.name !== input.name || result.input.domain !== input.domain) throw new Error('Company review input mismatch');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:create-company', requestSchema: localCompanyCreateRequestSchema, responseSchema: localCompanyCreateResultSchema, safeErrorCode: 'LOCAL_COMPANY_CREATE_FAILED', isTrustedRendererUrl, handler: async input => {
      const result = localCompanyCreateResultSchema.parse(await provider.createCompany(input));
      if (result.commandId !== input.commandId || (result.status === 'saved' && (result.account.name !== input.name || result.account.domain !== input.domain))
        || (result.status === 'needs_review' && (result.review.input.name !== input.name || result.review.input.domain !== input.domain))) throw new Error('Company creation input mismatch');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:company-create-status', requestSchema: localCompanyCreateRequestSchema, responseSchema: localCompanyCreateStatusSchema, safeErrorCode: 'LOCAL_COMPANY_CREATE_STATUS_FAILED', isTrustedRendererUrl, handler: async input => {
      const result = localCompanyCreateStatusSchema.parse(await provider.getCompanyCreateStatus(input));
      if (result.commandId !== input.commandId || (result.status === 'saved' && (result.account.name !== input.name || result.account.domain !== input.domain))) throw new Error('Company status input mismatch');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get-company', requestSchema: selectedCompanySchema, responseSchema: localCompanyDetailSchema, safeErrorCode: 'LOCAL_COMPANY_READ_FAILED', isTrustedRendererUrl, handler: async input => {
      const result = localCompanyDetailSchema.parse(await provider.getCompany(input));
      if (result.snapshot.account.id !== input.accountId) throw new Error('Selected company identity mismatch');
      return result;
    } }));
  } catch (error) {
    const errors = cleanup();
    if (errors.length) throw new AggregateError([error, ...errors], 'Local workspace registration rollback failed');
    throw error;
  }
  return () => { const errors = cleanup(); if (errors.length) throw new AggregateError(errors, 'Local workspace cleanup failed'); };
}
