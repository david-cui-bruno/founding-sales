/**
 * Silent MPEG-2.5 Layer III audio of a given length, for the transcription tests (slice
 * C2): 8 kHz mono at 8 kbit/s, 72-byte frames of 576 samples (72 ms each). Real frame
 * headers with empty payloads — enough for `boundMp3` to walk, and never sent anywhere.
 */
export const FIXTURE_FRAME_SECONDS = 576 / 8_000;

export function silentMp3(seconds: number): Buffer {
  const frames = Math.max(1, Math.round(seconds / FIXTURE_FRAME_SECONDS));
  const frame = Buffer.alloc(72);
  // Sync, MPEG-2.5, Layer III, no CRC; 8 kbit/s, 8 000 Hz, no padding; mono.
  frame.set([0xff, 0xe3, 0x18, 0xc0]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
