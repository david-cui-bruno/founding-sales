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

export type ContextReviewReason = 'ambiguous_organization' | 'ambiguous_property';
export type IntakeDisposition = 'created' | 'matched_existing' | 'created_merge_review';
export type IntakeFaultPoint =
  | 'after_person'
  | 'after_source_event'
  | 'after_prospect'
  | 'after_organization'
  | 'after_organization_link'
  | 'after_property'
  | 'after_property_link';

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
    if (/^\+[1-9]\d{7,14}$/.test(normalized)) return normalized;
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
  private readonly faultInjector: ((point: IntakeFaultPoint) => void) | undefined;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    sources: SourceRepository;
    faultInjector?: (point: IntakeFaultPoint) => void;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.sources = input.sources;
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
    const replay = this.sources.getById(command.source.id);
    if (replay !== null) {
      this.sources.append(toSourceAppendInput(command.source, {
        personId: replay.personId,
        prospectId: replay.prospectId,
      }));
      const prospect = this.identities.getCanonicalProspect(replay.personId);
      if (prospect === null) {
        throw new Error('The replayed source event has no canonical Prospect.');
      }
      return {
        disposition: 'matched_existing',
        personId: replay.personId,
        prospectId: prospect.id,
        sourceEventId: replay.id,
        identityReviewReason: prospect.qualificationState === 'merge_review'
          ? parseIdentityReviewReason(prospect.qualificationReason)
          : null,
        contextReviewReasons: [],
        organizationIds: this.identities.listOrganizationsForProspect(prospect.id)
          .map(({ id }) => id),
        propertyIds: this.identities.listPropertiesForProspect(prospect.id)
          .map(({ id }) => id),
      };
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
    const disposition: IntakeDisposition = identityResolution.reviewReason !== null
      ? 'created_merge_review'
      : identityResolution.personId === null
        ? 'created'
        : 'matched_existing';
    return {
      disposition,
      personId: person.id,
      prospectId: prospect.id,
      sourceEventId: sourceEvent.id,
      identityReviewReason: identityResolution.reviewReason,
      ...contextResult,
    };
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
    if (allMatches.some(({ person }) => person.deletedAt !== null)) {
      return { personId: null, reviewReason: 'deleted_person_match' };
    }

    const directIdsByContact = matchesByContact.map(({ contact, matches }) => {
      if (contact.reachability !== 'direct') return new Set<string>();
      return new Set(matches.filter(isDirectValidatedMatch).map(({ person }) => person.id));
    });
    if (directIdsByContact.some((ids) => ids.size > 1)) {
      return { personId: null, reviewReason: 'shared_handle' };
    }
    const allDirectIds = new Set(directIdsByContact.flatMap((ids) => [...ids]));
    if (allDirectIds.size > 1) {
      return { personId: null, reviewReason: 'conflicting_handle_matches' };
    }
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
      const matches = this.identities.findPropertiesByCanonicalAddress(context.canonicalAddress);
      if (matches.length > 1) {
        addUnique(reviewReasons, 'ambiguous_property');
        continue;
      }
      let property: Property;
      if (matches[0] === undefined) {
        const organizationId = context.organizationAlias == null
          ? null
          : this.findUniqueOrganizationId(context.organizationAlias, reviewReasons);
        property = this.identities.createProperty({
          organizationId,
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

  private findUniqueOrganizationId(
    alias: string,
    reviewReasons: ContextReviewReason[],
  ): string | null {
    const matches = this.identities.findOrganizationsByNormalizedAlias(
      normalizeContextText(alias),
    );
    if (matches.length > 1) {
      addUnique(reviewReasons, 'ambiguous_organization');
      return null;
    }
    return matches[0]?.id ?? null;
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
  const organizations = parsed.organizations.map((organization) => {
    if (organization.sourceRecord !== undefined) {
      assertJsonValue(organization.sourceRecord, 'organization source record');
    }
    return {
      ...organization,
      normalizedAliases: [...new Set([
        organization.canonicalName,
        ...organization.aliases,
      ].map(normalizeContextText))],
    };
  });
  const properties = parsed.properties.map((property) => {
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
      ...property,
      countryCode: property.countryCode.toUpperCase(),
      organizationAlias: property.organizationAlias == null
        ? null
        : normalizeContextText(property.organizationAlias),
      canonicalAddress,
    };
  });
  return {
    person: {
      displayName: nonblankSchema.parse(parsed.person.displayName),
      aliases: parsed.person.aliases,
      neverRecord: parsed.person.neverRecord,
      provenance: parsed.person.provenance,
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
    if (deduplicated.has(key)) continue;
    deduplicated.set(key, {
      kind: contact.kind,
      normalizedValue,
      rawValue: contact.value,
      reachability: contact.reachability,
      isPrimary: contact.isPrimary,
      inContacts: contact.inContacts ?? null,
    });
  }
  return [...deduplicated.values()];
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

function parseIdentityReviewReason(reason: string | null): IdentityReviewReason | null {
  return z.enum([
    'shared_handle',
    'conflicting_handle_matches',
    'indirect_handle_match',
    'deleted_person_match',
  ]).nullable().parse(reason);
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
