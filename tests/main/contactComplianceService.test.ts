import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  mergeContactComplianceEvidence,
} from '../../src/main/domain/compliance/contactCompliance';
import { ContactComplianceService } from '../../src/main/domain/compliance/contactComplianceService';
import type { ContactComplianceEvidence } from '../../src/main/domain/compliance/contactComplianceTypes';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const NOW = '2026-09-04T18:00:00.000Z';
const CLEAR: ContactComplianceEvidence = {
  federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401',
  source: 'ftc_download', scrubbedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
};
const UNKNOWN: ContactComplianceEvidence = {
  federalStatus: 'unknown', tcpaFlag: null, coveredAreaCode: null,
  source: 'legacy', scrubbedAt: null, expiresAt: null,
};

function merge(current: ContactComplianceEvidence, incoming: ContactComplianceEvidence) {
  return mergeContactComplianceEvidence({
    current, incoming, normalizedPhone: '+14015550100', now: NOW,
  });
}

describe('mergeContactComplianceEvidence', () => {
  it('upgrades an existing phone from unknown TCPA to positive', () => {
    const result = merge(UNKNOWN, { ...UNKNOWN, tcpaFlag: true, source: 'manual_import' });
    expect(result).toMatchObject({ changed: true, reasonCode: 'federal_status_unknown' });
    expect(result.evidence.tcpaFlag).toBe(true);
  });

  it('allows fresh covered clear to replace unknown', () => {
    expect(merge(UNKNOWN, CLEAR)).toEqual({
      evidence: CLEAR, changed: true, reasonCode: 'usable_clear',
    });
  });

  it('does not clear listed with later ordinary clear evidence', () => {
    const listed = { ...UNKNOWN, federalStatus: 'listed' as const, source: 'manual_import' as const };
    const result = merge(listed, CLEAR);
    expect(result.evidence.federalStatus).toBe('listed');
    expect(result.reasonCode).toBe('federal_dnc_listed');
  });

  it('does not clear TCPA positive with later ordinary false evidence', () => {
    const positive = { ...UNKNOWN, tcpaFlag: true, source: 'manual_import' as const };
    const result = merge(positive, CLEAR);
    expect(result.evidence.tcpaFlag).toBe(true);
    expect(result.reasonCode).toBe('tcpa_blocked');
  });
});

describe('ContactComplianceService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let identities: IdentityRepository;
  let service: ContactComplianceService;
  const ids = ['person', 'contact', 'correction-audit'];

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    unitOfWork = new DomainUnitOfWork(database);
    identities = new IdentityRepository({
      database, unitOfWork, clock: { now: () => NOW },
      ids: { next: () => ids.shift() ?? 'unexpected-id' },
    });
    service = new ContactComplianceService({
      database, unitOfWork, identities, clock: { now: () => NOW },
      ids: { next: () => ids.shift() ?? 'unexpected-id' },
    });
    unitOfWork.immediate(() => {
      identities.createPerson({ displayName: 'Contact' });
      identities.addContactMethod({
        personId: 'person', kind: 'phone', normalizedValue: '+14015550100',
        validationState: 'valid', reachability: 'direct', complianceEvidence: {
          ...UNKNOWN, federalStatus: 'listed', source: 'manual_import',
        },
      });
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('authoritative correction clears a positive only with complete audited evidence', () => {
    expect(() => service.correctAuthoritatively({
      contactMethodId: 'contact', evidence: CLEAR, evidenceRef: ' ',
      correctionReason: 'confirmed false positive', correctedAt: NOW,
      policyVersion: 'contact_compliance_correction_v1',
    })).toThrow();

    const corrected = service.correctAuthoritatively({
      contactMethodId: 'contact', evidence: CLEAR, evidenceRef: 'case-42',
      correctionReason: 'confirmed false positive', correctedAt: NOW,
      policyVersion: 'contact_compliance_correction_v1',
    });
    expect(corrected.complianceEvidence).toEqual(CLEAR);
    expect(database.raw.prepare(`
      SELECT operation, evidence_ref, policy_version, resulting_reason_code
      FROM contact_compliance_audit_events WHERE contact_method_id = ?
    `).get(corrected.id)).toEqual({
      operation: 'authoritative_correction', evidence_ref: 'case-42',
      policy_version: 'contact_compliance_correction_v1', resulting_reason_code: 'usable_clear',
    });
  });
});
