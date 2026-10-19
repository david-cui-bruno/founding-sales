import { randomUUID } from 'node:crypto';
import { NATIONAL_DNC_COVERED_AREA_CODES, NATIONAL_DNC_OWNER_APPROVED_AT, NATIONAL_DNC_OWNER_DECISION } from '@fss/contracts';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';

type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces; crm: SeededCrm };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (f: Fixture) => Promise<unknown> };
const receipts = 'phone_owner_risk_receipts';
const attempts = 'phone_handoff_attempts';
const absent = '00000000-0000-4000-8000-000000000123';

/** These rolled-back, privileged catalog fixtures isolate CHECK/FK/unique errors.
 * Actual admission/authority triggers are exercised by separate public-command tests.
 * No production adapter or ordinary registry fixture exposes this isolation seam.
 */
async function isolateCatalogConstraints(f: Fixture) {
  await f.session.query('DROP TRIGGER phone_owner_risk_receipt_guard ON phone_owner_risk_receipts');
  await f.session.query('DROP TRIGGER phone_handoff_owner_risk_guard ON phone_handoff_attempts');
}
async function insert(f: Fixture, table: string, row: Row) {
  const keys = Object.keys(row);
  return f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}
function receipt(f: Fixture): Row {
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), owner_user_id: f.seeded.alpha.admin.userId,
    decision_at: NATIONAL_DNC_OWNER_APPROVED_AT, approval_reference: NATIONAL_DNC_OWNER_DECISION,
    self_test_firm_id: f.crm.alpha.firmId, self_test_e164: '+14695550187', recorded_at: '2026-10-19T22:16:00Z',
    covered_area_codes: [...NATIONAL_DNC_COVERED_AREA_CODES] };
}
function erasedAttempt(f: Fixture): Row {
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), firm_id: f.crm.alpha.firmId,
    actor_user_id: f.seeded.alpha.admin.userId, device_id: f.seeded.alpha.admin.deviceId, command_id: randomUUID(),
    reserved_at: '2026-10-19T22:16:01Z', expires_at: '2026-10-19T22:16:16Z', erased_at: '2026-10-19T22:17:00Z' };
}
const bad = (constraint: string, changes: Row): Case => ({ constraint, run: async f => {
  await isolateCatalogConstraints(f);
  await insert(f, receipts, { ...receipt(f), ...changes });
  return f.session.query('SET CONSTRAINTS ALL IMMEDIATE');
} });
const duplicateReceipt = (constraint: string): Case => ({ constraint, run: async f => {
  await isolateCatalogConstraints(f);
  // Fixed policy constants deliberately overlap uniqueness. Isolate exactly one
  // key within the harness rollback, as the existing constraint catalog does.
  for (const other of ['phone_owner_risk_receipts_policy_version_key', 'phone_owner_risk_receipts_decision_at_key', 'phone_owner_risk_receipts_approval_reference_key']) {
    if (other !== constraint) await f.session.query(`ALTER TABLE phone_owner_risk_receipts DROP CONSTRAINT ${other}`);
  }
  const row = receipt(f);
  await insert(f, receipts, row);
  return insert(f, receipts, { ...row, id: constraint.endsWith('_pkey') ? row['id'] : randomUUID() });
} });

export const PHONE_OWNER_RISK_CONSTRAINT_CASES: readonly Case[] = [
  bad('phone_owner_risk_receipts_policy_version_check', { policy_version: 'general-bypass' }),
  bad('phone_owner_risk_receipts_decision_at_check', { decision_at: '2026-10-19T22:06:00Z' }),
  bad('phone_owner_risk_receipts_approval_reference_check', { approval_reference: 'not-approved' }),
  bad('phone_owner_risk_receipts_self_test_e164_check', { self_test_e164: '4695550187' }),
  bad('phone_owner_risk_receipts_subscription_expires_on_check', { subscription_expires_on: '2027-09-01' }),
  bad('phone_owner_risk_receipts_warning_version_check', { warning_version: 'silent' }),
  bad('phone_owner_risk_receipts_revocation_reference_check', { revoked_at: '2026-10-19T22:17:00Z', revocation_reference: ' ' }),
  bad('phone_owner_risk_receipts_covered_area_codes_check', { covered_area_codes: ['469'] }),
  bad('phone_owner_risk_receipts_check', { self_test_e164: null }),
  bad('phone_owner_risk_receipts_check1', { recorded_at: '2026-10-19T22:15:00Z' }),
  bad('phone_owner_risk_receipts_check2', { revoked_at: '2026-10-19T22:17:00Z' }),
  bad('phone_owner_risk_receipts_check3', { revoked_at: '2026-10-19T22:15:59Z', revocation_reference: 'fixture-revoke' }),
  bad('phone_owner_risk_receipts_workspace_id_fkey', { workspace_id: absent }),
  bad('phone_owner_risk_receipts_workspace_id_owner_user_id_fkey', { owner_user_id: absent }),
  bad('phone_owner_risk_receipts_workspace_id_self_test_firm_id_fkey', { self_test_firm_id: absent }),
  duplicateReceipt('phone_owner_risk_receipts_pkey'),
  duplicateReceipt('phone_owner_risk_receipts_policy_version_key'),
  duplicateReceipt('phone_owner_risk_receipts_decision_at_key'),
  duplicateReceipt('phone_owner_risk_receipts_approval_reference_key'),
  { constraint: 'phone_handoff_national_dnc_basis', run: async f => {
    await isolateCatalogConstraints(f);
    return insert(f, attempts, { ...erasedAttempt(f), national_dnc_basis: 'bypass' });
  } },
  { constraint: 'phone_handoff_owner_risk_shape', run: async f => {
    await isolateCatalogConstraints(f);
    return insert(f, attempts, { ...erasedAttempt(f), owner_risk_firm_id: f.crm.alpha.firmId });
  } },
  { constraint: 'phone_handoff_owner_risk_receipt_fk', run: async f => {
    await isolateCatalogConstraints(f);
    await insert(f, attempts, { ...erasedAttempt(f), national_dnc_basis: 'owner_self_test', owner_risk_receipt_id: absent, owner_risk_firm_id: f.crm.alpha.firmId });
    return f.session.query('SET CONSTRAINTS ALL IMMEDIATE');
  } },
  { constraint: 'phone_handoff_one_owner_self_test', run: async f => {
    await isolateCatalogConstraints(f);
    const approval = receipt(f);
    await insert(f, receipts, approval);
    const row = { ...erasedAttempt(f), national_dnc_basis: 'owner_self_test', owner_risk_receipt_id: approval['id'], owner_risk_firm_id: f.crm.alpha.firmId };
    await insert(f, attempts, row);
    // Erased attempts still permanently consume the one self-test receipt.
    return insert(f, attempts, { ...row, id: randomUUID(), command_id: randomUUID() });
  } },
];
