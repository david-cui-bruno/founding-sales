import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema } from '../../shared/contracts/localCompanyIntakeContract';
import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import type { IpcClient } from '../ipcClient';
export const createLocalWorkspaceApi = (client: IpcClient): LocalWorkspaceApi => ({
  reviewCompany: async input => {
    const parsed = localCompanyInputSchema.parse(input);
    return client.request('local-workspace:review-company', localCompanyInputSchema, localCompanyReviewSchema.refine(result => result.input.name === parsed.name && result.input.domain === parsed.domain), parsed);
  },
  createCompany: async input => {
    const parsed = localCompanyCreateRequestSchema.parse(input);
    return client.request('local-workspace:create-company', localCompanyCreateRequestSchema, localCompanyCreateResultSchema.refine(result => result.commandId === parsed.commandId
      && (result.status !== 'saved' || (result.account.name === parsed.name && result.account.domain === parsed.domain))
      && (result.status !== 'needs_review' || (result.review.input.name === parsed.name && result.review.input.domain === parsed.domain))), parsed);
  },
  getCompanyCreateStatus: async input => {
    const parsed = localCompanyCreateRequestSchema.parse(input);
    return client.request('local-workspace:company-create-status', localCompanyCreateRequestSchema, localCompanyCreateStatusSchema.refine(result => result.commandId === parsed.commandId
      && (result.status !== 'saved' || (result.account.name === parsed.name && result.account.domain === parsed.domain))), parsed);
  },
  get: () => client.requestNoInput('local-workspace:get', localWorkspaceSnapshotSchema),
  getCommitments: () => client.requestNoInput('local-workspace:get-commitments', localCommitmentsSnapshotSchema),
  transition: command => client.request('local-workspace:transition', localWorkflowTransitionSchema, localWorkflowReceiptSchema, command),
});
