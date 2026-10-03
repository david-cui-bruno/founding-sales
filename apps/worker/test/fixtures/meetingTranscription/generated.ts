/** Generated PCM/WAV: no participant content and no downloaded fixtures. */
export function silentWave(seconds: number): Buffer {
  const samples = Math.round(seconds * 16000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
export const word = (content: string, start = '0.25', end = '0.75', speaker?: string) => ({
  type: 'pronunciation', start_time: start, end_time: end,
  alternatives: [{ content }], ...(speaker === undefined ? {} : { speaker_label: speaker }),
});
export const punctuation = (content: string) => ({ type: 'punctuation', alternatives: [{ content }] });
