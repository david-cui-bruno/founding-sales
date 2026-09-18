import { admitCompanyDraftEmailSchema, openCompanyDraftSchema, getCompanyDraftSchema, saveCompanyDraftSchema, companyDraftAdmissionReply, companyDraftOpenReply, companyDraftGetReply, companyDraftSaveReply, companyDraftAdmissionReceiptSchema, companyDraftMutationResultSchema, companyDraftReadSchema, prepareCompanyDraftSchema, preparedCompanyDraftSchema, companyDraftPrepareReply } from '../../shared/contracts/localCompanyDraftContract';
import { admitCompanyPhoneRouteSchema, companyPhoneRouteReceiptSchema, companyPhoneRouteReply } from '../../shared/contracts/localCompanyPhoneRouteContract';
import { companyResearchSettingsSchema, companyResearchSettingsUpdateReplySchema, updateCompanyResearchSettingsRequestSchema } from '../../shared/contracts/localCompanyResearchSettingsContract';
import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema } from '../../shared/contracts/localCompanyIntakeContract';
import { meetingFirstAccountCallSettingsSchema, updateCallSettingsRequestSchema, callSettingsUpdateReplySchema, linkCompanyPersonRequestSchema, accountEvidenceReceiptSchema, localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, selectedCompanySchema, localCompanyDetailSchema, selectedResearchSchema, localCompanyResearchStatusSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { confirmTerritoryClearanceSchema, revokeTerritoryClearanceSchema, territoryClearanceSnapshotSchema } from '../../shared/contracts/territoryClearanceContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
export function registerLocalWorkspaceIpc(provider: LocalWorkspaceApi, isTrustedRendererUrl?: (url: string) => boolean): () => void {
  const disposers: (() => void)[] = [];
  const cleanup = () => {
    const errors: unknown[] = [];
    for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
    return errors;
  };
  try {
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get-company-research-settings', requestSchema: null, responseSchema: companyResearchSettingsSchema, safeErrorCode: 'LOCAL_RESEARCH_SETTINGS_READ_FAILED', handler: () => provider.getCompanyResearchSettings(), isTrustedRendererUrl }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:update-company-research-settings', requestSchema: updateCompanyResearchSettingsRequestSchema, responseSchema: companyResearchSettingsSchema, safeErrorCode: 'LOCAL_RESEARCH_SETTINGS_UPDATE_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = updateCompanyResearchSettingsRequestSchema.parse(input);
      return companyResearchSettingsUpdateReplySchema(parsed).parse(await provider.updateCompanyResearchSettings(parsed));
    } }));
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
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:research-company', requestSchema: selectedResearchSchema, responseSchema: localCompanyResearchStatusSchema, safeErrorCode: 'LOCAL_COMPANY_RESEARCH_FAILED', isTrustedRendererUrl, handler: async input => {
      const selected = Object.freeze(selectedResearchSchema.parse(input));
      const result = localCompanyResearchStatusSchema.parse(await provider.researchCompany(selected));
      if (result.accountId !== selected.accountId || result.commandId !== selected.commandId) throw new Error('Selected research identity mismatch');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:company-research-status', requestSchema: selectedResearchSchema, responseSchema: localCompanyResearchStatusSchema, safeErrorCode: 'LOCAL_COMPANY_RESEARCH_STATUS_FAILED', isTrustedRendererUrl, handler: async input => {
      const selected = Object.freeze(selectedResearchSchema.parse(input));
      const result = localCompanyResearchStatusSchema.parse(await provider.getCompanyResearchStatus(selected));
      if (result.accountId !== selected.accountId || result.commandId !== selected.commandId) throw new Error('Selected research identity mismatch');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:link-company-person', requestSchema: linkCompanyPersonRequestSchema, responseSchema: accountEvidenceReceiptSchema, safeErrorCode: 'LOCAL_COMPANY_LINK_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(linkCompanyPersonRequestSchema.parse(input));
      const result = accountEvidenceReceiptSchema.parse(await provider.linkCompanyPerson(parsed));
      if (result.accountId !== parsed.accountId) throw new Error('LOCAL_COMPANY_PERSON_LINK_IDENTITY_MISMATCH');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get-call-settings', requestSchema: null, responseSchema: meetingFirstAccountCallSettingsSchema, safeErrorCode: 'LOCAL_CALL_SETTINGS_READ_FAILED', handler: () => provider.getCallSettings(), isTrustedRendererUrl }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:update-call-settings', requestSchema: updateCallSettingsRequestSchema, responseSchema: meetingFirstAccountCallSettingsSchema, safeErrorCode: 'LOCAL_CALL_SETTINGS_UPDATE_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(updateCallSettingsRequestSchema.parse(input));
      return callSettingsUpdateReplySchema(parsed).parse(await provider.updateCallSettings(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:admit-company-draft-email', requestSchema: admitCompanyDraftEmailSchema, responseSchema: companyDraftAdmissionReceiptSchema, safeErrorCode: 'LOCAL_COMPANY_DRAFT_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(admitCompanyDraftEmailSchema.parse(input)); return companyDraftAdmissionReply(parsed).parse(await provider.admitCompanyDraftEmail(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:admit-company-phone-route', requestSchema: admitCompanyPhoneRouteSchema, responseSchema: companyPhoneRouteReceiptSchema, safeErrorCode: 'LOCAL_COMPANY_PHONE_ROUTE_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(admitCompanyPhoneRouteSchema.parse(input));
      if (!provider.admitCompanyPhoneRoute) throw new Error('Company phone route review unavailable');
      return companyPhoneRouteReply(parsed).parse(await provider.admitCompanyPhoneRoute(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:open-company-draft', requestSchema: openCompanyDraftSchema, responseSchema: companyDraftMutationResultSchema, safeErrorCode: 'LOCAL_COMPANY_DRAFT_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(openCompanyDraftSchema.parse(input)); return companyDraftOpenReply(parsed).parse(await provider.openCompanyDraft(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:get-company-draft', requestSchema: getCompanyDraftSchema, responseSchema: companyDraftReadSchema.nullable(), safeErrorCode: 'LOCAL_COMPANY_DRAFT_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(getCompanyDraftSchema.parse(input)); return companyDraftGetReply(parsed).parse(await provider.getCompanyDraft(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:save-company-draft', requestSchema: saveCompanyDraftSchema, responseSchema: companyDraftMutationResultSchema, safeErrorCode: 'LOCAL_COMPANY_DRAFT_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(saveCompanyDraftSchema.parse(input)); return companyDraftSaveReply(parsed).parse(await provider.saveCompanyDraft(parsed));
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:prepare-company-draft', requestSchema: prepareCompanyDraftSchema,
      responseSchema: preparedCompanyDraftSchema, safeErrorCode: 'LOCAL_COMPANY_PREPARATION_FAILED', isTrustedRendererUrl, handler: async input => {
        const parsed = Object.freeze(prepareCompanyDraftSchema.parse(input));
        return companyDraftPrepareReply(parsed).parse(await provider.prepareCompanyDraft(parsed));
      } }));
    // Territory clearance (design D4). Reading is a storage read; confirm and revoke record the founder's attestation and never dial.
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:territory-clearance-read', requestSchema: null, responseSchema: territoryClearanceSnapshotSchema, safeErrorCode: 'LOCAL_TERRITORY_CLEARANCE_READ_FAILED', isTrustedRendererUrl, handler: () => {
      if (!provider.readTerritoryClearance) throw new Error('Territory clearance unavailable');
      return provider.readTerritoryClearance();
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:territory-clearance-confirm', requestSchema: confirmTerritoryClearanceSchema, responseSchema: territoryClearanceSnapshotSchema, safeErrorCode: 'LOCAL_TERRITORY_CLEARANCE_CONFIRM_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(confirmTerritoryClearanceSchema.parse(input));
      if (!provider.confirmTerritoryClearance) throw new Error('Territory clearance unavailable');
      const result = territoryClearanceSnapshotSchema.parse(await provider.confirmTerritoryClearance(parsed));
      for (const state of parsed.states) if (result.states.find(entry => entry.state === state)?.status !== 'confirmed') throw new Error('Territory clearance confirmation incomplete');
      return result;
    } }));
    disposers.push(registerValidatedIpc({ channel: 'local-workspace:territory-clearance-revoke', requestSchema: revokeTerritoryClearanceSchema, responseSchema: territoryClearanceSnapshotSchema, safeErrorCode: 'LOCAL_TERRITORY_CLEARANCE_REVOKE_FAILED', isTrustedRendererUrl, handler: async input => {
      const parsed = Object.freeze(revokeTerritoryClearanceSchema.parse(input));
      if (!provider.revokeTerritoryClearance) throw new Error('Territory clearance unavailable');
      const result = territoryClearanceSnapshotSchema.parse(await provider.revokeTerritoryClearance(parsed));
      if (result.states.find(entry => entry.state === parsed.state)?.status !== 'revoked') throw new Error('Territory clearance revocation incomplete');
      return result;
    } }));
  } catch (error) {
    const errors = cleanup();
    if (errors.length) throw new AggregateError([error, ...errors], 'Local workspace registration rollback failed');
    throw error;
  }
  return () => { const errors = cleanup(); if (errors.length) throw new AggregateError(errors, 'Local workspace cleanup failed'); };
}
