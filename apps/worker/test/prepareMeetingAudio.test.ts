import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { meetingMediaPreparer } from '../src/transcription/prepareMeetingAudio.ts';
import { silentWave } from './fixtures/meetingTranscription/generated.ts';

const recording = '00000000-0000-4000-8000-000000000001';
const preparedKey = `meetings-processing/${recording}/00000000-0000-4000-8000-000000000002.flac`;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(bytes = silentWave(3.25)) {
  const root = await mkdtemp(join(tmpdir(), 'meeting-test-')); dirs.push(root);
  const uploads: Buffer[] = [];
  const store = {
    async download() { return Readable.from([bytes]); },
    async upload(_key: string, path: string) { uploads.push(await readFile(path)); },
  };
  const input = { sourceKey: `meetings/${recording}/${digest(bytes)}.m4a`, expectedSha256: digest(bytes), expectedSizeBytes: bytes.length, preparedKey };
  return { root, store, uploads, input };
}
describe('bounded meeting audio', () => {
  it('duration_comes_from_decoded_samples including silence; the private directory is removed', async () => {
    const f = await fixture();
    const result = await meetingMediaPreparer({ store: f.store, tempRoot: f.root }).prepare(f.input, new AbortController().signal);
    expect(result.durationMs).toBe(3250);
    expect(result.sha256).toBe(digest(f.uploads[0]!));
    expect(result.sizeBytes).toBe(f.uploads[0]!.length);
    expect(f.uploads[0]!.subarray(0, 4).toString()).toBe('fLaC');
    expect(await readdir(f.root)).toEqual([]);
  });
  it('bounds_apply_during_streaming; a dishonest size does not permit a large download', async () => {
    const f = await fixture(); let reads = 0;
    f.store.download = async () => Readable.from((async function* () {
      for (let i = 0; i < 1000; i++) { reads++; yield Buffer.alloc(64); }
    })());
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root, maxBytes: 128 }).prepare({ ...f.input, expectedSizeBytes: 100 }, new AbortController().signal)).rejects.toThrow('source_size');
    expect(reads).toBeLessThan(1000); expect(f.uploads).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
  it('rejects mismatched digest before decoding or upload', async () => {
    const f = await fixture();
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root }).prepare({ ...f.input, expectedSha256: '0'.repeat(64) }, new AbortController().signal)).rejects.toThrow('source_checksum');
    expect(f.uploads).toEqual([]);
  });
  it('no_external_media_protocols', async () => {
    const f = await fixture(Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:1/private\n#EXT-X-ENDLIST\n'));
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root }).prepare(f.input, new AbortController().signal)).rejects.toThrow('invalid_media');
    expect(f.uploads).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
  it('long_audio_is_refused_not_trimmed (same duration boundary at a smaller test limit)', async () => {
    const f = await fixture(silentWave(2));
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root, maxDurationMs: 1000 }).prepare(f.input, new AbortController().signal)).rejects.toThrow('duration_limit');
    expect(f.uploads).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
  it('deadline_kills_child_and_cleans_temp', async () => {
    const f = await fixture(); const script = join(f.root, 'probe'); const pidPath = join(f.root, 'pid');
    await writeFile(script, `#!/bin/sh\necho $$ > '${pidPath}'\nexec sleep 30\n`, { mode: 0o700 });
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root, ffprobe: script, processTimeoutMs: 1500 }).prepare(f.input, new AbortController().signal)).rejects.toThrow('media_timeout');
    const pid = Number(await readFile(pidPath, 'utf8')); expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(f.root)).sort()).toEqual(['pid', 'probe']); expect(f.uploads).toEqual([]);
  });
  it('refuses oversized prepared output before upload', async () => {
    const f = await fixture(silentWave(0.01));
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root, maxBytes: 1000 }).prepare(f.input, new AbortController().signal)).rejects.toThrow('prepared_size');
    expect(f.uploads).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
  it('decodes generated M4A and refuses a container with video', async () => {
    const generated = await fixture(); const path = join(generated.root, 'audio.m4a');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.5', '-c:a', 'aac', path]);
    const f = await fixture(await readFile(path));
    const result = await meetingMediaPreparer({ store: f.store, tempRoot: f.root }).prepare(f.input, new AbortController().signal);
    expect(result.durationMs).toBeGreaterThanOrEqual(500); expect(result.durationMs).toBeLessThan(600);
    const videoPath = join(generated.root, 'video.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.5', '-c:v', 'mpeg4', '-c:a', 'aac', videoPath]);
    const v = await fixture(await readFile(videoPath));
    await expect(meetingMediaPreparer({ store: v.store, tempRoot: v.root }).prepare(v.input, new AbortController().signal)).rejects.toThrow('invalid_media');
    expect(v.uploads).toEqual([]);
  });
  it('aborted work cannot upload', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(meetingMediaPreparer({ store: f.store, tempRoot: f.root }).prepare(f.input, abort.signal)).rejects.toThrow();
    expect(f.uploads).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
});
