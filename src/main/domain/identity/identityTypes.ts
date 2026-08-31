import type { QualificationGateReasonCode } from '../../db/domainSchema';

export type Person = {
  id: string;
  displayName: string;
  aliases: string[];
  optedOut: boolean;
  optedOutAt: string | null;
  neverRecord: boolean;
  deletedAt: string | null;
  provenance: unknown | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ContactMethod = {
  id: string;
  personId: string;
  kind: 'phone' | 'email';
  normalizedValue: string;
  rawValue: string | null;
  validationState: 'unverified' | 'valid' | 'invalid';
  reachability: 'direct' | 'indirect' | 'none';
  isPrimary: boolean;
  inContacts: boolean | null;
  createdAt: string;
  updatedAt: string;
};

export type ContactMethodMatch = {
  person: Person;
  contactMethod: ContactMethod;
};

export type QualificationGateReason = QualificationGateReasonCode;

export type QualificationSelection =
  | {
      qualificationState: 'disqualified';
      qualificationGateReason: QualificationGateReason;
    }
  | {
      qualificationState: 'unreviewed' | 'eligible' | 'merge_review';
      qualificationGateReason: null;
    };

export type QualificationMutation =
  | {
      nextState: 'disqualified';
      qualificationGateReason: QualificationGateReason;
    }
  | {
      nextState: 'unreviewed' | 'eligible' | 'merge_review';
      qualificationGateReason: null;
    };

export type Prospect = QualificationSelection & {
  id: string;
  personId: string;
  originalSourceEventId: string;
  segment: 'hot_frbo' | 'cold_registry' | 'warm';
  qualificationReason: string | null;
  lastContactAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Organization = {
  id: string;
  canonicalName: string;
  sourceRecord: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationAlias = {
  id: string;
  organizationId: string;
  alias: string;
  createdAt: string;
};

export type Property = {
  id: string;
  organizationId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  locality: string;
  region: string;
  postalCode: string | null;
  countryCode: string;
  doorCount: number | null;
  propertyType: string | null;
  maintenanceProfile: unknown | null;
  sourceRecord: unknown | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePersonInput = {
  displayName: string;
  aliases?: string[];
  neverRecord?: boolean;
  provenance?: unknown | null;
};

export type AddContactMethodInput = {
  personId: string;
  kind: 'phone' | 'email';
  normalizedValue: string;
  rawValue?: string | null;
  validationState: 'unverified' | 'valid' | 'invalid';
  reachability: 'direct' | 'indirect' | 'none';
  isPrimary?: boolean;
  inContacts?: boolean | null;
};

export type CreateProspectInput = QualificationSelection & {
  personId: string;
  originalSourceEventId: string;
  segment: 'hot_frbo' | 'cold_registry' | 'warm';
  qualificationReason?: string | null;
};

export type UpdateProspectQualificationInput = QualificationMutation & {
  prospectId: string;
  personId: string;
  expectedVersion: number;
  expectedState: Prospect['qualificationState'];
  reason: string | null;
  updatedAt: string;
};

export type CreateOrganizationInput = {
  canonicalName: string;
  sourceRecord?: unknown | null;
};

export type AddOrganizationAliasInput = {
  organizationId: string;
  alias: string;
};

export type CreatePropertyInput = {
  organizationId?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  locality: string;
  region: string;
  postalCode?: string | null;
  countryCode?: string;
  doorCount?: number | null;
  propertyType?: string | null;
  maintenanceProfile?: unknown | null;
  sourceRecord?: unknown | null;
  verifiedAt?: string | null;
};

export type LinkOrganizationInput = {
  prospectId: string;
  organizationId: string;
  relationship?: string | null;
};

export type LinkPropertyInput = {
  prospectId: string;
  propertyId: string;
  relationship?: string | null;
};

export type CanonicalPropertyAddress = {
  addressLine1: string;
  addressLine2?: string | null;
  locality: string;
  region: string;
  postalCode?: string | null;
  countryCode: string;
};
