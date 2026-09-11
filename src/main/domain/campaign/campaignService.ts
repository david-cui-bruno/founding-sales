import { z } from 'zod';
import { accountFingerprint } from '../accounts/accountEvidence';
import { accountIdSchema } from '../../../shared/contracts/accountContract';
import { campaignCommandPayloadSchema, type CampaignCommandPayload } from '../../../shared/contracts/campaignContract';
import { ownerCampaignCommandSchema } from '../../../shared/contracts/ownerCommandContract';
import type { CommandReceipt } from '../../../shared/contracts/delegationContract';
import type { DelegationRepository } from '../../delegation/delegationRepository';
import type { ExecutionClient } from '../../delegation/executionClient';

/** Main-only campaign command entry point. A pending owner command is not a local
 * campaign mutation. Unreachable workers never cause a second local owner. */
export class CampaignService {
  constructor(private readonly deps: { workspaceId: string; delegation: DelegationRepository; execution: ExecutionClient }) {
    accountIdSchema.parse(deps.workspaceId);
  }
  async submit(input: { commandId: string; accountId: string; payload: CampaignCommandPayload }): Promise<CommandReceipt> {
    const request = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema, payload: campaignCommandPayloadSchema }).parse(input);
    const prior = this.deps.delegation.getCommand(request.commandId);
    if (prior) {
      if (prior.kind !== 'campaign-command' || prior.workspaceId !== this.deps.workspaceId || prior.accountId !== request.accountId || accountFingerprint(prior.payload) !== accountFingerprint(request.payload)) throw new Error('campaign_command_conflict');
      return this.deps.execution.submit(prior);
    }
    const authority = this.deps.delegation.authority(request.accountId);
    const version = this.deps.delegation.executionVersion(request.accountId);
    if (!authority || authority.owner !== 'worker' || authority.state !== 'active' || version === null || this.deps.delegation.hasPendingStop(request.accountId)) {
      throw new Error('campaign_owner_unavailable');
    }
    const command = ownerCampaignCommandSchema.parse({ ...request, kind: 'campaign-command', workspaceId: this.deps.workspaceId,
      expectedAuthorityGeneration: authority.generation, expectedVersion: version });
    return this.deps.execution.submit(command);
  }
}
