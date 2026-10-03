import { MEETING_TRANSCRIPTION_LIMITS as limits, meetingSpeechSchema, type MeetingSpeech } from '@fss/contracts';
import type { MeetingTranscriptionProvider } from '@fss/domain/meetings/transcriptionTypes.ts';
import { AWS_REQUEST_TIMEOUT_MS, loadAwsTranscribeSdk, type AwsTranscribeOptions } from './awsTranscribeClient.ts';
import { boundedBody, meetingInputKey, meetingOutputKey } from './meetingAudioStore.ts';

const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const seconds = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed <= 14400 ? Math.round(parsed * 1000) : null;
};
const speaker = (value: unknown): string | null => typeof value === 'string' && /^spk_(?:[0-9]|[12][0-9])$/u.test(value) ? value : null;
/**
 * AWS items plus optional diarization; labels are provisional and local to this file.
 * https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html (checked 3 Oct 2026).
 * The domain assigns participant source-label provenance from persisted metadata.
 */
export function parseAwsMeetingTranscript(body: unknown): MeetingSpeech[] | null {
  const results = record(record(body)?.['results']); const items = results?.['items'];
  if (!Array.isArray(items) || items.length > 200_000) return null;
  const labels = new Map<string, string>();
  const segments = record(results?.['speaker_labels'])?.['segments'];
  if (Array.isArray(segments)) {
    for (const value of segments) {
      const segment = record(value);
      if (!Array.isArray(segment?.['items'])) return null;
      for (const raw of segment['items']) {
        const item = record(raw); const label = speaker(item?.['speaker_label'] ?? segment['speaker_label']);
        const start = seconds(item?.['start_time']), end = seconds(item?.['end_time']);
        if (label === null || start === null || end === null || end < start) return null;
        const key = `${start}:${end}`; if (labels.has(key) && labels.get(key) !== label) return null;
        labels.set(key, label);
      }
    }
  }
  const utterances: MeetingSpeech[] = []; let previousStart = -1;
  for (const raw of items) {
    const item = record(raw); const alternatives = item?.['alternatives'];
    const text = Array.isArray(alternatives) ? record(alternatives[0])?.['content'] : undefined;
    if (typeof text !== 'string' || text.length === 0 || text.length > 4000) return null;
    const last = utterances.at(-1);
    if (item?.['type'] === 'punctuation') {
      // Punctuation carries no timing: attach it only to an actual preceding utterance.
      if (last !== undefined) { last.text += text; if (last.text.length > 4000) return null; }
      continue;
    }
    if (item?.['type'] !== 'pronunciation') return null;
    const startMs = seconds(item['start_time']), endMs = seconds(item['end_time']);
    if (startMs === null || endMs === null || endMs < startMs || startMs < previousStart) return null;
    previousStart = startMs;
    const label = speaker(item['speaker_label']) ?? labels.get(`${startMs}:${endMs}`) ?? null;
    if (last !== undefined && last.speaker === label && startMs - last.endMs <= 1000 && last.text.length + text.length + 1 <= 3900) {
      last.text += ` ${text}`; last.endMs = Math.max(last.endMs, endMs);
    } else utterances.push({ startMs, endMs, text, speaker: label, attribution: label === null ? 'unknown' : 'provider_label' });
    if (utterances.length > limits.maxUtterances) return null;
  }
  if (utterances.some(value => !meetingSpeechSchema.safeParse(value).success) || Buffer.byteLength(JSON.stringify(utterances)) > limits.maxTextBytes) return null;
  return utterances;
}
export function awsMeetingTranscription(options: AwsTranscribeOptions): MeetingTranscriptionProvider {
  const loaded = (async () => {
    const sdk = options.sdk ?? await loadAwsTranscribeSdk();
    const config = { ...options.clientConfiguration, region: options.region, maxAttempts: 1 };
    return { sdk, s3: new sdk.S3Client(config), transcribe: new sdk.TranscribeClient(config) };
  })();
  const validName = (name: string) => name.startsWith(`${options.jobPrefix}-`) && /^[A-Za-z0-9_-]{1,200}$/u.test(name);
  return {
    async start(input) {
      if (!validName(input.jobName) || !meetingInputKey.test(input.inputKey) || input.outputKey !== input.inputKey.replace(/\.flac$/u, '.json')) return 'refused';
      const { sdk, transcribe } = await loaded;
      try {
        await transcribe.send(new sdk.StartTranscriptionJobCommand({
          TranscriptionJobName: input.jobName, LanguageCode: 'en-US', MediaFormat: 'flac',
          Media: { MediaFileUri: `s3://${options.bucket}/${input.inputKey}` },
          OutputBucketName: options.bucket, OutputKey: input.outputKey,
          ...(input.sourceKind === 'participant' ? {} : { Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 30 } }),
        }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
        return 'started';
      } catch (error) {
        const value = record(error), status = record(value?.['$metadata'])?.['httpStatusCode'];
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409 && value?.['name'] !== 'ConflictException') return 'refused';
        return 'ambiguous';
      }
    },
    async collect(input) {
      if (!validName(input.jobName) || !meetingOutputKey.test(input.outputKey)) return { kind: 'failed', code: 'invalid_job_identity' };
      const { sdk, transcribe, s3 } = await loaded;
      let status: unknown;
      try {
        const answer = await transcribe.send(new sdk.GetTranscriptionJobCommand({ TranscriptionJobName: input.jobName }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
        status = record(record(answer)?.['TranscriptionJob'])?.['TranscriptionJobStatus'];
      } catch { return { kind: 'pending' }; }
      if (status === 'FAILED') return { kind: 'failed', code: 'provider_failed' };
      if (status !== 'COMPLETED') return { kind: 'pending' };
      try {
        const signal = AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS);
        const object = await s3.send(new sdk.GetObjectCommand({ Bucket: options.bucket, Key: input.outputKey }), { abortSignal: signal });
        const bytes = await boundedBody(record(object)?.['Body'], limits.maxProviderBytes, signal);
        const utterances = parseAwsMeetingTranscript(JSON.parse(bytes.toString('utf8')) as unknown);
        return utterances === null ? { kind: 'failed', code: 'output_invalid' } : { kind: 'complete', language: 'en-US', utterances };
      } catch (error) {
        if (error instanceof Error && error.message === 'output_too_large') return { kind: 'failed', code: 'output_too_large' };
        if (error instanceof SyntaxError) return { kind: 'failed', code: 'output_invalid' };
        const name = error instanceof Error ? error['name'] : '';
        return { kind: 'failed', code: name === 'NoSuchKey' || name === 'NotFound' ? 'output_missing' : 'output_unreadable' };
      }
    },
  };
}
