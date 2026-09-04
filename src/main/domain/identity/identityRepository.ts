import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { compatibilityFlags } from '../compliance/contactCompliance';
import { contactComplianceEvidenceSchema } from '../compliance/contactComplianceTypes';
import {
  ContextLinkConflictError,
  DomainRepositoryDatabaseMismatchError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { IdGenerator } from '../support/idGenerator';
import type {
  AddContactMethodInput,
  AddOrganizationAliasInput,
  CanonicalPropertyAddress,
  ContactMethod,
  ContactMethodMatch,
  CreateOrganizationInput,
  CreatePersonInput,
  CreatePropertyInput,
  CreateProspectInput,
  LinkOrganizationInput,
  LinkPropertyInput,
  Organization,
  OrganizationAlias,
  Person,
  Property,
  Prospect,
  UpdateProspectQualificationInput,
} from './identityTypes';

export type {
  AddContactMethodInput,
  AddOrganizationAliasInput,
  CanonicalPropertyAddress,
  ContactMethod,
  ContactMethodMatch,
  CreateOrganizationInput,
  CreatePersonInput,
  CreatePropertyInput,
  CreateProspectInput,
  LinkOrganizationInput,
  LinkPropertyInput,
  Organization,
  OrganizationAlias,
  Person,
  Property,
  Prospect,
  UpdateProspectQualificationInput,
} from './identityTypes';

const idSchema = z.string().trim().min(1);
const nonemptyTextSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
const storedBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const nullableJsonTextSchema = z.string().transform(parseStoredJson).nullable();
const jsonTextSchema = z.string().transform(parseStoredJson);

const createPersonInputSchema = z.object({
  displayName: nonemptyTextSchema,
  aliases: z.array(nonemptyTextSchema).default([]),
  neverRecord: z.boolean().default(false),
  provenance: z.unknown().nullable().optional(),
}).strict();

const addContactMethodInputSchema = z.object({
  personId: idSchema,
  kind: z.enum(['phone', 'email']),
  normalizedValue: nonemptyTextSchema,
  rawValue: z.string().nullable().optional(),
  validationState: z.enum(['unverified', 'valid', 'invalid']),
  reachability: z.enum(['direct', 'indirect', 'none']),
  isPrimary: z.boolean().default(false),
  inContacts: z.boolean().nullable().optional(),
  dncListed: z.boolean().default(false),
  tcpaFlag: z.boolean().default(false),
  complianceEvidence: contactComplianceEvidenceSchema.optional(),
}).strict();

const qualificationGateReasonSchema = z.enum([
  'out_of_area', 'no_relevant_decision_relationship', 'institutional_outside_icp',
  'harmful_operator', 'non_paying_operator', 'unresolved_duplicate',
]);

function requireExactQualificationGate(
  value: { qualificationGateReason?: string | null | undefined },
  state: string,
  context: z.RefinementCtx,
): void {
  const requiresGate = state === 'disqualified';
  const hasGate = value.qualificationGateReason !== null
    && value.qualificationGateReason !== undefined;
  if (requiresGate === hasGate) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Disqualified requires an exact qualification gate reason; other states require null.',
  });
}

const createProspectInputSchema = z.object({
  personId: idSchema,
  originalSourceEventId: idSchema,
  segment: z.enum(['hot', 'cold', 'warm']),
  qualificationState: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
  qualificationGateReason: qualificationGateReasonSchema.nullable(),
  qualificationReason: z.string().nullable().optional(),
}).strict().superRefine((value, context) => {
  requireExactQualificationGate(value, value.qualificationState, context);
});

const createOrganizationInputSchema = z.object({
  canonicalName: nonemptyTextSchema,
  sourceRecord: z.unknown().nullable().optional(),
}).strict();

const addOrganizationAliasInputSchema = z.object({
  organizationId: idSchema,
  alias: nonemptyTextSchema,
}).strict();

const createPropertyInputSchema = z.object({
  organizationId: idSchema.nullable().optional(),
  addressLine1: nonemptyTextSchema,
  addressLine2: z.string().nullable().optional(),
  locality: nonemptyTextSchema,
  region: nonemptyTextSchema,
  postalCode: z.string().nullable().optional(),
  countryCode: z.string().trim().length(2).default('US'),
  doorCount: z.number().int().safe().nonnegative().nullable().optional(),
  propertyType: z.string().nullable().optional(),
  maintenanceProfile: z.unknown().nullable().optional(),
  sourceRecord: z.unknown().nullable().optional(),
  verifiedAt: utcTimestampSchema.nullable().optional(),
}).strict();

const linkOrganizationInputSchema = z.object({
  prospectId: idSchema,
  organizationId: idSchema,
  relationship: z.string().nullable().optional(),
}).strict();

const linkPropertyInputSchema = z.object({
  prospectId: idSchema,
  propertyId: idSchema,
  relationship: z.string().nullable().optional(),
}).strict();

const canonicalPropertyAddressSchema = z.object({
  addressLine1: nonemptyTextSchema,
  addressLine2: z.string().nullable().optional(),
  locality: nonemptyTextSchema,
  region: nonemptyTextSchema,
  postalCode: z.string().nullable().optional(),
  countryCode: z.string().trim().length(2),
}).strict();

const storedPersonRowSchema = z.object({
  id: idSchema,
  display_name: nonemptyTextSchema,
  aliases_json: jsonTextSchema.pipe(z.array(nonemptyTextSchema)),
  opted_out: storedBooleanSchema,
  opted_out_at: utcTimestampSchema.nullable(),
  never_record: storedBooleanSchema,
  deleted_at: utcTimestampSchema.nullable(),
  provenance_json: nullableJsonTextSchema,
  version: z.number().int().safe().positive(),
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();

const storedContactMethodRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  kind: z.enum(['phone', 'email']),
  normalized_value: nonemptyTextSchema,
  raw_value: z.string().nullable(),
  validation_state: z.enum(['unverified', 'valid', 'invalid']),
  reachability: z.enum(['direct', 'indirect', 'none']),
  is_primary: storedBooleanSchema,
  in_contacts: storedBooleanSchema.nullable(),
  dnc_listed: storedBooleanSchema,
  tcpa_flag: storedBooleanSchema,
  federal_status: z.enum(['unknown', 'verified_clear', 'listed']),
  compliance_tcpa_flag: storedBooleanSchema.nullable(),
  covered_area_code: z.string().regex(/^\d{3}$/).nullable(),
  compliance_source: z.enum(['ftc_download', 'enrichment_vendor', 'manual_import', 'legacy']),
  scrubbed_at: utcTimestampSchema.nullable(),
  compliance_expires_at: utcTimestampSchema.nullable(),
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();

const storedProspectRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  original_source_event_id: idSchema,
  segment: z.enum(['hot', 'cold', 'warm']),
  qualification_state: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
  qualification_gate_reason: qualificationGateReasonSchema.nullable(),
  qualification_reason: z.string().nullable(),
  last_contact_at: utcTimestampSchema.nullable(),
  version: z.number().int().safe().positive(),
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict().superRefine((row, context) => {
  const requiresGate = row.qualification_state === 'disqualified';
  if (requiresGate === (row.qualification_gate_reason !== null)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Stored Prospect qualification gate reason contradicts its state.',
  });
});

const storedOrganizationRowSchema = z.object({
  id: idSchema,
  canonical_name: nonemptyTextSchema,
  source_record_json: nullableJsonTextSchema,
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();

const storedOrganizationAliasRowSchema = z.object({
  id: idSchema,
  organization_id: idSchema,
  alias: nonemptyTextSchema,
  created_at: utcTimestampSchema,
}).strict();

const storedPropertyRowSchema = z.object({
  id: idSchema,
  organization_id: idSchema.nullable(),
  address_line_1: nonemptyTextSchema,
  address_line_2: z.string().nullable(),
  locality: nonemptyTextSchema,
  region: nonemptyTextSchema,
  postal_code: z.string().nullable(),
  country_code: z.string().length(2),
  door_count: z.number().int().safe().nonnegative().nullable(),
  property_type: z.string().nullable(),
  maintenance_profile_json: nullableJsonTextSchema,
  source_record_json: nullableJsonTextSchema,
  verified_at: utcTimestampSchema.nullable(),
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();
const storedRelationshipRowSchema = z.object({
  relationship: z.string().nullable(),
}).strict();

const handleLookupRowSchema = storedPersonRowSchema.extend({
  contact_id: idSchema,
  contact_person_id: idSchema,
  contact_kind: z.enum(['phone', 'email']),
  contact_normalized_value: nonemptyTextSchema,
  contact_raw_value: z.string().nullable(),
  contact_validation_state: z.enum(['unverified', 'valid', 'invalid']),
  contact_reachability: z.enum(['direct', 'indirect', 'none']),
  contact_is_primary: storedBooleanSchema,
  contact_in_contacts: storedBooleanSchema.nullable(),
  contact_dnc_listed: storedBooleanSchema,
  contact_tcpa_flag: storedBooleanSchema,
  contact_federal_status: z.enum(['unknown', 'verified_clear', 'listed']),
  contact_compliance_tcpa_flag: storedBooleanSchema.nullable(),
  contact_covered_area_code: z.string().regex(/^\d{3}$/).nullable(),
  contact_compliance_source: z.enum(['ftc_download', 'enrichment_vendor', 'manual_import', 'legacy']),
  contact_scrubbed_at: utcTimestampSchema.nullable(),
  contact_compliance_expires_at: utcTimestampSchema.nullable(),
  contact_created_at: utcTimestampSchema,
  contact_updated_at: utcTimestampSchema,
}).strict();
const organizationAliasLookupRowSchema = storedOrganizationRowSchema.extend({
  alias_id: idSchema,
  alias_organization_id: idSchema,
  alias_value: nonemptyTextSchema,
  alias_created_at: utcTimestampSchema,
}).strict();

const personColumns = `
  id, display_name, aliases_json, opted_out, opted_out_at, never_record,
  deleted_at, provenance_json, version, created_at, updated_at
`;
const prospectColumns = `
  id, person_id, original_source_event_id, segment, qualification_state,
  qualification_gate_reason, qualification_reason, last_contact_at, version,
  created_at, updated_at
`;

export class IdentityRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
    ids: IdGenerator;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  createPerson(input: CreatePersonInput): Person {
    this.unitOfWork.assertWriteScope();
    const parsed = createPersonInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const aliasesJson = serializeJson(parsed.aliases, 'aliases');
    const provenanceJson = parsed.provenance == null
      ? null
      : serializeJson(parsed.provenance, 'provenance');
    const row = this.database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, opted_out_at, never_record,
        deleted_at, provenance_json, version, created_at, updated_at
      ) VALUES (?, ?, ?, 0, NULL, ?, NULL, ?, 1, ?, ?)
      RETURNING ${personColumns}
    `).get(id, parsed.displayName, aliasesJson, parsed.neverRecord ? 1 : 0, provenanceJson, now, now);
    return parsePerson(row);
  }

  addContactMethod(input: AddContactMethodInput): ContactMethod {
    this.unitOfWork.assertWriteScope();
    const parsed = addContactMethodInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const suppliedEvidence = parsed.complianceEvidence ?? contactComplianceEvidenceSchema.parse({});
    const evidence = contactComplianceEvidenceSchema.parse({
      ...suppliedEvidence,
      federalStatus: parsed.dncListed || suppliedEvidence.federalStatus === 'listed'
        ? 'listed'
        : suppliedEvidence.federalStatus,
      tcpaFlag: parsed.tcpaFlag || suppliedEvidence.tcpaFlag === true
        ? true
        : suppliedEvidence.tcpaFlag,
    });
    const flags = compatibilityFlags(evidence);
    const row = this.database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, raw_value, validation_state,
        reachability, is_primary, in_contacts, dnc_listed, tcpa_flag,
        federal_status, compliance_tcpa_flag, covered_area_code, compliance_source,
        scrubbed_at, compliance_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, person_id, kind, normalized_value, raw_value, validation_state,
        reachability, is_primary, in_contacts, dnc_listed, tcpa_flag,
        federal_status, compliance_tcpa_flag, covered_area_code, compliance_source,
        scrubbed_at, compliance_expires_at,
        created_at, updated_at
    `).get(
      id,
      parsed.personId,
      parsed.kind,
      parsed.normalizedValue,
      parsed.rawValue ?? null,
      parsed.validationState,
      parsed.reachability,
      parsed.isPrimary ? 1 : 0,
      parsed.inContacts == null ? null : parsed.inContacts ? 1 : 0,
      flags.dncListed ? 1 : 0,
      flags.tcpaFlag ? 1 : 0,
      evidence.federalStatus,
      evidence.tcpaFlag == null ? null : evidence.tcpaFlag ? 1 : 0,
      evidence.coveredAreaCode,
      evidence.source,
      evidence.scrubbedAt,
      evidence.expiresAt,
      now,
      now,
    );
    return parseContactMethod(row);
  }

  createCanonicalProspect(input: CreateProspectInput): Prospect {
    this.unitOfWork.assertWriteScope();
    const parsed = createProspectInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const row = this.database.raw.prepare(`
      INSERT INTO prospects (
        id, person_id, original_source_event_id, segment, qualification_state,
        qualification_gate_reason, qualification_reason, last_contact_at, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      RETURNING ${prospectColumns}
    `).get(
      id,
      parsed.personId,
      parsed.originalSourceEventId,
      parsed.segment,
      parsed.qualificationState,
      parsed.qualificationGateReason,
      parsed.qualificationReason ?? null,
      now,
      now,
    );
    return parseProspect(row);
  }

  createOrganization(input: CreateOrganizationInput): Organization {
    this.unitOfWork.assertWriteScope();
    const parsed = createOrganizationInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const sourceRecordJson = parsed.sourceRecord == null
      ? null
      : serializeJson(parsed.sourceRecord, 'source record');
    const row = this.database.raw.prepare(`
      INSERT INTO organizations (id, canonical_name, source_record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id, canonical_name, source_record_json, created_at, updated_at
    `).get(id, parsed.canonicalName, sourceRecordJson, now, now);
    return parseOrganization(row);
  }

  addOrganizationAlias(input: AddOrganizationAliasInput): OrganizationAlias {
    this.unitOfWork.assertWriteScope();
    const parsed = addOrganizationAliasInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const row = this.database.raw.prepare(`
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES (?, ?, ?, ?)
      RETURNING id, organization_id, alias, created_at
    `).get(id, parsed.organizationId, parsed.alias, now);
    return parseOrganizationAlias(row);
  }

  createProperty(input: CreatePropertyInput): Property {
    this.unitOfWork.assertWriteScope();
    const parsed = createPropertyInputSchema.parse(input);
    const id = idSchema.parse(this.ids.next());
    const now = utcTimestampSchema.parse(this.clock.now());
    const maintenanceProfileJson = parsed.maintenanceProfile == null
      ? null
      : serializeJson(parsed.maintenanceProfile, 'maintenance profile');
    const sourceRecordJson = parsed.sourceRecord == null
      ? null
      : serializeJson(parsed.sourceRecord, 'source record');
    const row = this.database.raw.prepare(`
      INSERT INTO properties (
        id, organization_id, address_line_1, address_line_2, locality, region,
        postal_code, country_code, door_count, property_type,
        maintenance_profile_json, source_record_json, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, organization_id, address_line_1, address_line_2, locality, region,
        postal_code, country_code, door_count, property_type,
        maintenance_profile_json, source_record_json, verified_at, created_at, updated_at
    `).get(
      id,
      parsed.organizationId ?? null,
      parsed.addressLine1,
      parsed.addressLine2 ?? null,
      parsed.locality,
      parsed.region,
      parsed.postalCode ?? null,
      parsed.countryCode,
      parsed.doorCount ?? null,
      parsed.propertyType ?? null,
      maintenanceProfileJson,
      sourceRecordJson,
      parsed.verifiedAt ?? null,
      now,
      now,
    );
    return parseProperty(row);
  }

  linkOrganization(input: LinkOrganizationInput): void {
    this.unitOfWork.assertWriteScope();
    const parsed = linkOrganizationInputSchema.parse(input);
    const now = utcTimestampSchema.parse(this.clock.now());
    const relationship = parsed.relationship ?? null;
    const existing = this.database.raw.prepare(`
      SELECT relationship
      FROM prospect_organizations
      WHERE prospect_id = ? AND organization_id = ?
    `).get(parsed.prospectId, parsed.organizationId);
    if (existing !== undefined) {
      const canonical = storedRelationshipRowSchema.parse(existing);
      if (canonical.relationship === relationship) return;
      throw new ContextLinkConflictError(
        'organization', parsed.prospectId, parsed.organizationId,
      );
    }
    this.database.raw.prepare(`
      INSERT INTO prospect_organizations (
        prospect_id, organization_id, relationship, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(parsed.prospectId, parsed.organizationId, relationship, now);
  }

  linkProperty(input: LinkPropertyInput): void {
    this.unitOfWork.assertWriteScope();
    const parsed = linkPropertyInputSchema.parse(input);
    const now = utcTimestampSchema.parse(this.clock.now());
    const relationship = parsed.relationship ?? null;
    const existing = this.database.raw.prepare(`
      SELECT relationship
      FROM prospect_properties
      WHERE prospect_id = ? AND property_id = ?
    `).get(parsed.prospectId, parsed.propertyId);
    if (existing !== undefined) {
      const canonical = storedRelationshipRowSchema.parse(existing);
      if (canonical.relationship === relationship) return;
      throw new ContextLinkConflictError('property', parsed.prospectId, parsed.propertyId);
    }
    this.database.raw.prepare(`
      INSERT INTO prospect_properties (
        prospect_id, property_id, relationship, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(parsed.prospectId, parsed.propertyId, relationship, now);
  }

  findPeopleByNormalizedHandle(kind: 'phone' | 'email', value: string): Person[] {
    return this.findContactMatchesByNormalizedHandle(kind, value)
      .map(({ person }) => person);
  }

  findContactMatchesByNormalizedHandle(
    kind: 'phone' | 'email',
    value: string,
  ): ContactMethodMatch[] {
    const parsedKind = z.enum(['phone', 'email']).parse(kind);
    const parsedValue = nonemptyTextSchema.parse(value);
    const rows = this.database.raw.prepare(`
      SELECT
        p.id, p.display_name, p.aliases_json, p.opted_out, p.opted_out_at,
        p.never_record, p.deleted_at, p.provenance_json, p.version,
        p.created_at, p.updated_at,
        c.id AS contact_id, c.person_id AS contact_person_id,
        c.kind AS contact_kind, c.normalized_value AS contact_normalized_value,
        c.raw_value AS contact_raw_value, c.validation_state AS contact_validation_state,
        c.reachability AS contact_reachability, c.is_primary AS contact_is_primary,
        c.in_contacts AS contact_in_contacts, c.dnc_listed AS contact_dnc_listed,
        c.tcpa_flag AS contact_tcpa_flag,
        c.federal_status AS contact_federal_status,
        c.compliance_tcpa_flag AS contact_compliance_tcpa_flag,
        c.covered_area_code AS contact_covered_area_code,
        c.compliance_source AS contact_compliance_source,
        c.scrubbed_at AS contact_scrubbed_at,
        c.compliance_expires_at AS contact_compliance_expires_at,
        c.created_at AS contact_created_at,
        c.updated_at AS contact_updated_at
      FROM person_contact_methods AS c
      JOIN persons AS p ON p.id = c.person_id
      WHERE c.kind = ? AND c.normalized_value = ?
      ORDER BY p.id ASC
    `).all(parsedKind, parsedValue);

    return rows.map((value) => {
      const row = handleLookupRowSchema.parse(value);
      const contactMethod = parseContactMethod({
        id: row.contact_id,
        person_id: row.contact_person_id,
        kind: row.contact_kind,
        normalized_value: row.contact_normalized_value,
        raw_value: row.contact_raw_value,
        validation_state: row.contact_validation_state,
        reachability: row.contact_reachability,
        is_primary: row.contact_is_primary,
        in_contacts: row.contact_in_contacts,
        dnc_listed: row.contact_dnc_listed,
        tcpa_flag: row.contact_tcpa_flag,
        federal_status: row.contact_federal_status,
        compliance_tcpa_flag: row.contact_compliance_tcpa_flag,
        covered_area_code: row.contact_covered_area_code,
        compliance_source: row.contact_compliance_source,
        scrubbed_at: row.contact_scrubbed_at,
        compliance_expires_at: row.contact_compliance_expires_at,
        created_at: row.contact_created_at,
        updated_at: row.contact_updated_at,
      });
      return {
        person: personFromStoredRow(row),
        contactMethod,
      };
    });
  }

  getPerson(personId: string): Person | null {
    const id = idSchema.parse(personId);
    const row = this.database.raw.prepare(`
      SELECT ${personColumns}
      FROM persons
      WHERE id = ?
    `).get(id);
    return row === undefined ? null : parsePerson(row);
  }

  listContactMethodsForPerson(personId: string): ContactMethod[] {
    const id = idSchema.parse(personId);
    return this.database.raw.prepare(`
      SELECT id, person_id, kind, normalized_value, raw_value, validation_state,
        reachability, is_primary, in_contacts, dnc_listed, tcpa_flag,
        federal_status, compliance_tcpa_flag, covered_area_code, compliance_source,
        scrubbed_at, compliance_expires_at,
        created_at, updated_at
      FROM person_contact_methods
      WHERE person_id = ?
      ORDER BY kind ASC, normalized_value ASC, id ASC
    `).all(id).map(parseContactMethod);
  }

  findOrganizationsByNormalizedAlias(alias: string): Organization[] {
    const parsedAlias = nonemptyTextSchema.parse(alias);
    const rows = this.database.raw.prepare(`
      SELECT
        o.id, o.canonical_name, o.source_record_json, o.created_at, o.updated_at,
        a.id AS alias_id, a.organization_id AS alias_organization_id,
        a.alias AS alias_value, a.created_at AS alias_created_at
      FROM organization_aliases AS a
      JOIN organizations AS o ON o.id = a.organization_id
      WHERE a.alias = ?
      ORDER BY o.id ASC
    `).all(parsedAlias);
    return rows.map((value) => {
      const row = organizationAliasLookupRowSchema.parse(value);
      parseOrganizationAlias({
        id: row.alias_id,
        organization_id: row.alias_organization_id,
        alias: row.alias_value,
        created_at: row.alias_created_at,
      });
      return organizationFromStoredRow(row);
    });
  }

  findPropertiesByCanonicalAddress(address: CanonicalPropertyAddress): Property[] {
    const parsed = canonicalPropertyAddressSchema.parse(address);
    const rows = this.database.raw.prepare(`
      SELECT id, organization_id, address_line_1, address_line_2, locality, region,
        postal_code, country_code, door_count, property_type,
        maintenance_profile_json, source_record_json, verified_at, created_at, updated_at
      FROM properties
      WHERE address_line_1 = ?
        AND address_line_2 IS ?
        AND locality = ?
        AND region = ?
        AND postal_code IS ?
        AND country_code = ?
      ORDER BY id ASC
    `).all(
      parsed.addressLine1,
      parsed.addressLine2 ?? null,
      parsed.locality,
      parsed.region,
      parsed.postalCode ?? null,
      parsed.countryCode,
    );
    return rows.map(parseProperty);
  }

  listOrganizationsForProspect(prospectId: string): Organization[] {
    const id = idSchema.parse(prospectId);
    const rows = this.database.raw.prepare(`
      SELECT o.id, o.canonical_name, o.source_record_json, o.created_at, o.updated_at
      FROM prospect_organizations AS link
      JOIN organizations AS o ON o.id = link.organization_id
      WHERE link.prospect_id = ?
      ORDER BY o.id ASC
    `).all(id);
    return rows.map(parseOrganization);
  }

  listPropertiesForProspect(prospectId: string): Property[] {
    const id = idSchema.parse(prospectId);
    const rows = this.database.raw.prepare(`
      SELECT p.id, p.organization_id, p.address_line_1, p.address_line_2,
        p.locality, p.region, p.postal_code, p.country_code, p.door_count,
        p.property_type, p.maintenance_profile_json, p.source_record_json,
        p.verified_at, p.created_at, p.updated_at
      FROM prospect_properties AS link
      JOIN properties AS p ON p.id = link.property_id
      WHERE link.prospect_id = ?
      ORDER BY p.id ASC
    `).all(id);
    return rows.map(parseProperty);
  }

  getCanonicalProspect(personId: string): Prospect | null {
    const id = idSchema.parse(personId);
    const row = this.database.raw.prepare(`
      SELECT ${prospectColumns}
      FROM prospects
      WHERE person_id = ?
    `).get(id);
    return row === undefined ? null : parseProspect(row);
  }

  updateProspectQualification(input: UpdateProspectQualificationInput): Prospect {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      prospectId: idSchema,
      personId: idSchema,
      expectedVersion: z.number().int().safe().positive(),
      expectedState: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
      nextState: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
      qualificationGateReason: qualificationGateReasonSchema.nullable(),
      reason: z.string().nullable(),
      updatedAt: utcTimestampSchema,
    }).strict().superRefine((value, context) => {
      requireExactQualificationGate(value, value.nextState, context);
    }).parse(input);
    const row = this.database.raw.prepare(`
      UPDATE prospects
      SET qualification_state = ?, qualification_gate_reason = ?, qualification_reason = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND person_id = ? AND version = ? AND qualification_state = ?
      RETURNING ${prospectColumns}
    `).get(
      parsed.nextState, parsed.qualificationGateReason, parsed.reason, parsed.updatedAt,
      parsed.prospectId, parsed.personId, parsed.expectedVersion, parsed.expectedState,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseProspect(row);
  }
}

function parsePerson(value: unknown): Person {
  return personFromStoredRow(storedPersonRowSchema.parse(value));
}

function personFromStoredRow(row: z.infer<typeof storedPersonRowSchema>): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    aliases: row.aliases_json,
    optedOut: row.opted_out === 1,
    optedOutAt: row.opted_out_at,
    neverRecord: row.never_record === 1,
    deletedAt: row.deleted_at,
    provenance: row.provenance_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseContactMethod(value: unknown): ContactMethod {
  const row = storedContactMethodRowSchema.parse(value);
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    normalizedValue: row.normalized_value,
    rawValue: row.raw_value,
    validationState: row.validation_state,
    reachability: row.reachability,
    isPrimary: row.is_primary === 1,
    inContacts: row.in_contacts === null ? null : row.in_contacts === 1,
    dncListed: row.dnc_listed === 1,
    tcpaFlag: row.tcpa_flag === 1,
    complianceEvidence: {
      federalStatus: row.federal_status,
      tcpaFlag: row.compliance_tcpa_flag === null ? null : row.compliance_tcpa_flag === 1,
      coveredAreaCode: row.covered_area_code,
      source: row.compliance_source,
      scrubbedAt: row.scrubbed_at,
      expiresAt: row.compliance_expires_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseProspect(value: unknown): Prospect {
  const row = storedProspectRowSchema.parse(value);
  const base = {
    id: row.id,
    personId: row.person_id,
    originalSourceEventId: row.original_source_event_id,
    segment: row.segment,
    qualificationReason: row.qualification_reason,
    lastContactAt: row.last_contact_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.qualification_state === 'disqualified') {
    return {
      ...base,
      qualificationState: 'disqualified',
      qualificationGateReason: row.qualification_gate_reason!,
    };
  }
  return {
    ...base,
    qualificationState: row.qualification_state,
    qualificationGateReason: null,
  };
}

function parseOrganization(value: unknown): Organization {
  return organizationFromStoredRow(storedOrganizationRowSchema.parse(value));
}

function organizationFromStoredRow(
  row: z.infer<typeof storedOrganizationRowSchema>,
): Organization {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    sourceRecord: row.source_record_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOrganizationAlias(value: unknown): OrganizationAlias {
  const row = storedOrganizationAliasRowSchema.parse(value);
  return {
    id: row.id,
    organizationId: row.organization_id,
    alias: row.alias,
    createdAt: row.created_at,
  };
}

function parseProperty(value: unknown): Property {
  const row = storedPropertyRowSchema.parse(value);
  return {
    id: row.id,
    organizationId: row.organization_id,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    locality: row.locality,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    doorCount: row.door_count,
    propertyType: row.property_type,
    maintenanceProfile: row.maintenance_profile_json,
    sourceRecord: row.source_record_json,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredJson(value: string, context: z.RefinementCtx): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stored JSON is malformed.',
    });
    return z.NEVER;
  }
}

function serializeJson(value: unknown, field: string): string {
  assertJsonValue(value, new Set(), field);
  return JSON.stringify(value);
}

function assertJsonValue(value: unknown, seen: Set<object>, field: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (seen.has(value)) throw new TypeError(`${field} must be JSON-serializable.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJsonValue(entry, seen, field);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${field} must be JSON-serializable.`);
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, seen, field);
    }
  } finally {
    seen.delete(value);
  }
}
