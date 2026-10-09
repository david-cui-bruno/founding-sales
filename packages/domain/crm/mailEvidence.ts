import type {CanonicalSourceReference} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SourceLookup} from './sourceResolver.ts';
/** #483 owns proven lineage and sole original body storage. Current mailbox identity is not historical proof. */
export interface MailProcessingAuthority {
 source:SourceLookup;
 authorizationFingerprint:string;
 ownerUserId:string;
 accountBinding:string;
 connectionGeneration:number;
 policyRevision:number;
 metadataRevision:number;
 decisionRevision:number;
 parserVersion:string;
}
/** Stored-copy read authority and current processing authority intentionally differ after disconnect. */
export interface CrmMailEvidencePort {
 resolve(context:RepositoryContext,source:SourceLookup):Promise<{
  source:CanonicalSourceReference;
  extent:{unit:'utf16';length:number};
  passage:{text:string;locator:string;speaker:string|null}|null;
 }|null>;
 loadOriginalInput(context:RepositoryContext,authority:MailProcessingAuthority):Promise<string|null>;
 authorizeProcessing(context:RepositoryContext,source:SourceLookup):Promise<MailProcessingAuthority|null>;
 revalidateProcessing(context:RepositoryContext,authority:MailProcessingAuthority):Promise<boolean>;
}
/** Composition cannot make legacy rows available or infer account lineage. #483 must provide the implementation. */
export const unavailableMailEvidence:CrmMailEvidencePort={
 resolve:async()=>null,
 loadOriginalInput:async()=>null,
 authorizeProcessing:async()=>null,
 revalidateProcessing:async()=>false,
};
