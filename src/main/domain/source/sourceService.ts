import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type {
  ContactMethodMatch,
  IdentityRepository,
  Organization,
  Property,
  Prospect,
} from '../identity/identityRepository';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  serializeCanonicalIntakeCommand,
  type CanonicalIntakeCommand,
  type IntakeReceiptRepository,
  type JsonObject,
} from './intakeReceiptRepository';
import type {
  AppendSourceEventInput,
  CustomSourceReason,
  ReferralAttribution,
  SourceChannel,
  SourceEvent,
} from './sourceTypes';
import type { SourceRepository } from './sourceRepository';

/** V1 intentionally uses the United States as the only default for non-E.164 phones. */
export const V1_DEFAULT_PHONE_REGION = 'US' as const;

export type IdentityReviewReason =
  | 'shared_handle'
  | 'conflicting_handle_matches'
  | 'indirect_handle_match'
  | 'deleted_person_match';

export type ContextReviewReason =
  | 'ambiguous_organization'
  | 'ambiguous_property'
  | 'organization_not_found'
  | 'property_organization_conflict';
export type IntakeDisposition = 'created' | 'matched_existing' | 'created_merge_review';
export type IntakeFaultPoint =
  | 'after_person'
  | 'after_source_event'
  | 'after_prospect'
  | 'after_organization'
  | 'after_organization_link'
  | 'after_property'
  | 'after_property_link'
  | 'after_receipt';

export type IntakeContactInput = {
  kind: 'phone' | 'email';
  value: string;
  reachability: 'direct' | 'indirect' | 'none';
  isPrimary?: boolean;
  inContacts?: boolean | null;
};

export type IntakeOrganizationInput = {
  canonicalName: string;
  aliases?: string[];
  relationship?: string | null;
  sourceRecord?: unknown | null;
};

export type IntakePropertyInput = {
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
  organizationAlias?: string | null;
  relationship?: string | null;
};

type BaseIntakeSourceInput = {
  id: string;
  observedAt: string;
  sourceRecord: Record<string, unknown>;
  evidenceRef?: string | null;
};

export type NonCustomIntakeSourceInput = BaseIntakeSourceInput & (
  | {
    channel: 'referral';
    referral: ReferralAttribution;
    customSourceReason?: never;
  }
  | {
    channel: Exclude<SourceChannel, 'referral' | 'custom'>;
    referral?: never;
    customSourceReason?: never;
  }
);

export type CustomIntakeSourceInput = BaseIntakeSourceInput & {
  channel: 'custom';
  referral?: never;
  customSourceReason: CustomSourceReason;
};

export type IntakeSourceInput = NonCustomIntakeSourceInput | CustomIntakeSourceInput;

type CommonCreatePersonProspectCommand = {
  person: {
    displayName: string;
    aliases?: string[];
    neverRecord?: boolean;
    provenance?: unknown | null;
  };
  contacts: IntakeContactInput[];
  organizations?: IntakeOrganizationInput[];
  properties?: IntakePropertyInput[];
};

export type CreatePersonProspectCommand = CommonCreatePersonProspectCommand & (
  | { source: CustomIntakeSourceInput; segment: Prospect['segment'] }
  | {
    source: NonCustomIntakeSourceInput;
    segment?: never;
  }
);

export type IntakeResult = {
  disposition: IntakeDisposition;
  personId: string;
  prospectId: string;
  sourceEventId: string;
  identityReviewReason: IdentityReviewReason | null;
  contextReviewReasons: ContextReviewReason[];
  organizationIds: string[];
  propertyIds: string[];
};

export class ContactNormalizationConflictError extends Error {
  readonly kind: 'phone' | 'email';
  readonly normalizedValue: string;

  constructor(kind: 'phone' | 'email', normalizedValue: string) {
    super('Equivalent contact inputs disagree on normalized contact facts.');
    this.name = 'ContactNormalizationConflictError';
    this.kind = kind;
    this.normalizedValue = normalizedValue;
  }
}

export class ContextNormalizationConflictError extends Error {
  readonly contextKind: 'organization' | 'property';
  readonly normalizedIdentity: string;

  constructor(contextKind: 'organization' | 'property', normalizedIdentity: string) {
    super('Equivalent context identity inputs disagree on canonical facts.');
    this.name = 'ContextNormalizationConflictError';
    this.contextKind = contextKind;
    this.normalizedIdentity = normalizedIdentity;
  }
}

export class IntakeIdempotencyConflictError extends Error {
  readonly sourceEventId: string;
  readonly reason: 'command_mismatch' | 'source_event_without_receipt';

  constructor(
    sourceEventId: string,
    reason: 'command_mismatch' | 'source_event_without_receipt',
  ) {
    super(reason === 'command_mismatch'
      ? 'The source ID already owns a different canonical intake command.'
      : 'The source ID belongs to a non-intake source event.');
    this.name = 'IntakeIdempotencyConflictError';
    this.sourceEventId = sourceEventId;
    this.reason = reason;
  }
}

const idSchema = z.string().trim().min(1);
const nonblankSchema = z.string().transform(normalizeDisplayText).pipe(z.string().min(1));
const nullableTrimmedSchema = z.string().transform((value) => value.normalize('NFKC').trim())
  .pipe(z.string().min(1)).nullable().optional();
const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
const referralUnknownReasonSchema = z.enum([
  'not_provided', 'unresolvable', 'legacy_import', 'other',
]);
const customSourceReasonSchema = z.enum([
  'manual_quick_add', 'csv_import', 'spreadsheet_paste', 'other',
]);
const sourceRecordSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  'Source record must be a non-empty JSON object.',
);
const knownReferralSchema = z.object({
  kind: z.literal('known'),
  referredByPersonId: idSchema,
}).strict();
const unknownReferralSchema = z.object({
  kind: z.literal('unknown'),
  reason: referralUnknownReasonSchema,
}).strict();
const commonSourceShape = {
  id: idSchema,
  observedAt: utcTimestampSchema,
  sourceRecord: sourceRecordSchema,
  evidenceRef: nullableTrimmedSchema,
};
const sourceInputSchema = z.discriminatedUnion('channel', [
  z.object({ ...commonSourceShape, channel: z.literal('frbo') }).strict(),
  z.object({ ...commonSourceShape, channel: z.literal('registry') }).strict(),
  z.object({ ...commonSourceShape, channel: z.literal('rireig') }).strict(),
  z.object({
    ...commonSourceShape,
    channel: z.literal('referral'),
    referral: z.discriminatedUnion('kind', [knownReferralSchema, unknownReferralSchema]),
  }).strict(),
  z.object({ ...commonSourceShape, channel: z.literal('inbound_demo') }).strict(),
  z.object({ ...commonSourceShape, channel: z.literal('community') }).strict(),
  z.object({
    ...commonSourceShape,
    channel: z.literal('custom'),
    customSourceReason: customSourceReasonSchema,
  }).strict(),
]);
const personInputSchema = z.object({
  displayName: nonblankSchema,
  aliases: z.array(nonblankSchema).default([]),
  neverRecord: z.boolean().default(false),
  provenance: z.unknown().nullable().optional(),
}).strict();
const contactInputSchema = z.object({
  kind: z.enum(['phone', 'email']),
  value: z.string().min(1),
  reachability: z.enum(['direct', 'indirect', 'none']),
  isPrimary: z.boolean().default(false),
  inContacts: z.boolean().nullable().optional(),
}).strict();
const organizationInputSchema = z.object({
  canonicalName: nonblankSchema,
  aliases: z.array(nonblankSchema).default([]),
  relationship: z.string().nullable().optional(),
  sourceRecord: z.unknown().nullable().optional(),
}).strict();
const propertyInputSchema = z.object({
  addressLine1: nonblankSchema,
  addressLine2: z.string().nullable().optional(),
  locality: nonblankSchema,
  region: nonblankSchema,
  postalCode: z.string().nullable().optional(),
  countryCode: z.string().trim().length(2).default(V1_DEFAULT_PHONE_REGION),
  doorCount: z.number().int().safe().nonnegative().nullable().optional(),
  propertyType: z.string().nullable().optional(),
  maintenanceProfile: z.unknown().nullable().optional(),
  sourceRecord: z.unknown().nullable().optional(),
  verifiedAt: utcTimestampSchema.nullable().optional(),
  organizationAlias: z.string().nullable().optional(),
  relationship: z.string().nullable().optional(),
}).strict();
const commonCommandShape = {
  person: personInputSchema,
  contacts: z.array(contactInputSchema),
  organizations: z.array(organizationInputSchema).default([]),
  properties: z.array(propertyInputSchema).default([]),
};
const createCommandSchema = z.union([
  z.object({
    ...commonCommandShape,
    source: sourceInputSchema.refine((value) => value.channel !== 'custom'),
  }).strict(),
  z.object({
    ...commonCommandShape,
    source: sourceInputSchema.refine((value) => value.channel === 'custom'),
    segment: z.enum(['hot_frbo', 'cold_registry', 'warm']),
  }).strict(),
]);

const phoneInputSchema = z.string().transform((value, context) => {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.startsWith('+')) {
    if (/^\+[\d\s().-]+$/.test(normalized)) {
      const digits = normalized.slice(1).replace(/\D/g, '');
      if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Explicit international phones must be canonical E.164.',
    });
    return z.NEVER;
  }
  if (!/^[\d\s().-]+$/.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Phone is invalid.' });
    return z.NEVER;
  }
  const digits = normalized.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Phone is ambiguous or invalid under the V1 US default region.',
  });
  return z.NEVER;
});
const emailInputSchema = z.string().transform((value, context) => {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  const localPart = normalized.slice(0, normalized.indexOf('@'));
  if (
    normalized.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)
    && !normalized.includes('..')
    && !localPart.startsWith('.')
    && !localPart.endsWith('.')
  ) {
    return normalized;
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Email is invalid.' });
  return z.NEVER;
});

type NormalizedContact = {
  kind: 'phone' | 'email';
  normalizedValue: string;
  rawValue: string;
  reachability: 'direct' | 'indirect' | 'none';
  isPrimary: boolean;
  inContacts: boolean | null;
};

type NormalizedOrganization = z.infer<typeof organizationInputSchema> & {
  normalizedAliases: string[];
};

type NormalizedProperty = Omit<z.infer<typeof propertyInputSchema>, 'countryCode'> & {
  countryCode: string;
  canonicalAddress: {
    addressLine1: string;
    addressLine2: string | null;
    locality: string;
    region: string;
    postalCode: string | null;
    countryCode: string;
  };
};

type NormalizedCommand = {
  person: {
    displayName: string;
    aliases: string[];
    neverRecord: boolean;
    provenance?: unknown | null;
  };
  contacts: NormalizedContact[];
  organizations: NormalizedOrganization[];
  properties: NormalizedProperty[];
  source: z.infer<typeof sourceInputSchema>;
  segment: Prospect['segment'];
};

export function normalizePhone(value: string): string {
  return phoneInputSchema.parse(value);
}

export function normalizeEmail(value: string): string {
  return emailInputSchema.parse(value);
}

export class SourceService {
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly identities: IdentityRepository;
  private readonly sources: SourceRepository;
  private readonly receipts: IntakeReceiptRepository;
  private readonly faultInjector: ((point: IntakeFaultPoint) => void) | undefined;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    sources: SourceRepository;
    receipts: IntakeReceiptRepository;
    faultInjector?: (point: IntakeFaultPoint) => void;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    input.sources.assertBoundTo(input.database, input.unitOfWork);
    input.receipts.assertBoundTo(input.database, input.unitOfWork);
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.sources = input.sources;
    this.receipts = input.receipts;
    this.faultInjector = input.faultInjector;
  }

  createPersonProspect(command: CreatePersonProspectCommand): IntakeResult {
    const normalized = normalizeCommand(command);
    return this.unitOfWork.immediate(() => this.intake(normalized));
  }

  commitBatch(commands: CreatePersonProspectCommand[]): IntakeResult[] {
    const normalized = z.array(z.unknown()).parse(commands).map((command) => (
      normalizeCommand(command as CreatePersonProspectCommand)
    ));
    return this.unitOfWork.immediate(() => normalized.map((command) => this.intake(command)));
  }

  appendSourceInteraction(command: AppendSourceEventInput): SourceEvent {
    return this.unitOfWork.immediate(() => this.sources.append(command));
  }

  private intake(command: NormalizedCommand): IntakeResult {
    const canonicalCommand = toCanonicalIntakeCommand(command);
    const commandJson = serializeCanonicalIntakeCommand(canonicalCommand);
    const receipt = this.receipts.getBySourceEventId(command.source.id);
    if (receipt !== null) {
      if (receipt.commandJson !== commandJson) {
        throw new IntakeIdempotencyConflictError(command.source.id, 'command_mismatch');
      }
      return receipt.result;
    }
    if (this.sources.getById(command.source.id) !== null) {
      throw new IntakeIdempotencyConflictError(
        command.source.id,
        'source_event_without_receipt',
      );
    }

    const identityResolution = this.resolveIdentity(command.contacts);
    const person = identityResolution.personId === null
      ? this.identities.createPerson(command.person)
      : this.identities.getPerson(identityResolution.personId);
    if (person === null) throw new Error('Matched Person disappeared during intake.');

    if (identityResolution.personId === null) {
      for (const contact of command.contacts) {
        this.identities.addContactMethod({
          personId: person.id,
          kind: contact.kind,
          normalizedValue: contact.normalizedValue,
          rawValue: contact.rawValue,
          validationState: 'valid',
          reachability: contact.reachability,
          isPrimary: contact.isPrimary,
          inContacts: contact.inContacts,
        });
      }
    } else {
      this.attachNewContacts(person.id, command.contacts);
    }
    this.inject('after_person');

    const existingProspect = this.identities.getCanonicalProspect(person.id);
    const sourceEvent = this.sources.append(toSourceAppendInput(command.source, {
      personId: person.id,
      prospectId: existingProspect?.id ?? null,
    }));
    this.inject('after_source_event');

    const prospect = existingProspect ?? this.identities.createCanonicalProspect({
      personId: person.id,
      originalSourceEventId: sourceEvent.id,
      segment: command.segment,
      qualificationState: identityResolution.reviewReason === null
        ? 'unreviewed'
        : 'merge_review',
      qualificationReason: identityResolution.reviewReason,
    });
    this.inject('after_prospect');

    const contextResult = this.attachContexts(prospect.id, command);
    const persistedIdentityReviewReason = existingProspect?.qualificationState === 'merge_review'
      ? parsePersistedIdentityReviewReason(existingProspect.qualificationReason)
      : identityResolution.reviewReason;
    const disposition: IntakeDisposition = identityResolution.reviewReason !== null
      ? 'created_merge_review'
      : identityResolution.personId === null
        ? 'created'
        : 'matched_existing';
    const result: IntakeResult = {
      disposition,
      personId: person.id,
      prospectId: prospect.id,
      sourceEventId: sourceEvent.id,
      identityReviewReason: persistedIdentityReviewReason,
      ...contextResult,
    };
    this.receipts.append({
      sourceEventId: sourceEvent.id,
      command: canonicalCommand,
      result,
    });
    this.inject('after_receipt');
    return result;
  }

  private resolveIdentity(contacts: NormalizedContact[]): {
    personId: string | null;
    reviewReason: IdentityReviewReason | null;
  } {
    const matchesByContact = contacts.map((contact) => ({
      contact,
      matches: this.identities.findContactMatchesByNormalizedHandle(
        contact.kind, contact.normalizedValue,
      ),
    }));
    const allMatches = matchesByContact.flatMap(({ matches }) => matches);
    if (matchesByContact.some(({ matches }) => (
      new Set(matches.map(({ person }) => person.id)).size > 1
    ))) {
      return { personId: null, reviewReason: 'shared_handle' };
    }
    if (new Set(allMatches.map(({ person }) => person.id)).size > 1) {
      return { personId: null, reviewReason: 'conflicting_handle_matches' };
    }
    if (allMatches.some(({ person }) => person.deletedAt !== null)) {
      return { personId: null, reviewReason: 'deleted_person_match' };
    }

    const directIdsByContact = matchesByContact.map(({ contact, matches }) => {
      if (contact.reachability !== 'direct') return new Set<string>();
      return new Set(matches.filter(isDirectValidatedMatch).map(({ person }) => person.id));
    });
    const allDirectIds = new Set(directIdsByContact.flatMap((ids) => [...ids]));
    const hasIndirectOnlyMatch = matchesByContact.some(({ contact, matches }, index) => (
      matches.length > 0
      && (contact.reachability !== 'direct' || directIdsByContact[index]?.size === 0)
    ));
    if (hasIndirectOnlyMatch) {
      return { personId: null, reviewReason: 'indirect_handle_match' };
    }
    const [personId] = [...allDirectIds];
    return { personId: personId ?? null, reviewReason: null };
  }

  private attachNewContacts(personId: string, contacts: NormalizedContact[]): void {
    for (const contact of contacts) {
      const alreadyLinked = this.identities.findContactMatchesByNormalizedHandle(
        contact.kind, contact.normalizedValue,
      ).some((match) => match.person.id === personId);
      if (alreadyLinked) continue;
      this.identities.addContactMethod({
        personId,
        kind: contact.kind,
        normalizedValue: contact.normalizedValue,
        rawValue: contact.rawValue,
        validationState: 'valid',
        reachability: contact.reachability,
        isPrimary: contact.isPrimary,
        inContacts: contact.inContacts,
      });
    }
  }

  private attachContexts(
    prospectId: string,
    command: NormalizedCommand,
  ): Pick<IntakeResult, 'contextReviewReasons' | 'organizationIds' | 'propertyIds'> {
    const reviewReasons: ContextReviewReason[] = [];
    const organizationIds: string[] = [];
    const propertyIds: string[] = [];

    for (const context of command.organizations) {
      const matches = uniqueById(context.normalizedAliases.flatMap((alias) => (
        this.identities.findOrganizationsByNormalizedAlias(alias)
      )));
      if (matches.length > 1) {
        addUnique(reviewReasons, 'ambiguous_organization');
        continue;
      }
      let organization: Organization;
      if (matches[0] === undefined) {
        organization = this.identities.createOrganization({
          canonicalName: context.canonicalName,
          sourceRecord: context.sourceRecord,
        });
        this.inject('after_organization');
        for (const alias of context.normalizedAliases) {
          this.identities.addOrganizationAlias({ organizationId: organization.id, alias });
        }
      } else {
        organization = matches[0];
      }
      this.identities.linkOrganization({
        prospectId,
        organizationId: organization.id,
        relationship: context.relationship,
      });
      this.inject('after_organization_link');
      addUnique(organizationIds, organization.id);
    }

    for (const context of command.properties) {
      const organizationResolution = this.resolveRequestedOrganization(
        context.organizationAlias,
        reviewReasons,
      );
      const matches = this.identities.findPropertiesByCanonicalAddress(context.canonicalAddress);
      if (matches.length > 1) {
        addUnique(reviewReasons, 'ambiguous_property');
        continue;
      }
      let property: Property;
      if (matches[0] === undefined) {
        property = this.identities.createProperty({
          organizationId: organizationResolution.kind === 'resolved'
            ? organizationResolution.organizationId
            : null,
          ...context.canonicalAddress,
          doorCount: context.doorCount,
          propertyType: context.propertyType,
          maintenanceProfile: context.maintenanceProfile,
          sourceRecord: context.sourceRecord,
          verifiedAt: context.verifiedAt,
        });
        this.inject('after_property');
      } else {
        property = matches[0];
        if (
          organizationResolution.kind !== 'not_requested'
          && (
            organizationResolution.kind !== 'resolved'
            || property.organizationId !== organizationResolution.organizationId
          )
        ) {
          if (organizationResolution.kind === 'resolved') {
            addUnique(reviewReasons, 'property_organization_conflict');
          }
          continue;
        }
      }
      this.identities.linkProperty({
        prospectId,
        propertyId: property.id,
        relationship: context.relationship,
      });
      this.inject('after_property_link');
      addUnique(propertyIds, property.id);
    }
    return {
      contextReviewReasons: reviewReasons,
      organizationIds: organizationIds.sort(),
      propertyIds: propertyIds.sort(),
    };
  }

  private resolveRequestedOrganization(
    alias: string | null,
    reviewReasons: ContextReviewReason[],
  ):
    | { kind: 'not_requested' }
    | { kind: 'unresolved' }
    | { kind: 'resolved'; organizationId: string } {
    if (alias === null) return { kind: 'not_requested' };
    const matches = this.identities.findOrganizationsByNormalizedAlias(
      normalizeContextText(alias),
    );
    if (matches.length > 1) {
      addUnique(reviewReasons, 'ambiguous_organization');
      return { kind: 'unresolved' };
    }
    if (matches[0] === undefined) {
      addUnique(reviewReasons, 'organization_not_found');
      return { kind: 'unresolved' };
    }
    return { kind: 'resolved', organizationId: matches[0].id };
  }

  private inject(point: IntakeFaultPoint): void {
    this.faultInjector?.(point);
  }
}

function normalizeCommand(command: CreatePersonProspectCommand): NormalizedCommand {
  const parsed = createCommandSchema.parse(command);
  if (parsed.person.provenance !== undefined) {
    assertJsonValue(parsed.person.provenance, 'person provenance');
  }
  assertJsonValue(parsed.source.sourceRecord, 'source record');
  const contacts = normalizeContacts(parsed.contacts);
  const primaryKinds = new Set<string>();
  for (const contact of contacts) {
    if (!contact.isPrimary) continue;
    if (primaryKinds.has(contact.kind)) {
      throw new z.ZodError([]);
    }
    primaryKinds.add(contact.kind);
  }
  const organizationCandidates = parsed.organizations.map((organization) => {
    if (organization.sourceRecord !== undefined) {
      assertJsonValue(organization.sourceRecord, 'organization source record');
    }
    const normalizedAliases = [...new Set([
      organization.canonicalName,
      ...organization.aliases,
    ].map(normalizeContextText))].sort(compareStrings);
    return {
      ...organization,
      aliases: normalizedAliases,
      relationship: organization.relationship ?? null,
      sourceRecord: organization.sourceRecord == null
        ? null
        : canonicalizeContextValue(organization.sourceRecord),
      normalizedAliases,
    };
  });
  const propertyCandidates = parsed.properties.map((property) => {
    if (property.maintenanceProfile !== undefined) {
      assertJsonValue(property.maintenanceProfile, 'maintenance profile');
    }
    if (property.sourceRecord !== undefined) {
      assertJsonValue(property.sourceRecord, 'property source record');
    }
    const canonicalAddress = {
      addressLine1: normalizeContextText(property.addressLine1),
      addressLine2: property.addressLine2 == null
        ? null
        : normalizeContextText(property.addressLine2),
      locality: normalizeContextText(property.locality),
      region: normalizeContextText(property.region),
      postalCode: property.postalCode == null
        ? null
        : normalizeContextText(property.postalCode),
      countryCode: property.countryCode.toUpperCase(),
    };
    return {
      addressLine1: canonicalAddress.addressLine1,
      addressLine2: canonicalAddress.addressLine2,
      locality: canonicalAddress.locality,
      region: canonicalAddress.region,
      postalCode: canonicalAddress.postalCode,
      countryCode: property.countryCode.toUpperCase(),
      doorCount: property.doorCount ?? null,
      propertyType: property.propertyType ?? null,
      maintenanceProfile: property.maintenanceProfile == null
        ? null
        : canonicalizeContextValue(property.maintenanceProfile),
      sourceRecord: property.sourceRecord == null
        ? null
        : canonicalizeContextValue(property.sourceRecord),
      verifiedAt: property.verifiedAt ?? null,
      organizationAlias: property.organizationAlias == null
        ? null
        : normalizeContextText(property.organizationAlias),
      relationship: property.relationship ?? null,
      canonicalAddress,
    };
  });
  const organizations = normalizeOrganizations(organizationCandidates);
  const properties = normalizeProperties(propertyCandidates);
  return {
    person: {
      displayName: nonblankSchema.parse(parsed.person.displayName),
      aliases: [...new Set(parsed.person.aliases)].sort(compareStrings),
      neverRecord: parsed.person.neverRecord,
      provenance: parsed.person.provenance == null
        ? parsed.person.provenance
        : canonicalizeContextValue(parsed.person.provenance),
    },
    contacts,
    organizations,
    properties,
    source: parsed.source,
    segment: parsed.source.channel === 'custom'
      ? (parsed as z.infer<typeof createCommandSchema> & { segment: Prospect['segment'] }).segment
      : segmentForChannel(parsed.source.channel),
  };
}

function normalizeContacts(contacts: z.infer<typeof contactInputSchema>[]): NormalizedContact[] {
  const deduplicated = new Map<string, NormalizedContact>();
  for (const contact of contacts) {
    const normalizedValue = contact.kind === 'phone'
      ? normalizePhone(contact.value)
      : normalizeEmail(contact.value);
    const key = `${contact.kind}:${normalizedValue}`;
    const canonical = {
      kind: contact.kind,
      normalizedValue,
      // Intake identity is the canonical handle. Importers that need the
      // original spelling retain it in immutable sourceRecord/provenance.
      rawValue: normalizedValue,
      reachability: contact.reachability,
      isPrimary: contact.isPrimary,
      inContacts: contact.inContacts ?? null,
    };
    const existing = deduplicated.get(key);
    if (existing !== undefined) {
      if (
        existing.reachability !== canonical.reachability
        || existing.isPrimary !== canonical.isPrimary
        || existing.inContacts !== canonical.inContacts
      ) {
        throw new ContactNormalizationConflictError(contact.kind, normalizedValue);
      }
      continue;
    }
    deduplicated.set(key, canonical);
  }
  return [...deduplicated.values()].sort((left, right) => compareStrings(
    contactFactKey(left),
    contactFactKey(right),
  ));
}

function contactFactKey(contact: NormalizedContact): string {
  return canonicalContextJson({
    kind: contact.kind,
    normalizedValue: contact.normalizedValue,
    reachability: contact.reachability,
    isPrimary: contact.isPrimary,
    inContacts: contact.inContacts,
  });
}

function normalizeOrganizations(
  organizations: NormalizedOrganization[],
): NormalizedOrganization[] {
  const factKeys = organizations.map(organizationFactKey);
  const conflicts: string[] = [];
  for (let leftIndex = 0; leftIndex < organizations.length; leftIndex += 1) {
    const left = organizations[leftIndex];
    if (left === undefined) continue;
    const leftAliases = new Set(left.normalizedAliases);
    for (let rightIndex = leftIndex + 1; rightIndex < organizations.length; rightIndex += 1) {
      const right = organizations[rightIndex];
      if (right === undefined || factKeys[leftIndex] === factKeys[rightIndex]) continue;
      for (const alias of right.normalizedAliases) {
        if (leftAliases.has(alias)) conflicts.push(alias);
      }
    }
  }
  const [conflict] = [...new Set(conflicts)].sort(compareStrings);
  if (conflict !== undefined) {
    throw new ContextNormalizationConflictError('organization', conflict);
  }
  const unique = new Map<string, NormalizedOrganization>();
  organizations.forEach((organization, index) => {
    const key = factKeys[index];
    if (key !== undefined && !unique.has(key)) unique.set(key, organization);
  });
  return [...unique.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, organization]) => organization);
}

function normalizeProperties(properties: NormalizedProperty[]): NormalizedProperty[] {
  const factKeys = properties.map(propertyFactKey);
  const addressKeys = properties.map(({ canonicalAddress }) => (
    canonicalContextJson(canonicalAddress)
  ));
  const conflicts: string[] = [];
  for (let leftIndex = 0; leftIndex < properties.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < properties.length; rightIndex += 1) {
      if (
        addressKeys[leftIndex] === addressKeys[rightIndex]
        && factKeys[leftIndex] !== factKeys[rightIndex]
      ) {
        const identity = addressKeys[leftIndex];
        if (identity !== undefined) conflicts.push(identity);
      }
    }
  }
  const [conflict] = [...new Set(conflicts)].sort(compareStrings);
  if (conflict !== undefined) {
    throw new ContextNormalizationConflictError('property', conflict);
  }
  const unique = new Map<string, NormalizedProperty>();
  properties.forEach((property, index) => {
    const key = factKeys[index];
    if (key !== undefined && !unique.has(key)) unique.set(key, property);
  });
  return [...unique.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, property]) => property);
}

function organizationFactKey(organization: NormalizedOrganization): string {
  return canonicalContextJson({
    canonicalName: organization.canonicalName,
    normalizedAliases: organization.normalizedAliases,
    relationship: organization.relationship ?? null,
    sourceRecord: organization.sourceRecord ?? null,
  });
}

function propertyFactKey(property: NormalizedProperty): string {
  return canonicalContextJson({
    canonicalAddress: property.canonicalAddress,
    doorCount: property.doorCount ?? null,
    propertyType: property.propertyType ?? null,
    maintenanceProfile: property.maintenanceProfile ?? null,
    sourceRecord: property.sourceRecord ?? null,
    verifiedAt: property.verifiedAt ?? null,
    organizationAlias: property.organizationAlias ?? null,
    relationship: property.relationship ?? null,
  });
}

function canonicalContextJson(value: unknown): string {
  return JSON.stringify(canonicalizeContextValue(value));
}

function canonicalizeContextValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeContextValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => [key, canonicalizeContextValue(child)]));
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toCanonicalIntakeCommand(command: NormalizedCommand): CanonicalIntakeCommand {
  return {
    person: {
      displayName: command.person.displayName,
      aliases: command.person.aliases,
      neverRecord: command.person.neverRecord,
      provenance: (command.person.provenance ?? null) as CanonicalIntakeCommand['person']['provenance'],
    },
    contacts: command.contacts.map((contact) => ({
      kind: contact.kind,
      normalizedValue: contact.normalizedValue,
      reachability: contact.reachability,
      isPrimary: contact.isPrimary,
      inContacts: contact.inContacts,
    })),
    organizations: command.organizations.map((organization) => ({
      canonicalName: organization.canonicalName,
      normalizedAliases: organization.normalizedAliases,
      relationship: organization.relationship ?? null,
      sourceRecord: (organization.sourceRecord ?? null) as CanonicalIntakeCommand['organizations'][number]['sourceRecord'],
    })),
    properties: command.properties.map((property) => ({
      canonicalAddress: property.canonicalAddress,
      doorCount: property.doorCount ?? null,
      propertyType: property.propertyType ?? null,
      maintenanceProfile: (property.maintenanceProfile ?? null) as CanonicalIntakeCommand['properties'][number]['maintenanceProfile'],
      sourceRecord: (property.sourceRecord ?? null) as CanonicalIntakeCommand['properties'][number]['sourceRecord'],
      verifiedAt: property.verifiedAt ?? null,
      organizationAlias: property.organizationAlias ?? null,
      relationship: property.relationship ?? null,
    })),
    source: {
      id: command.source.id,
      channel: command.source.channel,
      observedAt: command.source.observedAt,
      sourceRecord: command.source.sourceRecord as JsonObject,
      evidenceRef: command.source.evidenceRef ?? null,
      referral: command.source.channel === 'referral' ? command.source.referral : null,
      customSourceReason: command.source.channel === 'custom'
        ? command.source.customSourceReason
        : null,
    },
    segment: command.segment,
  };
}

function segmentForChannel(channel: Exclude<SourceChannel, 'custom'>): Prospect['segment'] {
  if (channel === 'frbo') return 'hot_frbo';
  if (channel === 'registry') return 'cold_registry';
  return 'warm';
}

function toSourceAppendInput(
  source: z.infer<typeof sourceInputSchema>,
  ownership: { personId: string; prospectId: string | null },
): AppendSourceEventInput {
  const common = {
    id: source.id,
    personId: ownership.personId,
    prospectId: ownership.prospectId,
    observedAt: source.observedAt,
    sourceRecord: source.sourceRecord,
    evidenceRef: source.evidenceRef,
  };
  if (source.channel === 'referral') {
    return { ...common, channel: source.channel, referral: source.referral };
  }
  if (source.channel === 'custom') {
    return {
      ...common,
      channel: source.channel,
      customSourceReason: source.customSourceReason,
    };
  }
  return { ...common, channel: source.channel };
}

function isDirectValidatedMatch(match: ContactMethodMatch): boolean {
  return match.person.deletedAt === null
    && match.contactMethod.reachability === 'direct'
    && match.contactMethod.validationState === 'valid';
}

function normalizeDisplayText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalizeContextText(value: string): string {
  return normalizeDisplayText(value).toLowerCase();
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(value.id, value);
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function parsePersistedIdentityReviewReason(reason: string | null): IdentityReviewReason {
  return z.enum([
    'shared_handle',
    'conflicting_handle_matches',
    'indirect_handle_match',
    'deleted_person_match',
  ]).parse(reason);
}

function assertJsonValue(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (value !== undefined) return;
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJsonValue(entry, field, seen);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${field} must be JSON-serializable.`);
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, field, seen);
    }
  } finally {
    seen.delete(value);
  }
}
