/**
 * Intake mapper — CloudSourceEvent -> CRM intake shapes (plan Task 2).
 *
 * A pure function: no I/O, no clock. The caller (Task 3 poller) feeds each
 * validated inbox event through `mapCloudSourceEvent` and dispatches on the
 * result kind:
 *
 * - `intake`: person-bearing event. Run the command through the existing
 *   `SourceService.createPersonProspect`; the source-event ID is the receipt
 *   natural key `cloud:<idempotency_key>`, so `source_intake_receipts` makes
 *   replays no-ops through the pipeline that already guards idempotency.
 * - `needs-identity`: the event cannot mint a person (no name, no org). The
 *   caller surfaces it as a review item tied to the situs address; the
 *   founder resolves identity manually until entity resolution ships.
 * - `score-update`: a scorer re-emission (`scores_version` present, same
 *   idempotency_key). Update cloud-score fields only, never re-create.
 *
 * Channel -> segment reuses `segmentForChannel` from the source service (the
 * single 0005 mapping); this module never duplicates that table.
 */
import {
  segmentForChannel,
  type CreatePersonProspectCommand,
  type IntakeContactInput,
  type IntakeOrganizationInput,
  type IntakePropertyInput,
  type NonCustomIntakeSourceInput,
} from '../domain/source/sourceService';
import type { Prospect } from '../domain/identity/identityRepository';
import type {
  CloudChannel,
  CloudEnrichmentPayload,
  CloudPostalAddress,
  CloudScores,
  CloudSourceEvent,
} from '../../shared/contracts/cloudSourceEventContract';
import { cloudEnrichmentPayloadSchema } from '../../shared/contracts/cloudSourceEventContract';

/**
 * The receipt natural key: `source_intake_receipts.source_event_id` for
 * cloud-minted people. Replay of the same cloud event finds the receipt and
 * returns the stored result without touching relational state.
 */
export function cloudReceiptKey(idempotencyKey: string): string {
  return `cloud:${idempotencyKey}`;
}

export class CloudEventUnmappableError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, reason: string) {
    super(`Cloud source event cannot be mapped: ${reason}`);
    this.name = 'CloudEventUnmappableError';
    this.idempotencyKey = idempotencyKey;
  }
}

export type MappedIntake = {
  kind: 'intake';
  receiptKey: string;
  cloudEntityId: string | null;
  segment: Prospect['segment'];
  trigger: CloudSourceEvent['trigger'];
  command: CreatePersonProspectCommand;
};

export type MappedNeedsIdentity = {
  kind: 'needs-identity';
  receiptKey: string;
  cloudEntityId: string | null;
  channel: Exclude<CloudChannel, 'custom'>;
  segment: Prospect['segment'];
  observedAt: string;
  situsAddress: CloudPostalAddress | null;
  parcelId: string | null;
  event: CloudSourceEvent;
};

export type MappedScoreUpdate = {
  kind: 'score-update';
  idempotencyKey: string;
  receiptKey: string;
  scoresVersion: number;
  fit: number;
  timing: number;
  reasons: CloudScores['reasons'];
  /** Canonical event timestamp: the same-version replay tiebreaker. */
  scoredAt: string;
};

export type MappedCloudSourceEvent =
  | MappedIntake
  | MappedNeedsIdentity
  | MappedScoreUpdate;

export function mapCloudSourceEvent(event: CloudSourceEvent): MappedCloudSourceEvent {
  if (event.scores_version !== undefined) {
    return mapScoreUpdate(event);
  }
  if (event.channel === 'custom') {
    throw new CloudEventUnmappableError(
      event.idempotency_key,
      'the cloud never emits channel "custom"',
    );
  }

  const channel = event.channel;
  const segment = segmentForChannel(channel);
  const displayName = resolveDisplayName(event);
  if (displayName === null) {
    return {
      kind: 'needs-identity',
      receiptKey: cloudReceiptKey(event.idempotency_key),
      cloudEntityId: event.entity.cloud_entity_id,
      channel,
      segment,
      observedAt: canonicalTimestamp(event.observed_at),
      situsAddress: event.entity.property?.situs_address ?? null,
      parcelId: event.entity.property?.parcel_id ?? null,
      event,
    };
  }

  return {
    kind: 'intake',
    receiptKey: cloudReceiptKey(event.idempotency_key),
    cloudEntityId: event.entity.cloud_entity_id,
    segment,
    trigger: event.trigger,
    command: {
      person: {
        displayName,
        provenance: {
          cloudEntityId: event.entity.cloud_entity_id,
          sourceUri: event.source_uri,
          mailingAddress: event.entity.person?.mailing_address ?? null,
        },
      },
      contacts: mapContacts(event),
      organizations: mapOrganizations(event),
      properties: mapProperties(event),
      source: mapSource(event, channel),
    },
  };
}

function mapScoreUpdate(event: CloudSourceEvent): MappedScoreUpdate {
  if (event.scores === null || event.scores_version === undefined) {
    throw new CloudEventUnmappableError(
      event.idempotency_key,
      'a scored re-emission must carry both scores and scores_version',
    );
  }
  return {
    kind: 'score-update',
    idempotencyKey: event.idempotency_key,
    receiptKey: cloudReceiptKey(event.idempotency_key),
    scoresVersion: event.scores_version,
    fit: event.scores.fit,
    timing: event.scores.timing,
    reasons: event.scores.reasons,
    scoredAt: canonicalTimestamp(event.observed_at),
  };
}

/**
 * Placeholder intake command for a person-null event (plan Task 5): the
 * event cannot mint a real person, so the founder gets an
 * "Unknown owner · <situs address>" placeholder that enters the standard
 * Unreviewed lifecycle. Resolving identity is a rename (or merge) on the
 * existing review surface; the receipt key keeps replays no-ops and the
 * cloud entity link is written by importCloudSourceEvent as usual.
 *
 * Returns null when the situs address is unusable (no locality/region), in
 * which case the caller counts-and-skips exactly like before.
 */
export function buildNeedsIdentityIntakeCommand(
  mapped: MappedNeedsIdentity,
): CreatePersonProspectCommand | null {
  const address = mapped.situsAddress;
  if (address === null || address.locality === null || address.region === null) {
    return null;
  }
  const property = mapped.event.entity.property;
  return {
    person: {
      displayName: `Unknown owner · ${address.line1}, ${address.locality}`,
      provenance: {
        cloudEntityId: mapped.cloudEntityId,
        sourceUri: mapped.event.source_uri,
        needsIdentity: true,
      },
    },
    contacts: [],
    organizations: [],
    properties: [{
      addressLine1: address.line1,
      locality: address.locality,
      region: address.region,
      postalCode: address.postal_code,
      countryCode: address.country_code,
      doorCount: property?.unit_count ?? null,
      propertyType: property?.use_code ?? null,
      sourceRecord: {
        parcelId: property?.parcel_id ?? null,
        yearBuilt: property?.year_built ?? null,
        useCode: property?.use_code ?? null,
      },
    }],
    source: mapSource(mapped.event, mapped.channel),
  };
}

/**
 * Public records name people directly (owner rows) or through their entity
 * (LLC-owned parcels). Neither -> the event cannot mint a person.
 */
function resolveDisplayName(event: CloudSourceEvent): string | null {
  const person = event.entity.person;
  if (person === null) return null;
  if (person.full_name !== null && person.full_name.trim().length > 0) {
    return person.full_name;
  }
  const [firstOrgName] = person.org_names;
  return firstOrgName !== undefined && firstOrgName.trim().length > 0
    ? firstOrgName
    : null;
}

function mapContacts(event: CloudSourceEvent): IntakeContactInput[] {
  const enrichment = parseEnrichmentPayload(event);
  if (enrichment !== null) {
    return mapEnrichmentContacts(enrichment);
  }
  const person = event.entity.person;
  if (person === null) return [];
  return [
    ...person.phones.map((value, index): IntakeContactInput => ({
      kind: 'phone',
      value,
      reachability: 'direct',
      isPrimary: index === 0,
    })),
    ...person.emails.map((value, index): IntakeContactInput => ({
      kind: 'email',
      value,
      reachability: 'direct',
      isPrimary: index === 0,
    })),
  ];
}

/**
 * An event whose payload parses as the enrichment shape (channel parcel,
 * hit true). Enrichment contacts replace entity.person.phones/emails and
 * carry the vendor scrub's DNC/TCPA compliance flags.
 */
function parseEnrichmentPayload(
  event: CloudSourceEvent,
): CloudEnrichmentPayload | null {
  if (event.channel !== 'parcel') return null;
  const parsed = cloudEnrichmentPayloadSchema.safeParse(event.payload);
  if (parsed.success === false || parsed.data.hit === false) return null;
  return parsed.data;
}

/**
 * Enrichment contacts, ordered by vendor rank; rank 1 is primary. Every
 * phone carries its dnc_listed/tcpa_flag so the dial gate can refuse
 * flagged numbers (the federal telemarketing scrub gate).
 */
function mapEnrichmentContacts(payload: CloudEnrichmentPayload): IntakeContactInput[] {
  const phones = [...payload.phones].sort((left, right) => left.rank - right.rank);
  const emails = [...payload.emails].sort((left, right) => left.rank - right.rank);
  return [
    ...phones.map((phone, index): IntakeContactInput => ({
      kind: 'phone',
      value: phone.e164,
      reachability: 'direct',
      isPrimary: index === 0,
      dncListed: phone.dnc_listed,
      tcpaFlag: phone.tcpa_flag,
    })),
    ...emails.map((email, index): IntakeContactInput => ({
      kind: 'email',
      value: email.address,
      reachability: 'direct',
      isPrimary: index === 0,
    })),
  ];
}

function mapOrganizations(event: CloudSourceEvent): IntakeOrganizationInput[] {
  return (event.entity.person?.org_names ?? []).map((canonicalName) => ({
    canonicalName,
  }));
}

/**
 * The intake property schema requires a full civic address (line1, locality,
 * region). Public records occasionally omit locality/region; those events
 * keep their person but drop the property attachment.
 */
function mapProperties(event: CloudSourceEvent): IntakePropertyInput[] {
  const property = event.entity.property;
  const address = property?.situs_address ?? null;
  if (property === null || address === null) return [];
  if (address.locality === null || address.region === null) return [];
  return [{
    addressLine1: address.line1,
    locality: address.locality,
    region: address.region,
    postalCode: address.postal_code,
    countryCode: address.country_code,
    doorCount: property.unit_count,
    propertyType: property.use_code,
    sourceRecord: {
      parcelId: property.parcel_id,
      yearBuilt: property.year_built,
      useCode: property.use_code,
    },
  }];
}

function mapSource(
  event: CloudSourceEvent,
  channel: Exclude<CloudChannel, 'custom'>,
): NonCustomIntakeSourceInput {
  const common = {
    id: cloudReceiptKey(event.idempotency_key),
    observedAt: canonicalTimestamp(event.observed_at),
    // The full validated event: typed by contract, no prose anywhere.
    sourceRecord: { cloudSourceEvent: event },
  };
  if (channel === 'referral') {
    // Cloud referral events carry no local person linkage; attribution stays
    // unknown until the founder resolves it.
    return {
      ...common,
      channel,
      referral: { kind: 'unknown', reason: 'not_provided' },
    };
  }
  return { ...common, channel };
}

/**
 * The wire contract permits second-precision timestamps; the intake schema
 * requires canonical UTC ISO with milliseconds.
 */
function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}
