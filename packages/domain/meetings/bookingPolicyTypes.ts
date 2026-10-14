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
  /** Already observed normal configured choices, not a provider read or readiness grant. */
  readConfiguration?(context:RepositoryContext,ownerUserId:string):Promise<readonly BookingPolicyBindings[]>;
  /** No provider call is permitted here. Read already observed exact configured evidence. */
  readEvidence(context:RepositoryContext,binding:BookingPolicyBindings):Promise<BookingPolicyRuntimeEvidence|null>;
  now():string;
}
/** Server-only applicability, never a client permission or an Enable grant. */
export type BookingPolicyCapability = 'interpretation'|'booking'|'provider_action';
export interface BookingPolicySnapshot {
  readonly capability:BookingPolicyCapability;
  readonly workspaceId:string;
  readonly ownerUserId:string;
  readonly policyRevision:number;
  readonly bindingKey:string;
  readonly bindings:BookingPolicyBindings;
  readonly businessPolicyValid:true;
  readonly operationalReady:boolean;
  readonly enabled:false;
  readonly evidenceKind:BookingPolicyView['readiness']['evidenceKind'];
  /** From the exact validated canonical observation, not client policy settings. */
  readonly authorityVerifiedAt:string|null;
  readonly authorityValidUntil:string|null;
}
export type CurrentBookingPolicy = {readonly kind:'unavailable';readonly reason:string}|{readonly kind:'available';readonly snapshot:BookingPolicySnapshot;readonly budget:BookingPolicyView['budget']};
export interface CurrentBookingPolicyQuery {readonly ownerUserId:string;readonly expectedRevision?:number;readonly expectedBindingKey?:string;readonly capability?:BookingPolicyCapability}
