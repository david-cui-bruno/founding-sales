import { createHash } from 'node:crypto';
import type { MeetingNotesRevision, MeetingUtterance, RecordingProcessingView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readMeetingOutcomes } from './outcomes.ts';
import { readMeetingTranscript, MeetingTranscriptChangedError } from './transcripts.ts';
import type { MeetingResult } from './outcomeTypes.ts';
export interface MeetingAnalysisInput {
  meetingId: string; firmId: string; sourceHash: string; transcriptRevision: number; startsAt: string; businessZone: string;
  notes: MeetingNotesRevision; utterances: MeetingUtterance[]; recordings: RecordingProcessingView[]; complete: boolean;
}
export interface MeetingAnalysisBlock { hash: string; purpose: 'extract'; sourceBytes: number; input: MeetingAnalysisInput }
export const MEETING_ANALYSIS_LIMITS = { blockBytes: 32768, blocks: 16, requestBytes: 1048576, inputTokens: 180000, extractOutput: 4096, mergeOutput: 8192 } as const;
export function analysisHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Paginate one source revision. A changing source gets two fresh reads, never a mixed snapshot. */
export async function assembleMeetingAnalysisInput(context: RepositoryContext, input: { meetingId: string }): Promise<MeetingResult<MeetingAnalysisInput>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await readMeetingOutcomes(context, input);
      if (before === null) return { ok: false, reason: 'meeting_unknown' };
      const meta = (await context.db.query<{ starts_at: Date; business_time_zone: string }>(
        'SELECT m.starts_at,w.business_time_zone FROM meetings m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.id=$2', [context.scope.workspaceId, input.meetingId])).rows[0];
      if (meta === undefined) return { ok: false, reason: 'meeting_unknown' };
      const utterances: MeetingUtterance[] = [], recordings = new Map<string, RecordingProcessingView>();
      let cursor: string | undefined, sourceBytes = 0, transcriptRevision = -1, complete = false;
      do {
        const page = await readMeetingTranscript(context, { meetingId: input.meetingId, ...(cursor === undefined ? {} : { cursor }) });
        if (page === null) return { ok: false, reason: 'meeting_unknown' };
        if (page.recordingsTruncated) return { ok: false, reason: 'input_too_large' };
        if (transcriptRevision !== -1 && transcriptRevision !== page.coverage.sourceRevision) throw new MeetingTranscriptChangedError();
        transcriptRevision = page.coverage.sourceRevision;
        complete = page.coverage.total > 0 && page.coverage.ready === page.coverage.total;
        for (const row of page.recordings) recordings.set(row.recordingId, row);
        for (const row of page.utterances) { sourceBytes += Buffer.byteLength(row.text); utterances.push(row); }
        if (sourceBytes + Buffer.byteLength(before.notes.debrief) > MEETING_ANALYSIS_LIMITS.blockBytes * MEETING_ANALYSIS_LIMITS.blocks) return { ok: false, reason: 'input_too_large' };
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const after = await readMeetingOutcomes(context, input);
      if (after === null || after.sourceHash !== before.sourceHash || after.firmId !== before.firmId) continue;
      if (utterances.length === 0 && before.notes.debrief.trim() === '') return { ok: false, reason: 'no_sources' };
      return { ok: true, value: { ...input, firmId: before.firmId, sourceHash: before.sourceHash, transcriptRevision, startsAt: meta.starts_at.toISOString(),
        businessZone: meta.business_time_zone, notes: before.notes, utterances, recordings: [...recordings.values()].sort((a, b) => a.recordingId.localeCompare(b.recordingId)),
        complete: complete || (recordings.size === 0 && before.notes.debrief.trim() !== '') } };
    } catch (error) { if (!(error instanceof MeetingTranscriptChangedError)) throw error; }
  }
  return { ok: false, reason: 'source_changed' };
}
export function buildMeetingAnalysisBlocks(input: MeetingAnalysisInput): MeetingResult<readonly MeetingAnalysisBlock[]> {
  const blocks: MeetingAnalysisBlock[] = [];
  const groups = new Map<string, MeetingUtterance[]>();
  for (const utterance of input.utterances) { const group = groups.get(utterance.recordingId) ?? []; group.push(utterance); groups.set(utterance.recordingId, group); }
  for (const [recordingId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const recordings = input.recordings.filter(r => r.recordingId === recordingId);
    if (recordings.length !== 1) return { ok: false, reason: 'source_invalid' };
    const mappings = input.notes.speakerMappings.filter(m => m.recordingId === recordingId).sort((a, b) => (a.speaker ?? '').localeCompare(b.speaker ?? ''));
    let batch: MeetingUtterance[] = [], bytes = 0;
    const flush = () => {
      if (batch.length === 0) return;
      // Snapshot counters/debrief corrections do not enter transcript cache identity.
      const hash = analysisHash({ startsAt: input.startsAt, businessZone: input.businessZone, utterances: batch, mappings, sourceKind: recordings[0]?.sourceKind });
      blocks.push({ hash, purpose: 'extract', sourceBytes: bytes, input: { ...input, utterances: batch, recordings,
        notes: { ...input.notes, revision: 0, debrief: '', savedAt: null, speakerMappings: mappings, itemOverrides: [] } } });
      batch = []; bytes = 0;
    };
    for (const utterance of group) {
      const size = Buffer.byteLength(utterance.text);
      if (size > MEETING_ANALYSIS_LIMITS.blockBytes) return { ok: false, reason: 'input_too_large' };
      if (bytes + size > MEETING_ANALYSIS_LIMITS.blockBytes) flush();
      batch.push(utterance); bytes += size;
    }
    flush();
  }
  if (input.notes.debrief.trim() !== '') {
    const bytes = Buffer.byteLength(input.notes.debrief);
    if (bytes > MEETING_ANALYSIS_LIMITS.blockBytes) return { ok: false, reason: 'input_too_large' };
    const notes = { ...input.notes, speakerMappings: [], itemOverrides: [] };
    blocks.push({ purpose: 'extract', hash: analysisHash({ notes, businessZone: input.businessZone }), sourceBytes: bytes,
      input: { ...input, notes, utterances: [], recordings: [] } });
  }
  if (blocks.length === 0) return { ok: false, reason: 'no_sources' };
  return blocks.length > MEETING_ANALYSIS_LIMITS.blocks ? { ok: false, reason: 'input_too_large' } : { ok: true, value: blocks };
}
