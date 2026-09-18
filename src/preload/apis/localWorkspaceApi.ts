import { admitCompanyDraftEmailSchema, openCompanyDraftSchema, getCompanyDraftSchema, saveCompanyDraftSchema, companyDraftAdmissionReply, companyDraftOpenReply, companyDraftGetReply, companyDraftSaveReply, prepareCompanyDraftSchema, companyDraftPrepareReply } from '../../shared/contracts/localCompanyDraftContract';
import { admitCompanyPhoneRouteSchema, companyPhoneRouteReply } from '../../shared/contracts/localCompanyPhoneRouteContract';
import { companyResearchSettingsSchema, companyResearchSettingsUpdateReplySchema, updateCompanyResearchSettingsRequestSchema } from '../../shared/contracts/localCompanyResearchSettingsContract';
import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema } from '../../shared/contracts/localCompanyIntakeContract';
import { meetingFirstAccountCallSettingsSchema, updateCallSettingsRequestSchema, callSettingsUpdateReplySchema, linkCompanyPersonRequestSchema, accountEvidenceReceiptSchema, localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, selectedCompanySchema, localCompanyDetailSchema, selectedResearchSchema, localCompanyResearchStatusSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { confirmTerritoryClearanceSchema, revokeTerritoryClearanceSchema, territoryClearanceSnapshotSchema } from '../../shared/contracts/territoryClearanceContract';
import type { IpcClient } from '../ipcClient';
export const createLocalWorkspaceApi = (client: IpcClient): LocalWorkspaceApi => ({
  readTerritoryClearance: () => client.requestNoInput('local-workspace:territory-clearance-read', territoryClearanceSnapshotSchema),
  confirmTerritoryClearance: async input => { const parsed = Object.freeze(confirmTerritoryClearanceSchema.parse(input)); return client.request('local-workspace:territory-clearance-confirm', confirmTerritoryClearanceSchema, territoryClearanceSnapshotSchema, parsed); },
  revokeTerritoryClearance: async input => { const parsed = Object.freeze(revokeTerritoryClearanceSchema.parse(input)); return client.request('local-workspace:territory-clearance-revoke', revokeTerritoryClearanceSchema, territoryClearanceSnapshotSchema, parsed); },
  prepareCompanyDraft: async input => {
    const parsed = Object.freeze(prepareCompanyDraftSchema.parse(input));
    return client.request('local-workspace:prepare-company-draft', prepareCompanyDraftSchema, companyDraftPrepareReply(parsed), parsed);
  },
  admitCompanyDraftEmail: async input => { const parsed = Object.freeze(admitCompanyDraftEmailSchema.parse(input)); return client.request('local-workspace:admit-company-draft-email', admitCompanyDraftEmailSchema, companyDraftAdmissionReply(parsed), parsed); },
  admitCompanyPhoneRoute: async input => { const parsed = Object.freeze(admitCompanyPhoneRouteSchema.parse(input)); return client.request('local-workspace:admit-company-phone-route', admitCompanyPhoneRouteSchema, companyPhoneRouteReply(parsed), parsed); },
  openCompanyDraft: async input => { const parsed = Object.freeze(openCompanyDraftSchema.parse(input)); return client.request('local-workspace:open-company-draft', openCompanyDraftSchema, companyDraftOpenReply(parsed), parsed); },
  getCompanyDraft: async input => { const parsed = Object.freeze(getCompanyDraftSchema.parse(input)); return client.request('local-workspace:get-company-draft', getCompanyDraftSchema, companyDraftGetReply(parsed), parsed); },
  saveCompanyDraft: async input => { const parsed = Object.freeze(saveCompanyDraftSchema.parse(input)); return client.request('local-workspace:save-company-draft', saveCompanyDraftSchema, companyDraftSaveReply(parsed), parsed); },

  getCompanyResearchSettings: () => client.requestNoInput('local-workspace:get-company-research-settings', companyResearchSettingsSchema),
  updateCompanyResearchSettings: async input => {
    const parsed = updateCompanyResearchSettingsRequestSchema.parse(input);
    return client.request('local-workspace:update-company-research-settings', updateCompanyResearchSettingsRequestSchema, companyResearchSettingsUpdateReplySchema(parsed), parsed);
  },
  getCallSettings: () => client.requestNoInput('local-workspace:get-call-settings', meetingFirstAccountCallSettingsSchema),
  updateCallSettings: async input => {
    const parsed = Object.freeze(updateCallSettingsRequestSchema.parse(input));
    return client.request('local-workspace:update-call-settings', updateCallSettingsRequestSchema, callSettingsUpdateReplySchema(parsed), parsed);
  },
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
