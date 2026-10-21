import type { TableCoverage } from './coverage.ts';

/** Capture authority and one-use recovery retain no copied provider content. */
export const CAPTURE_AUTHORITY_RETENTION_COVERAGE: Readonly<Record<string, TableCoverage>> = {
  crm_capability_owner_approvals: {
    dispositions: ['retained'],
    note: 'Immutable body-free owner approval audit retains configuration fingerprints, attested checks, quality tier and acknowledged limitations. Current owner membership and configuration are rechecked before use; no conversation content or credentials.',
  },
  crm_acquisition_diagnostic_authorizations: {
    dispositions: ['retained'],
    note: 'Immutable body-free acquisition diagnostic owner consent and revocation audit; exact current owner/account/expiry/environment binding prevents reuse; no copied content or tokens.',
  },
  crm_acquisition_diagnostic_reads: {
    dispositions: ['retained'],
    note: 'Body-free exact scoped provider read accounting survives source deletion and revocation; no original content or tokens.',
  },
  crm_capture_read_recoveries: {
    dispositions: ['retained'],
    note: 'Immutable body-free one-use capture recovery audit. No provider payloads, tokens, originals or sending authority. Mailbox or original incident deletion cascades; current consent and binding are rechecked for use.',
  },
  crm_capture_read_progress: {
    dispositions: ['operational'],
    note: 'Private bounded forward enumeration token and counters, not captured contents or operational coverage. Mailbox/incident deletion cascades through recovery; ordinary CRM observer preserves address deletion barriers and departure stops current authority.',
  },
};
