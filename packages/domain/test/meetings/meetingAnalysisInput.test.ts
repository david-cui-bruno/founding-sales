import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingOutcomesFixture } from './support/meetingOutcomesFixture.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { sampleInput } from './fixtures/outcomes/sample.ts';
describe('complete meeting inputs', () => {
  let f: Awaited<ReturnType<typeof meetingOutcomesFixture>>;
  beforeAll(async () => { f = await meetingOutcomesFixture(); });
  afterAll(async () => { await f.db.drop(); });
  it('reads beyond 200 utterances and retries a changed source revision', async () => {
    const { assembleMeetingAnalysisInput } = await import('../../meetings/analysisInput.ts');
    const meetingId = await f.meeting(), recordingId = await f.recording(meetingId);
    await f.transcript(recordingId, 401);
    let changed = false;
    const context = repositoryContext(f.context.scope, { query: async (sql, values) => {
      const result = await f.db.session.query(sql, values);
      if (!changed && sql.includes('LIMIT 201 OFFSET')) {
        changed = true;
        await f.db.session.query('UPDATE meetings SET transcript_source_revision=transcript_source_revision+1 WHERE id=$1', [meetingId]);
      }
      return result;
    } } as typeof f.context.db);
    const result = await assembleMeetingAnalysisInput(context, { meetingId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.utterances).toHaveLength(401);
    expect(result.value.transcriptRevision).toBe(2); // registration incremented once, edit once
    expect(result.value.utterances.at(-1)?.text).toBe('Statement 400');
  });
  it('keeps all two-hour speech, stable block hashes, and holds oversized inputs', async () => {
    const { buildMeetingAnalysisBlocks } = await import('../../meetings/analysisInput.ts');
    const input = sampleInput(), first = input.utterances[0];
    if (first === undefined) throw new Error('fixture');
    input.utterances = Array.from({ length: 1000 }, (_, i) => ({ ...first, id: `${first.transcriptId}:${String(i + 1)}`, startMs: i * 7200, endMs: i * 7200 + 1000, text: `Statement ${String(i)}: ${'maintenance discussion '.repeat(4)}` }));
    const result = buildMeetingAnalysisBlocks(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flatMap(b => b.input.utterances)).toHaveLength(1000);
    expect(result.value.every(b => b.sourceBytes <= 32768)).toBe(true);
    const changed = buildMeetingAnalysisBlocks({ ...input, notes: { ...input.notes, revision: 2, debrief: 'Extra context', savedAt: '2026-10-03T16:00:00Z' } });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value.filter(b => b.input.utterances.length > 0).map(b => b.hash)).toEqual(result.value.map(b => b.hash));
    const oversized = buildMeetingAnalysisBlocks({ ...input, utterances: Array.from({ length: 200 }, (_, i) => ({ ...first, id: `${first.transcriptId}:${String(i + 1)}`, text: 'x'.repeat(4000) })) });
    expect(oversized).toMatchObject({ ok: false, reason: 'input_too_large' });
  });
});
