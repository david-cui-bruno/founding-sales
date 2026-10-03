import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0041 adds (`meeting_recordings`, lane M4).
 * Each case breaks exactly one constraint, inside the transaction the caller rolls back. The
 * labels are invented file names; no real person.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

type Row = Readonly<Record<string, unknown>>;

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000040a1';
const SHA = 'a'.repeat(64);

/** A valid recording row for `meetingId`, with `overrides` on top. */
export async function recording(f: Fixture, meetingId: string, overrides: Row = {}): Promise<unknown> {
  const sha = typeof overrides['sha256'] === 'string' ? overrides['sha256'] : SHA;
  const all: Record<string, unknown> = {
    workspace_id: f.seeded.alpha.workspaceId,
    meeting_id: meetingId,
    segment: 1,
    participant_label: 'audioJordanPlaceholder21234567890.m4a',
    sha256: sha,
    size_bytes: 1024,
    s3_key: `meetings/${meetingId}/${sha}.m4a`,
    ...overrides,
  };
  const names = Object.keys(all);
  return await f.session.query(
    `INSERT INTO meeting_recordings (${names.join(', ')}) VALUES (${names.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    names.map(name => all[name]),
  );
}

export const MEETING_RECORDINGS_CONSTRAINT_CASES: readonly Case[] = [
  {
    constraint: 'meeting_recordings_pkey',
    run: async f => {
      const id = '00000000-0000-4000-8000-0000000040b1';
      const meetingId = await meeting(f);
      await recording(f, meetingId, { id });
      return await recording(f, meetingId, { id, sha256: 'b'.repeat(64) });
    },
  },
  {
    // One file, one row per meeting.
    constraint: 'meeting_recordings_once',
    run: async f => {
      const meetingId = await meeting(f);
      await recording(f, meetingId);
      return await recording(f, meetingId, { segment: 2 });
    },
  },
  { constraint: 'meeting_recordings_meeting_fkey', run: async f => await recording(f, ABSENT) },
  { constraint: 'meeting_recordings_segment_bounded', run: async f => await recording(f, await meeting(f), { segment: 0 }) },
  { constraint: 'meeting_recordings_label_bounded', run: async f => await recording(f, await meeting(f), { participant_label: 'audio\nname.m4a' }) },
  {
    constraint: 'meeting_recordings_sha256_shape',
    run: async f => {
      const meetingId = await meeting(f);
      return await recording(f, meetingId, { sha256: 'A'.repeat(64), s3_key: `meetings/${meetingId}/${'A'.repeat(64)}.m4a` });
    },
  },
  { constraint: 'meeting_recordings_size_bounded', run: async f => await recording(f, await meeting(f), { size_bytes: 300 * 1024 * 1024 + 1 }) },
  {
    // Another digest's object: a row can only name the bytes it records.
    constraint: 'meeting_recordings_key_shape',
    run: async f => await recording(f, await meeting(f), { s3_key: `meetings/${ABSENT}/${'b'.repeat(64)}.m4a` }),
  },
  { constraint: 'meeting_recordings_state_known', run: async f => await recording(f, await meeting(f), { state: 'queued' }) },
];
