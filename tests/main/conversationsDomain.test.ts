import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner } from '../../src/main/db/migrate';
import { migration0001Foundation } from '../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../src/main/db/migrations/0003Transcripts';
import {
  attachTranscript,
  ConversationsDomainError,
  getConversationDetail,
  listConversations,
  type ConversationsDomainDeps,
} from '../../src/main/domain/conversations/conversationsDomain';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  insertPerson,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

const migrateThroughTranscripts = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
]);

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('conversations domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let deps: ConversationsDomainDeps;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateThroughTranscripts(database, {
      backupDirectory: `${temp.path}.backups`,
      workspaceKey: key,
    });
    deps = {
      database,
      clock: { now: () => CLOCK_NOW },
      ids: new SequentialIds(),
    };
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function insertActivity(input: {
    id: string;
    personId: string;
    kind?: string;
    direction?: string;
    occurredAt?: string;
    durationSeconds?: number | null;
    salesCycleId?: string | null;
    summary?: string | null;
    seedPerson?: boolean;
  }): void {
    if (input.seedPerson !== false) {
      insertPerson(database.raw, input.personId);
    }
    const kind = input.kind ?? 'call';
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, sales_cycle_id, kind, direction, channel, occurred_at,
        duration_seconds, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.personId,
      input.salesCycleId ?? null,
      kind,
      input.direction ?? 'outbound',
      kind === 'call' || kind === 'voicemail' ? 'phone' : kind,
      input.occurredAt ?? DOMAIN_TIMESTAMP,
      input.durationSeconds ?? null,
      JSON.stringify(
        input.summary === undefined || input.summary === null
          ? { formatVersion: 1 }
          : { formatVersion: 1, summary: input.summary },
      ),
      DOMAIN_TIMESTAMP,
    );
  }

  function insertRecordedActivity(input: { id: string; personId: string }): void {
    insertPerson(database.raw, input.personId);
    const consentId = `${input.id}-consent`;
    database.raw.prepare(`
      INSERT INTO consent_policy_records (
        id, person_id, policy_kind, policy_version, effective_at, decision,
        evidence_json, created_at
      ) VALUES (?, ?, 'recording', 'seed-v1', ?, 'granted', '{}', ?)
    `).run(consentId, input.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at,
        consent_policy_record_id, recording_storage_ref, metadata_json, created_at
      ) VALUES (?, ?, 'call', 'outbound', 'phone', ?, ?, 'file:recordings/seed', '{}', ?)
    `).run(input.id, input.personId, DOMAIN_TIMESTAMP, consentId, DOMAIN_TIMESTAMP);
  }

  const listAll = () => listConversations(deps, {
    query: '', filter: 'all', limit: 50, cursor: null,
  });

  describe('listConversations', () => {
    it('lists call and voicemail activities newest first, excluding other kinds', () => {
      insertActivity({
        id: 'activity-old', personId: 'person-1',
        occurredAt: '2026-08-29T10:00:00.000Z', summary: 'Older call.',
      });
      insertActivity({
        id: 'activity-new', personId: 'person-1', kind: 'voicemail',
        direction: 'inbound', occurredAt: '2026-08-30T10:00:00.000Z',
        seedPerson: false,
      });
      insertActivity({
        id: 'activity-note', personId: 'person-1', kind: 'note',
        direction: 'internal', seedPerson: false,
      });
      insertActivity({
        id: 'activity-text', personId: 'person-1', kind: 'text',
        seedPerson: false,
      });

      const page = listAll();

      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.activityId))
        .toEqual(['activity-new', 'activity-old']);
      expect(page.rows[0]).toMatchObject({
        personId: 'person-1',
        personName: 'Person person-1',
        kind: 'voicemail',
        direction: 'inbound',
        recordingAvailable: false,
        transcriptAvailable: false,
        summary: null,
      });
      expect(page.rows[1]).toMatchObject({
        kind: 'call',
        summary: 'Older call.',
      });
    });

    it('includes the sales cycle and duration when present', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      const { cycleId } = insertOpenCycleWithAction({
        database: database.raw, prefix: 'alpha', prospect,
      });
      insertActivity({
        id: 'activity-1', personId: prospect.personId, salesCycleId: cycleId,
        durationSeconds: 480, seedPerson: false,
      });

      expect(listAll().rows[0]).toMatchObject({
        salesCycleId: cycleId,
        durationSeconds: 480,
      });
    });

    it('searches person names with LIKE escaping', () => {
      insertActivity({ id: 'activity-1', personId: 'al_pha' });
      insertActivity({ id: 'activity-2', personId: 'alpha' });

      const escaped = listConversations(deps, {
        query: 'al_', filter: 'all', limit: 50, cursor: null,
      });

      expect(escaped.total).toBe(1);
      expect(escaped.rows[0]!.personId).toBe('al_pha');
    });

    it('maps the transcript and recording filters onto storage refs', () => {
      insertActivity({ id: 'activity-plain', personId: 'person-1' });
      insertRecordedActivity({ id: 'activity-recorded', personId: 'person-2' });
      insertActivity({ id: 'activity-transcribed', personId: 'person-3' });
      attachTranscript(deps, {
        activityId: 'activity-transcribed', personId: 'person-3', rawText: 'me: hello',
      });

      const withTranscript = listConversations(deps, {
        query: '', filter: 'with_transcript', limit: 50, cursor: null,
      });
      const withoutTranscript = listConversations(deps, {
        query: '', filter: 'without_transcript', limit: 50, cursor: null,
      });
      const withRecording = listConversations(deps, {
        query: '', filter: 'with_recording', limit: 50, cursor: null,
      });

      expect(withTranscript.rows.map((row) => row.activityId))
        .toEqual(['activity-transcribed']);
      expect(withTranscript.rows[0]!.transcriptAvailable).toBe(true);
      expect(withoutTranscript.rows.map((row) => row.activityId).sort())
        .toEqual(['activity-plain', 'activity-recorded']);
      expect(withRecording.rows.map((row) => row.activityId))
        .toEqual(['activity-recorded']);
      expect(withRecording.rows[0]!.recordingAvailable).toBe(true);
    });

    it('paginates with a stable offset cursor', () => {
      insertActivity({
        id: 'activity-1', personId: 'person-1', occurredAt: '2026-08-30T10:00:00.000Z',
      });
      insertActivity({
        id: 'activity-2', personId: 'person-2', occurredAt: '2026-08-29T10:00:00.000Z',
      });

      const first = listConversations(deps, {
        query: '', filter: 'all', limit: 1, cursor: null,
      });
      expect(first.rows.map((row) => row.activityId)).toEqual(['activity-1']);
      expect(first.total).toBe(2);
      expect(first.nextCursor).not.toBeNull();

      const second = listConversations(deps, {
        query: '', filter: 'all', limit: 1, cursor: first.nextCursor,
      });
      expect(second.rows.map((row) => row.activityId)).toEqual(['activity-2']);
      expect(second.nextCursor).toBeNull();
    });

    it('rejects an invalid cursor', () => {
      expect(() => listConversations(deps, {
        query: '', filter: 'all', limit: 50, cursor: 'not-a-number',
      })).toThrow(ConversationsDomainError);
    });
  });

  describe('getConversationDetail', () => {
    it('returns a row without transcript when none is attached', () => {
      insertActivity({ id: 'activity-1', personId: 'person-1', summary: 'Quick call.' });

      const detail = getConversationDetail(deps, { activityId: 'activity-1' });

      expect(detail).toMatchObject({
        activityId: 'activity-1',
        personId: 'person-1',
        summary: 'Quick call.',
        transcriptAvailable: false,
        transcript: null,
      });
    });

    it('throws ACTIVITY_NOT_FOUND for unknown ids', () => {
      expect(() => getConversationDetail(deps, { activityId: 'missing' }))
        .toThrow(ConversationsDomainError);
      try {
        getConversationDetail(deps, { activityId: 'missing' });
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('ACTIVITY_NOT_FOUND');
      }
    });

    it('throws ACTIVITY_NOT_FOUND for non-conversation activities', () => {
      insertActivity({
        id: 'activity-note', personId: 'person-1', kind: 'note', direction: 'internal',
      });

      expect(() => getConversationDetail(deps, { activityId: 'activity-note' }))
        .toThrow(/conversation/);
    });
  });

  describe('attachTranscript', () => {
    it('parses speakers, persists the transcript, and returns a receipt', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      const { cycleId } = insertOpenCycleWithAction({
        database: database.raw, prefix: 'alpha', prospect,
      });
      insertActivity({
        id: 'activity-1', personId: prospect.personId, salesCycleId: cycleId,
        seedPerson: false,
      });

      const receipt = attachTranscript(deps, {
        activityId: 'activity-1',
        personId: prospect.personId,
        rawText: [
          'me: Thanks for taking the call.',
          '',
          'FOUNDER: How are showings going?',
          'Kevin: We keep losing weekends.',
          '  [crosstalk]  ',
          `${'x'.repeat(41)}: colon comes too late`,
        ].join('\n'),
      });

      expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
      expect(receipt.affectedSalesCycleIds).toEqual([cycleId]);
      expect(receipt.revision).toBeGreaterThan(0);

      const detail = getConversationDetail(deps, { activityId: 'activity-1' });
      expect(detail.transcriptAvailable).toBe(true);
      expect(detail.transcript).not.toBeNull();
      expect(detail.transcript!.source).toBe('manual_paste');
      expect(detail.transcript!.createdAt).toBe(CLOCK_NOW);
      expect(detail.transcript!.utterances.map(({ speaker, text }) => ({ speaker, text })))
        .toEqual([
          { speaker: 'founder', text: 'Thanks for taking the call.' },
          { speaker: 'founder', text: 'How are showings going?' },
          { speaker: 'lead', text: 'We keep losing weekends.' },
          { speaker: 'unknown', text: '[crosstalk]' },
          { speaker: 'unknown', text: `${'x'.repeat(41)}: colon comes too late` },
        ]);
      expect(detail.transcript!.utterances.map(({ sequence }) => sequence))
        .toEqual([0, 1, 2, 3, 4]);
    });

    it('writes the consent record and activity refs in the same transaction', () => {
      insertActivity({ id: 'activity-1', personId: 'person-1' });

      attachTranscript(deps, {
        activityId: 'activity-1', personId: 'person-1', rawText: 'me: hello',
      });

      const activity = database.raw.prepare<[], {
        transcript_storage_ref: string; consent_policy_record_id: string;
      }>(`
        SELECT transcript_storage_ref, consent_policy_record_id
        FROM activities WHERE id = 'activity-1'
      `).get()!;
      expect(activity.transcript_storage_ref).toMatch(/^db:transcripts\//);

      const transcriptId = activity.transcript_storage_ref.replace('db:transcripts/', '');
      const transcript = database.raw.prepare<[string], {
        activity_id: string; person_id: string; source: string;
        format_version: number; raw_text: string; created_at: string;
      }>('SELECT * FROM transcripts WHERE id = ?').get(transcriptId)!;
      expect(transcript).toMatchObject({
        activity_id: 'activity-1',
        person_id: 'person-1',
        source: 'manual_paste',
        format_version: 1,
        raw_text: 'me: hello',
        created_at: CLOCK_NOW,
      });

      const consent = database.raw.prepare<[string], {
        person_id: string; activity_id: string; policy_kind: string;
        policy_version: string; decision: string; evidence_json: string;
        effective_at: string;
      }>('SELECT * FROM consent_policy_records WHERE id = ?')
        .get(activity.consent_policy_record_id)!;
      expect(consent).toMatchObject({
        person_id: 'person-1',
        activity_id: 'activity-1',
        policy_kind: 'recording',
        policy_version: 'manual-attach-v1',
        decision: 'granted',
        effective_at: CLOCK_NOW,
      });
      expect(JSON.parse(consent.evidence_json)).toEqual({ kind: 'founder_manual_attach' });
    });

    it('rejects a missing activity with ACTIVITY_NOT_FOUND', () => {
      try {
        attachTranscript(deps, {
          activityId: 'missing', personId: 'person-1', rawText: 'me: hello',
        });
        expect.unreachable('attachTranscript should have thrown');
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('ACTIVITY_NOT_FOUND');
      }
    });

    it('rejects a person mismatch with ACTIVITY_NOT_FOUND', () => {
      insertActivity({ id: 'activity-1', personId: 'person-1' });
      insertPerson(database.raw, 'person-2');

      try {
        attachTranscript(deps, {
          activityId: 'activity-1', personId: 'person-2', rawText: 'me: hello',
        });
        expect.unreachable('attachTranscript should have thrown');
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('ACTIVITY_NOT_FOUND');
      }
    });

    it('rejects non-conversation activities with ACTIVITY_NOT_FOUND', () => {
      insertActivity({
        id: 'activity-note', personId: 'person-1', kind: 'note', direction: 'internal',
      });

      try {
        attachTranscript(deps, {
          activityId: 'activity-note', personId: 'person-1', rawText: 'me: hello',
        });
        expect.unreachable('attachTranscript should have thrown');
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('ACTIVITY_NOT_FOUND');
      }
    });

    it('rejects a second transcript with TRANSCRIPT_ALREADY_ATTACHED', () => {
      insertActivity({ id: 'activity-1', personId: 'person-1' });
      attachTranscript(deps, {
        activityId: 'activity-1', personId: 'person-1', rawText: 'me: hello',
      });

      try {
        attachTranscript(deps, {
          activityId: 'activity-1', personId: 'person-1', rawText: 'me: again',
        });
        expect.unreachable('attachTranscript should have thrown');
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('TRANSCRIPT_ALREADY_ATTACHED');
      }
    });

    it('rejects whitespace-only text with TRANSCRIPT_EMPTY and stores nothing', () => {
      insertActivity({ id: 'activity-1', personId: 'person-1' });

      try {
        attachTranscript(deps, {
          activityId: 'activity-1', personId: 'person-1', rawText: '  \n\n  \nme:   \n',
        });
        expect.unreachable('attachTranscript should have thrown');
      } catch (error) {
        expect((error as ConversationsDomainError).code).toBe('TRANSCRIPT_EMPTY');
      }

      expect(database.raw.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM transcripts',
      ).get()).toEqual({ count: 0 });
      expect(database.raw.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM consent_policy_records',
      ).get()).toEqual({ count: 0 });
      expect(getConversationDetail(deps, { activityId: 'activity-1' }).transcriptAvailable)
        .toBe(false);
    });
  });
});
