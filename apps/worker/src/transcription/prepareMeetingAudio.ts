import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEETING_RECORDING_LIMITS, MEETING_TRANSCRIPTION_LIMITS } from '@fss/contracts';
import type { MeetingMediaPreparer } from '@fss/domain/meetings/transcriptionTypes.ts';
import { meetingInputKey, type MeetingProcessingStore } from './meetingAudioStore.ts';

export class MeetingMediaError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MeetingMediaError'; }
}
interface PreparationOptions {
  store: MeetingProcessingStore; tempRoot?: string; ffmpeg?: string; ffprobe?: string;
  /** Test bounds may only lower production limits. */
  maxBytes?: number; maxDurationMs?: number; processTimeoutMs?: number;
}
function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('invalid_media_limit');
  return value;
}
function counter(maximum: number, code: string) {
  let bytes = 0; const hash = createHash('sha256');
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximum) { callback(new MeetingMediaError(code)); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  return { stream, size: () => bytes, digest: () => hash.digest('hex') };
}
/** All child output except PCM/FLAC is bounded; stderr is discarded, never logged. */
function run(executable: string, args: string[], signal: AbortSignal, consume: (output: Readable) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const kill = () => { child.kill('SIGKILL'); };
  signal.addEventListener('abort', kill, { once: true });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new MeetingMediaError('media_tool_unavailable')));
    child.once('close', code => code === 0 ? resolve() : reject(new MeetingMediaError('invalid_media')));
  });
  return (async () => {
    const consuming = consume(child.stdout).catch(error => { kill(); throw error; });
    const results = await Promise.allSettled([consuming, closed]);
    signal.removeEventListener('abort', kill);
    if (signal.aborted) throw new MeetingMediaError('media_timeout');
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  })();
}
export function meetingMediaPreparer(options: PreparationOptions): MeetingMediaPreparer {
  const maxBytes = bounded(options.maxBytes, MEETING_RECORDING_LIMITS.maxFileBytes);
  const maxDurationMs = bounded(options.maxDurationMs, MEETING_TRANSCRIPTION_LIMITS.maxDurationMs);
  const processTimeout = bounded(options.processTimeoutMs, 120_000);
  return { async prepare(input, signal) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1 || input.expectedSizeBytes > maxBytes) throw new MeetingMediaError('source_size');
    if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256) || !meetingInputKey.test(input.preparedKey)) throw new MeetingMediaError('invalid_media_identity');
    const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'callie-meeting-'));
    const source = join(dir, 'source.m4a'), pcm = join(dir, 'decoded.pcm'), flac = join(dir, 'prepared.flac');
    try {
      const downloading = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      const sourceCounter = counter(Math.min(maxBytes, input.expectedSizeBytes), 'source_size');
      await pipeline(Readable.from(await options.store.download(input.sourceKey, downloading)), sourceCounter.stream, createWriteStream(source, { mode: 0o600 }), { signal: downloading });
      if (sourceCounter.size() !== input.expectedSizeBytes) throw new MeetingMediaError('source_size');
      if (sourceCounter.digest() !== input.expectedSha256) throw new MeetingMediaError('source_checksum');
      const processing = AbortSignal.any([signal, AbortSignal.timeout(processTimeout)]);
      const probeChunks: Buffer[] = []; let probeBytes = 0;
      await run(options.ffprobe ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,wav,flac,mp3', '-show_entries', 'stream=codec_type,channels', '-of', 'json', source], processing, async output => {
        for await (const chunk of output) { probeBytes += (chunk as Buffer).length; if (probeBytes > 65536) throw new MeetingMediaError('invalid_media'); probeChunks.push(chunk as Buffer); }
      });
      let probe: { streams?: { codec_type?: string; channels?: number }[] };
      try { probe = JSON.parse(Buffer.concat(probeChunks).toString('utf8')) as typeof probe; } catch { throw new MeetingMediaError('invalid_media'); }
      if (probe.streams?.length !== 1 || probe.streams[0]?.codec_type !== 'audio' || ![1, 2].includes(probe.streams[0].channels ?? 0)) throw new MeetingMediaError('invalid_media');
      // Two bytes/sample at 16kHz. Count every decoded sample, including silence.
      const decoded = counter(Math.floor(maxDurationMs * 32), 'duration_limit');
      await run(options.ffmpeg ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,wav,flac,mp3', '-threads', '1', '-i', source, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-threads', '1', '-f', 's16le', 'pipe:1'], processing,
        output => pipeline(output, decoded.stream, createWriteStream(pcm, { mode: 0o600 }), { signal: processing }));
      if (decoded.size() === 0 || decoded.size() % 2 !== 0) throw new MeetingMediaError('invalid_media');
      const durationMs = Math.ceil(decoded.size() / 32);
      const encoded = counter(maxBytes, 'prepared_size');
      await run(options.ffmpeg ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcm, '-threads', '1', '-c:a', 'flac', '-f', 'flac', 'pipe:1'], processing,
        output => pipeline(output, encoded.stream, createWriteStream(flac, { mode: 0o600 }), { signal: processing }));
      signal.throwIfAborted(); const sha256 = encoded.digest();
      await options.store.upload(input.preparedKey, flac, encoded.size(), sha256, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      return { inputKey: input.preparedKey, durationMs, sizeBytes: encoded.size(), sha256, mediaFormat: 'flac' };
    } catch (error) {
      if (error instanceof MeetingMediaError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new MeetingMediaError(name === 'NoSuchKey' || name === 'NotFound' ? 'source_missing' : signal.aborted ? 'media_aborted' : 'media_io_failed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  } };
}
