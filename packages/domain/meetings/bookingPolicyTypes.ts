import type {BookingPolicyBindings,BookingPolicyView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';

/** Trusted composition only. Settings payloads cannot supply these observations. */
export interface BookingPolicyRuntimeEvidence {
  readonly evidenceKind:'controlled'|'actual';
  readonly binding:BookingPolicyBindings;
  readonly verifiedAt:string;
  readonly validUntil:string;
  readonly accountAccess:boolean;
  readonly calendarFreeBusy:boolean;
  readonly eventSettings:boolean;
  readonly modelConsent:boolean;
  readonly modelAcceptance:boolean;
  readonly senderAuthority:boolean;
  readonly sourceAuthority:boolean;
  readonly providerAdapter:boolean;
  readonly releaseReady:boolean;
  readonly funding:{readonly status:'verified'|'unknown'|'held';readonly sharedRemainingDailyCents:number|null;readonly sharedRemainingMonthlyCents:number|null};
}
export interface BookingPolicyRuntime {
  /** No provider call is permitted here. Read already observed exact configured evidence. */
  readEvidence(context:RepositoryContext,binding:BookingPolicyBindings):Promise<BookingPolicyRuntimeEvidence|null>;
  now():string;
}
export interface BookingPolicySnapshot {
  readonly workspaceId:string;
  readonly ownerUserId:string;
  readonly policyRevision:number;
  readonly bindingKey:string;
  readonly bindings:BookingPolicyBindings;
  readonly businessPolicyValid:true;
  readonly operationalReady:boolean;
  readonly enabled:false;
  readonly evidenceKind:BookingPolicyView['readiness']['evidenceKind'];
}
export type CurrentBookingPolicy = {readonly kind:'unavailable';readonly reason:string}|{readonly kind:'available';readonly snapshot:BookingPolicySnapshot};
export interface CurrentBookingPolicyQuery {readonly ownerUserId:string;readonly expectedRevision?:number;readonly expectedBindingKey?:string}
