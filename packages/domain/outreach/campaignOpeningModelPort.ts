import type {CampaignOpeningSnapshot} from './campaignOpening.ts';

/** Internal model boundary: only public identity, approved lines and opaque source
 * references. The durable opening owner retains source/attempt authority. */
export const CAMPAIGN_OPENING_MODEL='claude-haiku-4-5';
export const CAMPAIGN_OPENING_MAX_OUTPUT_TOKENS=256;
export interface CampaignOpeningModelPort {
 readonly providerKey:'aws_bedrock.campaign_opening';
 countInputTokens(snapshot:CampaignOpeningSnapshot):Promise<number>;
 select(snapshot:CampaignOpeningSnapshot):Promise<{
  readonly choice:unknown;
  readonly costCents:number;
  readonly costEstimated:boolean;
 }>;
}

/** Final server snapshot: owner control, database time and business zone are read
 * in one statement after source waits, never assembled from stale separate reads. */
export interface CampaignOpeningDispatchAuthority {
 readonly authorized:boolean;
 readonly at:string;
 readonly businessTimeZone:string;
}
