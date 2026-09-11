import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema } from '../../shared/contracts/localCompanyIntakeContract';
import { linkCompanyPersonRequestSchema, accountEvidenceReceiptSchema, localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, selectedCompanySchema, localCompanyDetailSchema, selectedResearchSchema, localCompanyResearchStatusSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import type { IpcClient } from '../ipcClient';
export const createLocalWorkspaceApi = (client: IpcClient): LocalWorkspaceApi => ({
  linkCompanyPerson: async input => {
    const parsed = Object.freeze(linkCompanyPersonRequestSchema.parse(input));
    const result = accountEvidenceReceiptSchema.parse(await client.request('local-workspace:link-company-person',
      linkCompanyPersonRequestSchema, accountEvidenceReceiptSchema, parsed));
    if (result.accountId !== parsed.accountId) throw new Error('LOCAL_COMPANY_PERSON_LINK_IDENTITY_MISMATCH');
    return result;
  },
  researchCompany: async input => {
    const selected = Object.freeze(selectedResearchSchema.parse(input));
    return client.request('local-workspace:research-company', selectedResearchSchema,
      localCompanyResearchStatusSchema.refine(result => result.accountId === selected.accountId && result.commandId === selected.commandId), selected);
  },
  getCompanyResearchStatus: async input => {
    const selected = Object.freeze(selectedResearchSchema.parse(input));
    return client.request('local-workspace:company-research-status', selectedResearchSchema,
      localCompanyResearchStatusSchema.refine(result => result.accountId === selected.accountId && result.commandId === selected.commandId), selected);
  },
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
  getCompany: async input => {
    const parsed = selectedCompanySchema.parse(input);
    return client.request('local-workspace:get-company', selectedCompanySchema,
      localCompanyDetailSchema.refine(result => result.snapshot.account.id === parsed.accountId), parsed);
  },
});
