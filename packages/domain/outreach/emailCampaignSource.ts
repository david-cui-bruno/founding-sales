import type {AutomaticResearchTarget} from '@fss/contracts';

/** Internal selection only, never a caller's authorization. Domain owners reload
 * current source, owner, campaign and exact stored lineage before any mutation.
 * This union is not added to a browser/API request or a human-reviewed flag. */
export type EmailCampaignSourceSelection =
  | {readonly kind:'discovery_research';readonly firmId:string}
  | Readonly<AutomaticResearchTarget>;
