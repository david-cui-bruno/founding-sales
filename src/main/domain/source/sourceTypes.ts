export type SourceChannel =
  | 'frbo'
  | 'registry'
  | 'rireig'
  | 'referral'
  | 'inbound_demo'
  | 'community'
  | 'custom'
  | 'parcel'
  | 'deed'
  | 'permit'
  | 'violation';

export type ReferralUnknownReason =
  | 'not_provided'
  | 'unresolvable'
  | 'legacy_import'
  | 'other';

export type CustomSourceReason =
  | 'manual_quick_add'
  | 'csv_import'
  | 'spreadsheet_paste'
  | 'other';

export type ReferralAttribution =
  | { kind: 'known'; referredByPersonId: string }
  | { kind: 'unknown'; reason: ReferralUnknownReason };

type BaseAppendSourceEventInput = {
  id: string;
  personId: string;
  prospectId?: string | null;
  salesCycleId?: string | null;
  observedAt: string;
  sourceRecord: Record<string, unknown>;
  evidenceRef?: string | null;
};

export type AppendSourceEventInput = BaseAppendSourceEventInput & (
  | {
    channel: 'referral';
    referral: ReferralAttribution;
    customSourceReason?: never;
  }
  | {
    channel: 'custom';
    referral?: never;
    customSourceReason: CustomSourceReason;
  }
  | {
    channel: Exclude<SourceChannel, 'referral' | 'custom'>;
    referral?: never;
    customSourceReason?: never;
  }
);

export type SourceEvent = {
  id: string;
  personId: string;
  prospectId: string | null;
  salesCycleId: string | null;
  channel: SourceChannel;
  observedAt: string;
  sourceRecord: Record<string, unknown>;
  evidenceRef: string | null;
  referral: ReferralAttribution | null;
  customSourceReason: CustomSourceReason | null;
  createdAt: string;
};
