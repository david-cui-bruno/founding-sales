import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { IdentityRepository } from '../identity/identityRepository';
import type { ContactMethod } from '../identity/identityTypes';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { IdGenerator } from '../support/idGenerator';
import {
  evaluateFederalEvidence,
  mergeContactComplianceEvidence,
} from './contactCompliance';
import {
  contactComplianceEvidenceSchema,
  type CorrectContactComplianceEvidenceInput,
} from './contactComplianceTypes';
export type { CorrectContactComplianceEvidenceInput } from './contactComplianceTypes';

const idSchema = z.string().trim().min(1);
const nonblankSchema = z.string().trim().min(1);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  'Timestamp must use canonical UTC ISO format.',
);
const correctionSchema = z.object({
  contactMethodId: idSchema,
  evidence: contactComplianceEvidenceSchema,
  evidenceRef: nonblankSchema,
  correctionReason: nonblankSchema,
  correctedAt: canonicalTimestampSchema,
  policyVersion: z.literal('contact_compliance_correction_v1'),
}).strict();

function evidenceJson(evidence: ContactMethod['complianceEvidence'], correctionReason?: string): string {
  return JSON.stringify(correctionReason === undefined ? evidence : { ...evidence, correctionReason });
}

export class ContactComplianceService {
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly identities: IdentityRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    clock: Clock;
    ids: IdGenerator;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (database.raw !== unitOfWork.database.raw || unitOfWork !== this.unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.identities.assertBoundTo(database, unitOfWork);
  }

  mergeFromIntake(input: {
    contactMethodId: string;
    incoming: ContactMethod['complianceEvidence'];
    evidenceRef: string | null;
    observedAt: string;
  }): ContactMethod {
    this.unitOfWork.assertWriteScope();
    const contactMethodId = idSchema.parse(input.contactMethodId);
    const incoming = contactComplianceEvidenceSchema.parse(input.incoming);
    const observedAt = canonicalTimestampSchema.parse(input.observedAt);
    const evidenceRef = input.evidenceRef === null ? null : nonblankSchema.parse(input.evidenceRef);
    const current = this.identities.getContactMethod(contactMethodId);
    if (current === null) throw new Error('Contact method not found.');
    if (current.kind !== 'phone') return current;
    const merged = mergeContactComplianceEvidence({
      current: current.complianceEvidence,
      incoming,
      normalizedPhone: current.normalizedValue,
      now: observedAt,
    });
    if (!merged.changed) return current;
    const updated = this.identities.updateContactComplianceEvidence({
      contactMethodId, expected: current.complianceEvidence,
      evidence: merged.evidence, updatedAt: observedAt,
    });
    this.identities.appendContactComplianceAudit({
      id: idSchema.parse(this.ids.next()),
      contactMethodId,
      operation: 'intake_merge',
      oldEvidenceJson: evidenceJson(current.complianceEvidence),
      newEvidenceJson: evidenceJson(updated.complianceEvidence),
      source: incoming.source,
      evidenceTimestamp: incoming.scrubbedAt ?? observedAt,
      evidenceRef,
      policyVersion: 'contact-compliance-v1',
      resultingReasonCode: merged.reasonCode,
      createdAt: canonicalTimestampSchema.parse(this.clock.now()),
    });
    return updated;
  }

  correctAuthoritatively(input: CorrectContactComplianceEvidenceInput): ContactMethod {
    const parsed = correctionSchema.parse(input);
    return this.unitOfWork.immediate(() => {
      const current = this.identities.getContactMethod(parsed.contactMethodId);
      if (current === null) throw new Error('Contact method not found.');
      if (current.kind !== 'phone') {
        throw new Error('Compliance correction requires a phone contact.');
      }
      const federal = evaluateFederalEvidence({
        normalizedPhone: current.normalizedValue,
        evidence: parsed.evidence,
        now: parsed.correctedAt,
      });
      const resultingReasonCode = federal.kind === 'usable_clear'
        ? 'usable_clear'
        : federal.reasonCode;
      if (federal.kind !== 'usable_clear') {
        throw new Error('Authoritative correction evidence must be fully usable.');
      }
      const updated = this.identities.updateContactComplianceEvidence({
        contactMethodId: current.id,
        expected: current.complianceEvidence,
        evidence: parsed.evidence,
        updatedAt: parsed.correctedAt,
      });
      this.identities.appendContactComplianceAudit({
        id: idSchema.parse(this.ids.next()),
        contactMethodId: current.id,
        operation: 'authoritative_correction',
        oldEvidenceJson: evidenceJson(current.complianceEvidence),
        newEvidenceJson: evidenceJson(updated.complianceEvidence, parsed.correctionReason),
        source: parsed.evidence.source,
        evidenceTimestamp: parsed.evidence.scrubbedAt,
        evidenceRef: parsed.evidenceRef,
        policyVersion: parsed.policyVersion,
        resultingReasonCode,
        createdAt: parsed.correctedAt,
      });
      return updated;
    });
  }
}
