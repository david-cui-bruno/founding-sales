import { describe, expect, it } from 'vitest';
import { boundMp3 } from '../../calls/mp3Bound.ts';
import { FIXTURE_FRAME_SECONDS, silentMp3 } from './mp3Fixture.ts';

/** The transcription's duration bound (slice C2, review fold 1, P1): audio cut at a frame to the priced minutes. */
describe('boundMp3', () => {
  it('keeps audio inside the bound whole', () => {
    const audio = silentMp3(60);
    const bounded = boundMp3(audio, 120);
    expect(bounded?.trimmed).toBe(false);
    expect(bounded?.bytes.byteLength).toBe(audio.byteLength);
    expect(bounded?.seconds).toBeCloseTo(60, 0);
  });

  it('cuts longer audio at the last whole frame inside the bound', () => {
    const bounded = boundMp3(silentMp3(300), 180);
    expect(bounded?.trimmed).toBe(true);
    expect(bounded?.seconds).toBeLessThanOrEqual(180);
    expect(bounded?.seconds).toBeGreaterThan(180 - FIXTURE_FRAME_SECONDS);
    expect((bounded?.bytes.byteLength ?? 0) % 72).toBe(0);
  });

  it('keeps a leading ID3v2 tag and stops at a trailing ID3v1 tag', () => {
    const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb]);
    const tail = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]);
    const bounded = boundMp3(Buffer.concat([tag, silentMp3(10), tail]), 60);
    expect(bounded?.seconds).toBeCloseTo(10, 0);
    expect(bounded?.bytes.subarray(0, 3).toString()).toBe('ID3');
  });

  it('refuses what is not Layer III audio, so nothing unbounded is uploaded', () => {
    expect(boundMp3(Buffer.from('not audio at all, just words'), 60)).toBeNull();
    expect(boundMp3(Buffer.alloc(0), 60)).toBeNull();
    // A frame cut short by the end of the file.
    expect(boundMp3(silentMp3(1).subarray(0, 100), 60)).toBeNull();
    // Layer I and a free-format bit rate are not read.
    expect(boundMp3(Buffer.from([0xff, 0xe7, 0x18, 0xc0, ...Buffer.alloc(68)]), 60)).toBeNull();
    expect(boundMp3(Buffer.from([0xff, 0xe3, 0x08, 0xc0, ...Buffer.alloc(68)]), 60)).toBeNull();
  });
});
