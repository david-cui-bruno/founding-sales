import type {AutomaticResearchTarget} from '@fss/contracts';

/** Internal selection only, never a caller's authorization. Domain owners reload
 * current source, owner, campaign and exact stored lineage before any mutation.
 * This union is not added to a browser/API request or a human-reviewed flag. */
export type EmailCampaignSourceSelection =
  | {readonly kind:'discovery_research';readonly firmId:string}
  | Readonly<AutomaticResearchTarget>;

/** ADR0035/0036: an own-site prepared company with a provider-found, verified decision-maker address, selected for admission. Like the
 * selection above it is never authority: every use reloads the exact current run, person, verification, owner and campaign. */
export interface PreparedEmailTarget {readonly kind:'prepared_capture';readonly candidateId:string;readonly candidateRevision:number;readonly runId:string;readonly address:string}
/** The internal, non-human sources that admit through the shared campaign owners. */
export type InternalCampaignTarget=Readonly<AutomaticResearchTarget>|PreparedEmailTarget;
