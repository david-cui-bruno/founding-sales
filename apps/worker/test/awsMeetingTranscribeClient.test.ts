import { PassThrough, Readable } from 'node:stream';
import { boundedBody } from '../src/transcription/meetingAudioStore.ts';
import { describe, expect, it } from 'vitest';
import { awsMeetingTranscription, parseAwsMeetingTranscript } from '../src/transcription/awsMeetingTranscribeClient.ts';
import type { AwsTranscribeSdk } from '../src/transcription/awsTranscribeClient.ts';
import { word, punctuation } from './fixtures/meetingTranscription/generated.ts';
const base = 'meetings-processing/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';
const input = { jobName: 'fss-test-meeting-one', inputKey: `${base}.flac`, outputKey: `${base}.json`, sourceKind: 'participant' as const };
function sdkWith(answer: (name: string, input: Record<string, unknown>) => unknown) {
  const sent: { name: string; input: Record<string, unknown> }[] = []; const configurations: unknown[] = [];
  const command = (name: string) => class { constructor(readonly input: Record<string, unknown>) {} readonly name = name; };
  class Client {
    constructor(config: unknown) { configurations.push(config); }
    async send(value: unknown) { const c = value as { name: string; input: Record<string, unknown> }; sent.push(c); return answer(c.name, c.input); }
  }
  const sdk: AwsTranscribeSdk = { S3Client: Client, TranscribeClient: Client, PutObjectCommand: command('put'), GetObjectCommand: command('get'), DeleteObjectCommand: command('delete'), StartTranscriptionJobCommand: command('start'), GetTranscriptionJobCommand: command('collect') };
  return { sdk, sent, configurations };
}
const options = { bucket: 'test-audio', region: 'us-east-1', jobPrefix: 'fss-test' };
describe('AWS meeting adapter', () => {
  it('uses FLAC, one SDK attempt, known output and provisional diarization only for mixed/unknown', async () => {
    const f = sdkWith(() => ({})); const provider = awsMeetingTranscription({ ...options, sdk: f.sdk });
    for (const sourceKind of ['participant', 'mixed', 'unknown'] as const) expect(await provider.start({ ...input, sourceKind })).toBe('started');
    expect(f.configurations).toEqual([{ region: 'us-east-1', maxAttempts: 1 }, { region: 'us-east-1', maxAttempts: 1 }]);
    expect(f.sent[0]!.input).toMatchObject({ MediaFormat: 'flac', LanguageCode: 'en-US', OutputBucketName: 'test-audio', OutputKey: input.outputKey });
    expect(f.sent[0]!.input['Settings']).toBeUndefined();
    expect(f.sent[1]!.input['Settings']).toEqual({ ShowSpeakerLabels: true, MaxSpeakerLabels: 30 });
    expect(f.sent[2]!.input['Settings']).toEqual(f.sent[1]!.input['Settings']);
  });
  it.each(['TimeoutError', 'ConflictException'])('a %s leaves the same job for collection, without a second Start', async name => {
    const f = sdkWith(() => { throw Object.assign(new Error('sensitive body'), { name }); });
    expect(await awsMeetingTranscription({ ...options, sdk: f.sdk }).start(input)).toBe('ambiguous'); expect(f.sent).toHaveLength(1);
  });
  it('refuses a definite provider rejection', async () => {
    const f = sdkWith(() => { throw Object.assign(new Error('private'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }); });
    expect(await awsMeetingTranscription({ ...options, sdk: f.sdk }).start(input)).toBe('refused');
  });
  it('collects only the persisted output key, never an arbitrary provider URL', async () => {
    const f = sdkWith(name => name === 'collect' ? { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED', Transcript: { TranscriptFileUri: 'https://attacker.invalid/' } } } : { Body: Readable.from([Buffer.from(JSON.stringify({ results: { items: [word('Hello'), punctuation('.')] } }))]) });
    const result = await awsMeetingTranscription({ ...options, sdk: f.sdk }).collect(input);
    expect(result).toMatchObject({ kind: 'complete', utterances: [{ text: 'Hello.', startMs: 250, endMs: 750 }] });
    expect(f.sent[1]!.input).toEqual({ Bucket: 'test-audio', Key: input.outputKey });
  });
  it('bounds provider output during streaming', async () => {
    let reads = 0;
    const f = sdkWith(name => name === 'collect' ? { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } } : { Body: Readable.from((async function* () { for (let i = 0; i < 40; i++) { reads++; yield Buffer.alloc(1024 * 1024); } })()) });
    expect(await awsMeetingTranscription({ ...options, sdk: f.sdk }).collect(input)).toEqual({ kind: 'failed', code: 'output_too_large' }); expect(reads).toBeLessThan(40);
  });
  it('aborts a stalled output stream and closes it', async () => {
    const body = new PassThrough(); const controller = new AbortController();
    const pending = boundedBody(body, 100, controller.signal);
    const check = expect(pending).rejects.toThrow(); controller.abort();
    await check; expect(body.destroyed).toBe(true);
  });
  it('rejects malformed timestamps, oversized speech, and keeps silence empty', () => {
    expect(parseAwsMeetingTranscript({ results: { items: [] } })).toEqual([]);
    expect(parseAwsMeetingTranscript({ results: { items: [punctuation('.')] } })).toEqual([]);
    for (const item of [word('oops', 'NaN'), word('oops', '3', '2'), word('oops', '0', '14401'), word('x'.repeat(4001))]) expect(parseAwsMeetingTranscript({ results: { items: [item] } })).toBeNull();
  });
  it('keeps repeated provisional labels per source, attaches punctuation, and supports diarization sections', () => {
    const body = { results: { items: [word('Yes'), punctuation(','), word('please', '0.8', '1.2'), word('Okay', '1.3', '1.9')], speaker_labels: { segments: [{ items: [{ start_time: '0.25', end_time: '0.75', speaker_label: 'spk_0' }, { start_time: '0.8', end_time: '1.2', speaker_label: 'spk_0' }, { start_time: '1.3', end_time: '1.9', speaker_label: 'spk_1' }] }] } } };
    expect(parseAwsMeetingTranscript(body)).toEqual([{ startMs: 250, endMs: 1200, text: 'Yes, please', speaker: 'spk_0', attribution: 'provider_label' }, { startMs: 1300, endMs: 1900, text: 'Okay', speaker: 'spk_1', attribution: 'provider_label' }]);
  });
});
