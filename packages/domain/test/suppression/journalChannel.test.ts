import { describe, expect, it } from 'vitest';
import {
  deterministicEventId,
  journalObjectBody,
  SUPPRESSION_JOURNAL_SCHEMA,
  type SuppressionJournalRecord,
} from '../../suppression/journal.ts';
import { parseSuppressionJournalRecord } from '../../suppression/replay.ts';

/**
 * Contract check CC3 and test P1-7 (DESIGN-S3X §2.4): the journal carries the channel, and
 * ids and replay stay idempotent.
 *
 * The golden ids below were computed by `deterministicEventId` at main 65d5971e, before
 * migration 0037. An `all` event (and one that names no channel) must keep that id, or a
 * replay after a restore would insert a second copy of every stop it restores.
 */
const WORKSPACE = '00000000-0000-4000-8000-000000000001';

const GOLDEN = [
  {
    input: { workspaceId: WORKSPACE, scope: 'handle', canonicalKey: '+14015550123', source: 'prospect_do_not_call', commandId: 'cmd-1:handle' },
    id: 'sup_5c2c98775f929157215635643e0292d2896c09b7b7408fd5beb11f2e22cdce73',
  },
  {
    input: { workspaceId: WORKSPACE, scope: 'firm', canonicalKey: '00000000-0000-4000-8000-0000000000f1', source: 'prospect_opt_out', commandId: 'mail:abc:firm' },
    id: 'sup_3b7dacf7f8eb22608c8ceb13b4845f385ef2ca9d55689d921d2b961ab8f78d5e',
  },
  {
    input: { workspaceId: WORKSPACE, scope: 'handle', canonicalKey: '+14015550123', source: 'admin_supersession', commandId: 'cmd-2', supersedesEventId: 'sup_x' },
    id: 'sup_c805bf14b5556cdab74d01349aae88cc6ec1bb980d38c81c5c770e961affbf10',
  },
] as const;

const record = (channel: SuppressionJournalRecord['channel']): SuppressionJournalRecord => ({
  eventId: 'sup_abc',
  workspaceId: WORKSPACE,
  scope: 'handle',
  canonicalKey: '+14015550123',
  canonicalizerVersion: 'e164-lower.1',
  source: 'prospect_do_not_call',
  actorUserId: null,
  commandId: 'cmd-1:handle',
  supersedesEventId: null,
  supersessionReason: null,
  recordedAt: '2026-10-02T12:00:00.000Z',
  channel,
});

describe('suppression journal ids after migration 0037', () => {
  it('keeps the pre-0037 id of an event with no channel or with all', () => {
    for (const golden of GOLDEN) {
      expect(deterministicEventId(golden.input)).toBe(golden.id);
      expect(deterministicEventId({ ...golden.input, channel: 'all' })).toBe(golden.id);
    }
  });

  it('gives a phone or an email event an id of its own', () => {
    const base = GOLDEN[0].input;
    const phone = deterministicEventId({ ...base, channel: 'phone' });
    const email = deterministicEventId({ ...base, channel: 'email' });
    expect(phone).not.toBe(GOLDEN[0].id);
    expect(email).not.toBe(GOLDEN[0].id);
    expect(phone).not.toBe(email);
    expect(phone).toMatch(/^sup_[0-9a-f]{64}$/u);
  });
});

describe('suppression journal bodies after migration 0037', () => {
  it('round-trips the channel through the body and the parser', () => {
    for (const channel of ['phone', 'email', 'all'] as const) {
      const parsed = parseSuppressionJournalRecord(journalObjectBody(record(channel)));
      expect(parsed).toEqual({ ok: true, value: record(channel) });
    }
  });

  it('parses a v1 body written before 0037, without channel, as all', () => {
    const { channel: _dropped, ...rest } = JSON.parse(journalObjectBody(record('phone'))) as Record<string, unknown>;
    expect(rest['schema']).toBe(SUPPRESSION_JOURNAL_SCHEMA);
    const parsed = parseSuppressionJournalRecord(JSON.stringify(rest));
    expect(parsed).toEqual({ ok: true, value: record('all') });
  });

  it('refuses a channel that is not one of the three', () => {
    const body = { ...(JSON.parse(journalObjectBody(record('all'))) as Record<string, unknown>), channel: 'sms' };
    expect(parseSuppressionJournalRecord(JSON.stringify(body))).toEqual({
      ok: false,
      reason: 'field_missing',
      detail: 'channel',
    });
    const nulled = { ...(JSON.parse(journalObjectBody(record('all'))) as Record<string, unknown>), channel: null };
    expect(parseSuppressionJournalRecord(JSON.stringify(nulled))).toMatchObject({ ok: false, detail: 'channel' });
  });
});
