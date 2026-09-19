import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listAttempts } from '../../src/v1/attempts';
import { deriveStateAndZone, evidenceKey, evidenceRecordSchema, evidenceSummaryLine, EVIDENCE_EXCERPT_MAX, EVIDENCE_MAX_SOURCES,
  readEvidence, writeEvidence } from '../../src/v1/evidence';
import { firmRecord } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * Research on the queue (FSS target design sections 2 and 4; slice S4), on the real store adapter with the
 * in-memory harness. Every provider call goes through an injected fetch; nothing here reaches Places, a web
 * page or a mailbox, and nothing dials, sends or books.
 */

const START = '2026-09-18T12:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (n: number, excerpt: string) => ({ url: `https://firm-${n}.example/page`, fetchedAt: START, sha256: sha(excerpt), excerpt });

describe('EVIDENCE#<firmId>: the sources split off the firm record', () => {
  it('writes the sources, the extraction and the business email finding under one revision', async () => {
    const f = v1Fixture(START);
    const written = await writeEvidence(f.store, { firmId: 'account-ri-1', revision: 1,
      sources: [source(1, 'We manage 120 residential units in Providence.')],
      extraction: { facts: [{ key: 'portfolio_description', sourceId: 'page-1', quote: 'We manage 120 residential units' }], at: START },
      businessEmailFinding: { email: 'info@firm-1.example', sourceId: 'page-1', selection: 'role_mailbox',
        considered: ['info@firm-1.example'], refused: { free_mail: 1, off_domain: 0, withheld_contact: 0, unparsable: 0 } } });
    expect(written).toEqual({ written: true, revision: 1 });

    const stored = evidenceRecordSchema.parse(f.db.inspect(evidenceKey('account-ri-1')));
    expect(stored.sources).toHaveLength(1);
    expect(stored.businessEmailFinding?.email).toBe('info@firm-1.example');
    expect((await readEvidence(f.store, 'account-ri-1'))?.record.revision).toBe(1);
  });

  it('refuses a write over the store size limit rather than truncating, and records it as a research attempt', async () => {
    const f = v1Fixture(START);
    // Forty sources at the excerpt ceiling is past the item limit the store refuses at; nothing is cut to fit.
    const sources = Array.from({ length: EVIDENCE_MAX_SOURCES }, (_, n) => source(n, 'x'.repeat(EVIDENCE_EXCERPT_MAX)));
    const written = await writeEvidence(f.store, { firmId: 'account-ri-2', revision: 1, sources, extraction: null, businessEmailFinding: null });
    expect(written).toEqual({ written: false, reason: 'evidence_too_large' });
    expect(f.db.inspect(evidenceKey('account-ri-2'))).toBeUndefined();

    const attempts = await listAttempts(f.store, { kind: 'research' });
    expect(attempts[0]).toMatchObject({ kind: 'research', outcome: 'failed', reason: 'evidence_too_large',
      detail: { code: 'evidence_too_large', firmId: 'account-ri-2' } });
  });

  it('derives state and zone here, as the one implementation the firm adapter also calls', () => {
    const providence = deriveStateAndZone(firmRecord({ id: 'account-ri-3', name: 'Firm', address: '3 Hope St, Providence, RI 02906, USA', researchedAt: START }));
    expect(providence).toMatchObject({ city: 'Providence', state: 'RI', timeZone: 'America/New_York', hold: null });
    const unknown = deriveStateAndZone(firmRecord({ id: 'account-xx-1', name: 'Firm', address: null, researchedAt: START }));
    expect(unknown.state).toBeNull();
    expect(unknown.hold).toEqual({ reason: 'state_not_cleared', code: 'state_unknown' });
  });

  it('summarises the evidence in one line short enough for the firm record', () => {
    const line = evidenceSummaryLine({ sources: 4, businessEmail: 'info@firm.example', facts: 2, researchedAt: START });
    expect(line).toContain('4 sources');
    expect(line).toContain('business email');
    expect(line.length).toBeLessThanOrEqual(400);
  });
});
