import { describe, expect, it } from 'vitest';
import type { RecordingCandidate } from '@fss/contracts';
import { attendeeWords, corroboration, decideMatch, overlappingMeetings } from '../src/main/recordings/matcher.ts';
import {
  STABLE_AFTER_MS,
  audioFilesOf,
  parseFolderName,
  readinessOf,
  roleOf,
  segmentsOf,
  signatureOf,
  type FolderFile,
} from '../src/main/recordings/zoomFolder.ts';

/**
 * Contract check CC2 (lane M4): the folder-to-meeting matcher on synthetic folder names and
 * meetings — one candidate, two candidates, none (the folder is outside), and a class
 * recording at a time no meeting was (outside: never listed, never read; the importer's tests
 * hold the "never read"). Every name, person and firm is invented.
 */

const local = (year: number, month: number, day: number, hour: number, minute: number): Date => new Date(year, month - 1, day, hour, minute, 0);

function meeting(id: string, starts: Date, overrides: Partial<RecordingCandidate> = {}): RecordingCandidate {
  return {
    meetingId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    startsAt: starts.toISOString(),
    endsAt: new Date(starts.getTime() + 20 * 60 * 1000).toISOString(),
    firmId: '11111111-1111-4111-8111-111111111111',
    firmName: 'Example Rentals',
    attendeeName: 'Jordan Placeholder',
    attendeeEmail: 'jordan.placeholder@example.test',
    ...overrides,
  };
}

const DEMO = local(2026, 10, 5, 14, 0);

describe('CC2: matching a folder to a Callie meeting', () => {
  it('one candidate near the start, corroborated by the topic: matched', () => {
    const folder = parseFolderName('2026-10-05 14.02.11 Callie demo between David Cui and Jordan Placeholder 81234567890');
    expect(folder?.topic).toBe('Callie demo between David Cui and Jordan Placeholder');
    expect(folder?.startedAt.getTime()).toBe(local(2026, 10, 5, 14, 2).getTime() + 11_000);
    const decision = decideMatch({ startedAt: folder!.startedAt, topic: folder!.topic, participantLabels: [] }, [meeting('1', DEMO)]);
    expect(decision).toMatchObject({ kind: 'matched', meetingId: meeting('1', DEMO).meetingId, by: 'topic' });
  });

  it('one candidate, corroborated only by a participant file name: matched', () => {
    const decision = decideMatch(
      { startedAt: local(2026, 10, 5, 13, 58), topic: 'Zoom Meeting', participantLabels: ['audioDavidCui11234567890.m4a', 'audioJordanPlaceholder21234567890.m4a'] },
      [meeting('1', DEMO)],
    );
    expect(decision).toMatchObject({ kind: 'matched', by: 'participant' });
  });

  it('one candidate with nothing corroborating it: needs matching, never a guess', () => {
    const decision = decideMatch({ startedAt: local(2026, 10, 5, 14, 1), topic: 'Zoom Meeting', participantLabels: ['audioDavidCui11234567890.m4a'] }, [
      meeting('1', DEMO),
    ]);
    expect(decision).toMatchObject({ kind: 'needs_matching', why: 'not_corroborated' });
    if (decision.kind === 'needs_matching') expect(decision.candidates.map(entry => entry.meetingId)).toEqual([meeting('1', DEMO).meetingId]);
  });

  it('two candidates near the start: needs matching, both offered, even when one is corroborated', () => {
    const other = meeting('2', local(2026, 10, 5, 14, 20), { attendeeName: 'Riley Example', attendeeEmail: 'riley@example.test' });
    const decision = decideMatch(
      { startedAt: local(2026, 10, 5, 14, 5), topic: 'Callie demo between David Cui and Jordan Placeholder', participantLabels: [] },
      [meeting('1', DEMO), other],
    );
    expect(decision).toMatchObject({ kind: 'needs_matching', why: 'several_meetings' });
    if (decision.kind === 'needs_matching') expect(decision.candidates).toHaveLength(2);
  });

  it('a folder inside a meeting window but far from its start: needs matching', () => {
    const long = meeting('3', DEMO, { endsAt: new Date(DEMO.getTime() + 90 * 60 * 1000).toISOString() });
    const decision = decideMatch({ startedAt: local(2026, 10, 5, 15, 0), topic: 'Jordan Placeholder', participantLabels: [] }, [long]);
    expect(decision).toMatchObject({ kind: 'needs_matching', why: 'no_meeting_near_start' });
  });

  it('no meeting at all: outside', () => {
    expect(decideMatch({ startedAt: DEMO, topic: 'Callie demo', participantLabels: [] }, [])).toEqual({ kind: 'outside' });
  });

  it('a class recording on the demo day at another time: outside, decided from its name alone', () => {
    const name = '2026-10-05 18.30.00 Organic Chemistry Lecture 91234567890';
    const parsed = parseFolderName(name);
    expect(parsed).not.toBeNull();
    // The overlap step needs only the start time: nothing inside the folder is consulted.
    expect(overlappingMeetings(parsed!.startedAt, [meeting('1', DEMO)])).toEqual([]);
    expect(decideMatch({ startedAt: parsed!.startedAt, topic: parsed!.topic, participantLabels: [] }, [meeting('1', DEMO)])).toEqual({ kind: 'outside' });
  });

  it('the overlap window is the meeting widened by 30 minutes each side', () => {
    const one = [meeting('1', DEMO)];
    expect(overlappingMeetings(local(2026, 10, 5, 13, 30), one)).toHaveLength(1);
    expect(overlappingMeetings(local(2026, 10, 5, 13, 29), one)).toHaveLength(0);
    expect(overlappingMeetings(local(2026, 10, 5, 14, 50), one)).toHaveLength(1);
    expect(overlappingMeetings(local(2026, 10, 5, 14, 51), one)).toHaveLength(0);
  });

  it('the attendee’s name: the contact’s, else the address’s words; a partial name does not corroborate', () => {
    expect(attendeeWords({ attendeeName: 'Jördan  Placeholder', attendeeEmail: null })).toEqual(['jordan', 'placeholder']);
    expect(attendeeWords({ attendeeName: 'jordan.placeholder@example.test', attendeeEmail: null })).toEqual(['jordan', 'placeholder']);
    expect(attendeeWords({ attendeeName: null, attendeeEmail: 'riley_example@example.test' })).toEqual(['riley', 'example']);
    expect(attendeeWords({ attendeeName: null, attendeeEmail: null })).toEqual([]);
    expect(corroboration({ attendeeName: 'Jordan Placeholder', attendeeEmail: null }, { topic: 'Meeting with Jordan', participantLabels: [] })).toBeNull();
    expect(corroboration({ attendeeName: null, attendeeEmail: null }, { topic: 'anything', participantLabels: ['audioX1.m4a'] })).toBeNull();
  });
});

describe('the Zoom folder tables (assumptions A1–A6, until a real listing confirms them)', () => {
  it('parses Zoom’s folder name, with and without a meeting number, and refuses anything else', () => {
    expect(parseFolderName('2026-10-05 14.02.11 Zoom Meeting')).toMatchObject({ topic: 'Zoom Meeting' });
    expect(parseFolderName('2026-10-05 14.02.11')).toMatchObject({ topic: null });
    expect(parseFolderName('2026-02-31 14.02.11 Bad day')).toBeNull();
    expect(parseFolderName('Callie demo')).toBeNull();
    expect(parseFolderName('2026-10-05 14:02:11 Colons')).toBeNull();
  });

  it('classifies files by the table: .zoom pending, video never audio, per-participant only under Audio Record', () => {
    expect(roleOf('double_click_to_convert_01.zoom', 'folder')).toBe('pending_conversion');
    expect(roleOf('video1234567890.mp4', 'folder')).toBe('video');
    expect(roleOf('audio1234567890.m4a', 'folder')).toBe('mixed_audio');
    expect(roleOf('audioJordanPlaceholder21234567890.m4a', 'participants')).toBe('participant_audio');
    expect(roleOf('notes.m4a', 'folder')).toBe('other');
    expect(roleOf('playback.m3u', 'folder')).toBe('other');
    expect(roleOf('.DS_Store', 'folder')).toBe('other');
    expect(roleOf('audio1.m4a.part', 'folder')).toBe('temporary');
  });

  const file = (relPath: string, role: FolderFile['role'], size = 1000, birth = 1): FolderFile => ({
    relPath,
    name: relPath.split('/').at(-1) ?? relPath,
    role,
    sizeBytes: size,
    ino: relPath.length,
    mtimeMs: 10,
    birthtimeMs: birth,
  });

  it('uploads per-participant files when there are any, the mixed audio otherwise, and numbers each participant’s segments', () => {
    const files = [
      file('audio1.m4a', 'mixed_audio'),
      file('video1.mp4', 'video'),
      file('Audio Record/audioDavidCui11.m4a', 'participant_audio', 1000, 1),
      file('Audio Record/audioDavidCui12.m4a', 'participant_audio', 1000, 2),
      file('Audio Record/audioJordanPlaceholder21.m4a', 'participant_audio', 1000, 1),
    ];
    expect(audioFilesOf(files).map(entry => entry.relPath)).toEqual([
      'Audio Record/audioDavidCui11.m4a',
      'Audio Record/audioDavidCui12.m4a',
      'Audio Record/audioJordanPlaceholder21.m4a',
    ]);
    const segments = segmentsOf(audioFilesOf(files));
    expect(segments.get('Audio Record/audioDavidCui11.m4a')).toBe(1);
    expect(segments.get('Audio Record/audioDavidCui12.m4a')).toBe(2);
    expect(segments.get('Audio Record/audioJordanPlaceholder21.m4a')).toBe(1);
    expect(audioFilesOf([files[0]!, files[1]!]).map(entry => entry.relPath)).toEqual(['audio1.m4a']);
  });

  it('is ready only when converted, with audio, and unchanged across two scans far enough apart', () => {
    const converting = [file('double_click_to_convert_01.zoom', 'pending_conversion')];
    expect(readinessOf(converting, null, 0)).toEqual({ ready: false, why: 'converting' });
    const done = [file('audio1.m4a', 'mixed_audio'), file('video1.mp4', 'video')];
    expect(readinessOf(done, null, 0)).toEqual({ ready: false, why: 'writing' });
    const previous = { signature: signatureOf(done), atMs: 0 };
    expect(readinessOf(done, previous, STABLE_AFTER_MS - 1)).toEqual({ ready: false, why: 'writing' });
    expect(readinessOf(done, previous, STABLE_AFTER_MS)).toMatchObject({ ready: true });
    const grew = [file('audio1.m4a', 'mixed_audio', 2000), file('video1.mp4', 'video')];
    expect(readinessOf(grew, previous, STABLE_AFTER_MS)).toEqual({ ready: false, why: 'writing' });
    const videoOnly = [file('video1.mp4', 'video')];
    expect(readinessOf(videoOnly, { signature: signatureOf(videoOnly), atMs: 0 }, STABLE_AFTER_MS)).toEqual({ ready: false, why: 'no_audio' });
  });
});
