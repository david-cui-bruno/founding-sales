import type { TableCoverage } from './coverage.ts';

/** Phone evidence keeps irreversible attempts distinct from erasable endpoint proof. */
export const PHONE_RETENTION_COVERAGE: Readonly<Record<string, TableCoverage>> = {
  browser_audio_test_requests: {
    dispositions: ['retained', 'swept'],
    note: 'Temporary private destinations erase on terminal callbacks or original expiry through the existing telephony sweep. Opaque request, actor/device/caller/command identity and original lifetime remain immutable, preserving consumed and UNKNOWN history without a Firm or Person. Current membership/device checks block departed owners from issuance, consumption and receipt access; departure never refunds the test.',
  },
  call_sessions: {
    dispositions: ['retained', 'deletion_removes'],
    note: 'Business call attempts and recording references are removed with their firm or person. Audio test attempts retain immutable purpose, opaque execution, recording and billing/UNKNOWN history without CRM bindings; their temporary destination erases in browser_audio_test_requests rather than through prospect deletion.',
  },
  phone_handoff_attempts: {
    dispositions: ['retained', 'deletion_redacts'],
    note: 'Opaque reservations and immutable national-DNC basis retain shared cadence and permanent self-test consumption. Deletion clears endpoint, route, registry and office-proof references, contact/opportunity/item/log bindings. Retained receipt and original-firm opaque audit IDs cannot recreate source proof or dispatch authority.',
  },
  phone_owner_risk_receipts: {
    dispositions: ['retained', 'deletion_redacts'],
    note: 'Single dated body-free owner policy and immutable scope remain as business authorization history. Scoped erasure nulls the private self-test firm/endpoint binding and records monotone erasure without deleting the receipt or refunding consumption. Current owner/device/source/route, expiry and revocation are rechecked before use. Departure invalidates active authority, never erases the decision or resets the test.',
  },
  national_registry_snapshots: {
    dispositions: ['retained'],
    note: 'Private complete-publication receipts, opaque acquisition reference, format, local artifact integrity/count observations and area coverage contain no prospect identity, SAN, credentials or raw registry. Immutable after publication except one-way revocation. Retention does not confer fresh coverage or authorization.',
  },
  national_registry_endpoint_scrubs: {
    dispositions: ['retained', 'deletion_removes'],
    note: 'Exact endpoint evidence is removed with erased handles. Evidence is never dial authority by itself and stale, incomplete or revoked publication cannot authorize calling.',
  },
};
