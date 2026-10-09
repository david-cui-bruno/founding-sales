import type {CanonicalSourceReference,CrmClaimContext} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SourceLookup} from './sourceResolver.ts';
/** #483 owns proven lineage and sole original body storage. Current mailbox identity is not historical proof. */
export interface MailProcessingAuthority {
 source:SourceLookup;
 authorizationFingerprint:string;
 /** Actual native proof token, transient only: never a job/database payload. */
 nativeAuthority:unknown;
}
/** Stored-copy read authority and current processing authority intentionally differ after disconnect. */
export interface CrmMailEvidencePort {
 /** Optional native-only stored original proof; absent adapters always abstain. No verifier/network. */
 resolveCommitmentProof?(context:RepositoryContext,source:SourceLookup):Promise<{ownerUserId:string;sourceRevision:number;sourceHash:string;providerEventAt:string;observedAt:string;authored:true;actualOutgoing:true;passage:string}|null>;

 resolve(context:RepositoryContext,source:SourceLookup):Promise<{
  source:CanonicalSourceReference;
  ownerUserId:string;
  extent:{unit:'utf16';length:number};
  passage:{text:string;locator:string;speaker:string|null}|null;
 }|null>;
 snapshotProcessing(context:RepositoryContext,source:SourceLookup,purposeOwner:string):Promise<{authorizationFingerprint:string;context:CrmClaimContext}|null>;
 readContext(context:RepositoryContext,source:SourceLookup):Promise<CrmClaimContext|null>;
 readState(context:RepositoryContext,input:{sourceId:string}):Promise<{revision:number;availability:string}|null>;
 loadOriginalInput(context:RepositoryContext,authority:MailProcessingAuthority):Promise<string|null>;
 prepareProcessing(context:RepositoryContext,source:SourceLookup,purposeOwner:string):Promise<MailProcessingAuthority|null>;
 revalidatePrepared(context:RepositoryContext,authority:MailProcessingAuthority):Promise<boolean>;
 authorizeProcessing(context:RepositoryContext,source:SourceLookup,purposeOwner:string):Promise<MailProcessingAuthority|null>;
}
/** Composition cannot make legacy rows available or infer account lineage. #483 must provide the implementation. */
export const unavailableMailEvidence:CrmMailEvidencePort={
 resolve:async()=>null,
 snapshotProcessing:async()=>null,
 readContext:async()=>null,
 readState:async()=>null,
 loadOriginalInput:async()=>null,
 prepareProcessing:async()=>null,
 revalidatePrepared:async()=>false,
 authorizeProcessing:async()=>null,
};
