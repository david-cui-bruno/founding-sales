import { CALL_RECORDING_MAX_BYTES, RECORDING_CHANNEL_ROLES, type CallTranscriptUtterance } from '@fss/contracts';
import { boundedBody } from '@fss/domain/calls/twilioRecording.ts';
import { boundMp3 } from '@fss/domain/calls/mp3Bound.ts';
import type { TranscriptionOutcome, TranscriptionPricing, TranscriptionProvider } from '@fss/domain/calls/transcription.ts';

/**
 * Amazon Transcribe, standard batch, with channel identification (slice C3a): the primary
 * transcription engine from 1 October 2026 (David's decision). Paid from the AWS
 * account's credits (`packages/domain/settings/funding.ts`), so it counts against the
 * day's transcription cap and never against the month's cash ceiling.
 *
 * Built from AWS's public documentation (read 1 October 2026) and the coordinator's eight
 * real jobs of that day (`apps/worker/test/fixtures/awsTranscribe/*.json` are their raw
 * outputs):
 *
 *   * https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartTranscriptionJob.html —
 *     `TranscriptionJobName` unique in the account and region, `LanguageCode`,
 *     `MediaFormat`, `Media.MediaFileUri` (`s3://bucket/key`), `Settings.
 *     ChannelIdentification`; no `OutputBucketName` means the service-managed output,
 *     whose `Transcript.TranscriptFileUri` is a temporary HTTPS URL;
 *   * https://docs.aws.amazon.com/transcribe/latest/APIReference/API_GetTranscriptionJob.html —
 *     `TranscriptionJobStatus` QUEUED | IN_PROGRESS | FAILED | COMPLETED and
 *     `FailureReason`. A name with no job answers 400 `BadRequestException` ("The requested
 *     job couldn't be found"; probed read-only on 1 October 2026), not a 404;
 *   * https://docs.aws.amazon.com/transcribe/latest/APIReference/API_DeleteTranscriptionJob.html —
 *     deletes the job and its service-managed transcript;
 *   * https://docs.aws.amazon.com/transcribe/latest/dg/channel-id.html — a two-channel file
 *     is transcribed per channel; the output's `results.channel_labels.channels[]` carry
 *     `ch_0` and `ch_1`, and `results.audio_segments[]` carry each segment's
 *     `channel_label`;
 *   * https://aws.amazon.com/transcribe/pricing/ — $0.024 a minute at the first tier, billed
 *     per second with a 15-second minimum per request; channel identification costs
 *     nothing more. The AWS Price List API gave $0.0001 a second for this account's
 *     region (E1, 1 October 2026): `AWS_TRANSCRIBE_PRICING`.
 *
 * ## The flow, inside chunk 3 of `call.transcribe`
 *
 *   1. the earlier attempts' job and object of the same call, deleted (best effort): a lost
 *      claim's job must not keep a transcript in the service's storage;
 *   2. the recording's bytes — already bounded to the reserved minutes by `boundMp3` —
 *      put in the private call-audio bucket at `calls/<session>/attempt-<n>.mp3`;
 *   3. `StartTranscriptionJob` as `<prefix>-<session>-a<n>`: en-US, mp3, channel
 *      identification on;
 *   4. `GetTranscriptionJob` polled with backoff (3 s, × 1.5, at most 15 s) until it ends
 *      or `AWS_TRANSCRIBE_TIMEOUT_MS` passes;
 *   5. the transcript fetched from `TranscriptFileUri` over HTTPS, at most
 *      `MAX_TRANSCRIPT_BYTES`, and mapped by channel to utterances;
 *   6. the object and the job deleted, whatever happened (best effort, logged; the
 *      bucket's one-day expiry is the backstop).
 *
 * The pause boundary (`docs/greenfield/calling.md`, "What the pause guarantees") is the
 * final settings read immediately before `StartTranscriptionJob`: `finalCheck`, after the
 * upload. A turn-off read there deletes the object and sends nothing (`withdrawn`).
 *
 * ## Settled at the reservation
 *
 * `GetTranscriptionJob` reports no media duration, and the transcript none either, so
 * nothing Transcribe answers says what it billed. The attempt is settled at its
 * reservation — the started minutes of the bounded audio at $0.006 a minute, at most a
 * minute's $0.006 above the per-second bill — as the paid-call pattern settles every answer
 * that reports no usage. The stored transcript's duration is the uploaded audio's, from its
 * MP3 frames.
 *
 * ## Failure classes (the paid-call pattern)
 *
 *   * `refused` — nothing was transcribed and nothing billed: the upload failed (no job
 *     was asked for), Transcribe answered `StartTranscriptionJob` with a 4xx refusal, or
 *     the job ended FAILED with a reason (terminal: retrying the same audio fails again).
 *   * `ambiguous` — `StartTranscriptionJob` may have been accepted and nobody knows what
 *     it did: a network failure or 5xx on Start, a job that has not ended by the timeout,
 *     a COMPLETED job whose transcript could not be read, or one whose channels are not
 *     the two this call's recording has.
 *
 * ## No credential here
 *
 * The worker's task role is the credential: the SDK's default chain reads the task's
 * role from the ECS container credentials endpoint. Nothing in this module holds a key,
 * and no outcome code carries an AWS message.
 */

export const AWS_TRANSCRIBE_PROVIDER = 'aws_transcribe';
export const AWS_TRANSCRIBE_MODEL = 'standard';
/** The ledger's and the reservations' `provider_key`: kind `aws_transcribe`, paid from credits. */
export const AWS_TRANSCRIBE_PROVIDER_KEY = `${AWS_TRANSCRIBE_PROVIDER}.${AWS_TRANSCRIBE_MODEL}`;
export const AWS_TRANSCRIBE_LANGUAGE_CODE = 'en-US';
/** $0.0001 a second (6 000 micro-dollars a minute), by the second, at least 15 seconds. */
export const AWS_TRANSCRIBE_PRICING: TranscriptionPricing = Object.freeze({
  unitPriceMicros: 6_000,
  billedChannels: 1,
  perSecondMinimumSeconds: 15,
});
/**
 * The longest the whole flow may take. E1's jobs took 12–23 s for one to two minutes of
 * audio; seven minutes leaves a half-hour call room. The job's lease is sized from it
 * (`callTranscribeLeaseSeconds`).
 */
export const AWS_TRANSCRIBE_TIMEOUT_MS = 420_000;
/** The first wait before `GetTranscriptionJob`, the growth of each next one, and the longest. */
export const AWS_TRANSCRIBE_POLL = Object.freeze({ firstMs: 3_000, factor: 1.5, maxMs: 15_000 });
/** One upload, one Start, one Get, one delete, one transcript read: each its own bound. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A transcript of a four-hour call is well under this. */
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_UTTERANCE_CHARACTERS = 4_000;
/** Within a channel, a pause longer than this starts a new utterance (when there are no audio segments). */
const UTTERANCE_GAP_SECONDS = 1;

/** An SDK v3 client's one method this module uses. */
export interface AwsSdkClient {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}

/** The pieces of `@aws-sdk/client-s3` and `@aws-sdk/client-transcribe` used, narrowed so a test can hand in fakes. */
export interface AwsTranscribeSdk {
  readonly S3Client: new (configuration: { region: string }) => AwsSdkClient;
  readonly PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly TranscribeClient: new (configuration: { region: string }) => AwsSdkClient;
  readonly StartTranscriptionJobCommand: new (input: Record<string, unknown>) => unknown;
  readonly GetTranscriptionJobCommand: new (input: Record<string, unknown>) => unknown;
  readonly DeleteTranscriptionJobCommand: new (input: Record<string, unknown>) => unknown;
}

export async function loadAwsTranscribeSdk(): Promise<AwsTranscribeSdk> {
  // Lazily, as `loadS3SuppressionJournal` does: a worker that never transcribes never imports them.
  const s3Specifier = '@aws-sdk/client-s3';
  const transcribeSpecifier = '@aws-sdk/client-transcribe';
  const s3 = (await import(s3Specifier)) as Pick<AwsTranscribeSdk, 'S3Client' | 'PutObjectCommand' | 'DeleteObjectCommand'>;
  const transcribeSdk = (await import(transcribeSpecifier)) as Pick<
    AwsTranscribeSdk,
    'TranscribeClient' | 'StartTranscriptionJobCommand' | 'GetTranscriptionJobCommand' | 'DeleteTranscriptionJobCommand'
  >;
  return {
    S3Client: s3.S3Client,
    PutObjectCommand: s3.PutObjectCommand,
    DeleteObjectCommand: s3.DeleteObjectCommand,
    TranscribeClient: transcribeSdk.TranscribeClient,
    StartTranscriptionJobCommand: transcribeSdk.StartTranscriptionJobCommand,
    GetTranscriptionJobCommand: transcribeSdk.GetTranscriptionJobCommand,
    DeleteTranscriptionJobCommand: transcribeSdk.DeleteTranscriptionJobCommand,
  };
}

export type TranscriptHttp = (url: string, init: { readonly method: 'GET'; readonly signal: AbortSignal }) => Promise<Response>;

export interface AwsTranscribeOptions {
  readonly bucket: string;
  readonly region: string;
  /** The job-name prefix the worker's role may Get and Delete (`<name_prefix>-`). */
  readonly jobPrefix: string;
  readonly sdk?: AwsTranscribeSdk | undefined;
  readonly http?: TranscriptHttp | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
  /** A line for a cleanup that failed: what (`object`, `job`) and the error's name, never a key or a message. */
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `calls/<session>/attempt-<n>.mp3`: unique to the call and the paid attempt. */
export function callAudioObjectKey(sessionId: string, attempt: number): string {
  return `calls/${sessionId}/attempt-${String(attempt)}.mp3`;
}

/** `<prefix>-<session>-a<n>`: unique to the call and the paid attempt, at most 200 characters of `[0-9a-zA-Z._-]`. */
export function transcriptionJobName(jobPrefix: string, sessionId: string, attempt: number): string {
  return `${jobPrefix}-${sessionId}-a${String(attempt)}`;
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/** `ch_0` → 0, `ch_1` → 1; anything else null. */
function channelIndex(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const match = /^ch_(\d)$/u.exec(label);
  return match === null ? null : Number(match[1]);
}

/**
 * The recording channel's speaker, by `RECORDING_CHANNEL_ROLES` — channel 0 is the parent
 * leg, David ("you"), channel 1 the dialled prospect ("them") — or null for a channel the
 * two-leg recording does not have.
 */
export function speakerOfChannel(channel: number): number | null {
  if (channel === RECORDING_CHANNEL_ROLES.you) return RECORDING_CHANNEL_ROLES.you;
  if (channel === RECORDING_CHANNEL_ROLES.them) return RECORDING_CHANNEL_ROLES.them;
  return null;
}

const seconds = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Utterances from `results.audio_segments`, or null when they are not the documented shape. */
function fromAudioSegments(segments: readonly unknown[]): CallTranscriptUtterance[] | null {
  const utterances: CallTranscriptUtterance[] = [];
  for (const entry of segments) {
    const segment = record(entry);
    if (segment === null) return null;
    const channel = channelIndex(segment['channel_label']);
    const start = seconds(segment['start_time']);
    const end = seconds(segment['end_time']);
    const text = segment['transcript'];
    if (channel === null || start === null || end === null || typeof text !== 'string') return null;
    const speaker = speakerOfChannel(channel);
    if (speaker === null) return null;
    if (text.trim() === '') continue;
    utterances.push({ speaker, start, end: Math.max(start, end), text: text.trim().slice(0, MAX_UTTERANCE_CHARACTERS) });
  }
  return utterances;
}

/** Utterances built from each channel's words, split at pauses, or null when they are not the documented shape. */
function fromChannelItems(channels: readonly unknown[]): CallTranscriptUtterance[] | null {
  const utterances: CallTranscriptUtterance[] = [];
  for (const entry of channels) {
    const channelEntry = record(entry);
    if (channelEntry === null) return null;
    const channel = channelIndex(channelEntry['channel_label']);
    const items = channelEntry['items'];
    if (channel === null || !Array.isArray(items)) return null;
    const speaker = speakerOfChannel(channel);
    if (speaker === null) return null;
    let current: { start: number; end: number; text: string } | null = null;
    const close = (): void => {
      if (current !== null && current.text.trim() !== '') {
        utterances.push({ speaker, start: current.start, end: current.end, text: current.text.trim().slice(0, MAX_UTTERANCE_CHARACTERS) });
      }
      current = null;
    };
    for (const raw of items as unknown[]) {
      const item = record(raw);
      if (item === null) return null;
      const alternatives = item['alternatives'];
      const first = Array.isArray(alternatives) ? record(alternatives[0]) : null;
      const content = first?.['content'];
      if (typeof content !== 'string') return null;
      if (item['type'] === 'punctuation') {
        if (current !== null) (current as { text: string }).text += content;
        continue;
      }
      if (item['type'] !== 'pronunciation') return null;
      const start = seconds(item['start_time']);
      const end = seconds(item['end_time']);
      if (start === null || end === null) return null;
      const open = current as { start: number; end: number; text: string } | null;
      if (open !== null && start - open.end > UTTERANCE_GAP_SECONDS) close();
      const now = current as { start: number; end: number; text: string } | null;
      if (now === null) current = { start, end: Math.max(start, end), text: content };
      else {
        now.text += ` ${content}`;
        now.end = Math.max(now.end, end);
      }
    }
    close();
  }
  return utterances;
}

/**
 * The service-managed transcript of a two-channel job, as utterances in time order, each
 * labelled by its channel; null when it is not that shape — no `channel_labels`, a channel
 * count other than two, a channel other than `ch_0`/`ch_1`, or a malformed segment.
 * `results.audio_segments` are Transcribe's own segments with their channel; without them
 * each channel's words are joined, split at pauses.
 */
export function parseAwsTranscript(body: unknown): CallTranscriptUtterance[] | null {
  const top = record(body);
  const results = record(top?.['results']);
  const labels = record(results?.['channel_labels']);
  if (results === null || labels === null) return null;
  if (labels['number_of_channels'] !== 2) return null;
  const channels = labels['channels'];
  if (!Array.isArray(channels)) return null;
  const segments = results['audio_segments'];
  const utterances =
    Array.isArray(segments) && segments.length > 0 ? fromAudioSegments(segments as unknown[]) : fromChannelItems(channels as unknown[]);
  if (utterances === null) return null;
  return utterances.sort((left, right) => left.start - right.start || left.speaker - right.speaker);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** An SDK error's HTTP status, when the service answered. */
function statusOf(error: unknown): number | null {
  const metadata = record(record(error)?.['$metadata']);
  const status = metadata?.['httpStatusCode'];
  return typeof status === 'number' ? status : null;
}

function nameOf(error: unknown): string {
  const name = record(error)?.['name'];
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : 'Error';
}

/** Whether Start was refused by Transcribe itself, so no job exists: a 4xx other than a name already taken. */
function startRefused(error: unknown): boolean {
  const status = statusOf(error);
  if (status === null || status < 400 || status >= 500) return false;
  // A job of this name exists already: whatever it is, it may have been billed.
  return nameOf(error) !== 'ConflictException';
}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
};

export function awsTranscribeTranscription(options: AwsTranscribeOptions): TranscriptionProvider {
  const http: TranscriptHttp = options.http ?? (async (url, init) => await fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? AWS_TRANSCRIBE_TIMEOUT_MS;
  type Clients = { readonly sdk: AwsTranscribeSdk; readonly s3: AwsSdkClient; readonly jobs: AwsSdkClient };
  let clients: Promise<Clients> | null = null;
  const connect = async (): Promise<Clients> => {
    clients ??= (async () => {
      const sdk = options.sdk ?? (await loadAwsTranscribeSdk());
      return { sdk, s3: new sdk.S3Client({ region: options.region }), jobs: new sdk.TranscribeClient({ region: options.region }) };
    })();
    return await clients;
  };
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void => {
    options.log?.(event, fields);
  };

  return {
    providerKey: AWS_TRANSCRIBE_PROVIDER_KEY,
    provider: AWS_TRANSCRIBE_PROVIDER,
    model: AWS_TRANSCRIBE_MODEL,
    pricing: AWS_TRANSCRIBE_PRICING,
    maxCallSeconds: Math.ceil(timeoutMs / 1000) + 2 * Math.ceil(REQUEST_TIMEOUT_MS / 1000),
    transcribe: async (input): Promise<TranscriptionOutcome> => {
      if (input.audio.byteLength === 0 || input.audio.byteLength > CALL_RECORDING_MAX_BYTES) {
        return { ok: false, kind: 'refused', code: 'audio_size' };
      }
      // Without a subject (a caller from before C3a) the attempt is unique by a random tag.
      const sessionId = input.subject?.sessionId ?? crypto.randomUUID();
      const attempt = input.subject?.attempt ?? 1;
      const { sdk, s3, jobs } = await connect();
      const key = callAudioObjectKey(sessionId, attempt);
      const jobName = transcriptionJobName(options.jobPrefix, sessionId, attempt);
      const signal = (): AbortSignal => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      const deleteObject = async (objectKey: string): Promise<void> => {
        try {
          await s3.send(new sdk.DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey }), { abortSignal: signal() });
        } catch (error) {
          log('aws_transcribe_cleanup_failed', { what: 'object', error: nameOf(error) });
        }
      };
      const deleteJob = async (name: string, quiet: boolean): Promise<void> => {
        try {
          await jobs.send(new sdk.DeleteTranscriptionJobCommand({ TranscriptionJobName: name }), { abortSignal: signal() });
        } catch (error) {
          // An earlier attempt usually has no job left: not found is the expected answer.
          if (!quiet || statusOf(error) !== 400) log('aws_transcribe_cleanup_failed', { what: 'job', error: nameOf(error) });
        }
      };
      const cleanUp = async (): Promise<void> => {
        await deleteObject(key);
        await deleteJob(jobName, false);
      };

      // 1. A lost claim's earlier attempts of this call leave nothing behind.
      for (let earlier = 1; earlier < attempt; earlier += 1) {
        await deleteJob(transcriptionJobName(options.jobPrefix, sessionId, earlier), true);
        await deleteObject(callAudioObjectKey(sessionId, earlier));
      }

      // 2. The upload. Nothing has been asked of Transcribe yet, so a failure bills nothing.
      try {
        await s3.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: input.audio,
            ContentType: input.contentType,
            ServerSideEncryption: 'AES256',
          }),
          { abortSignal: signal() },
        );
      } catch {
        await deleteObject(key);
        return { ok: false, kind: 'refused', code: 'aws_transcribe_upload_failed' };
      }

      // The pause boundary: the final settings read, immediately before the request. The
      // upload above is a network round trip; a turn-off during it stops the job here.
      const withdrawn = input.finalCheck === undefined ? null : await input.finalCheck();
      if (withdrawn !== null) {
        await deleteObject(key);
        return { ok: false, kind: 'withdrawn', reason: withdrawn };
      }

      // 3. The job. From here on Transcribe may have accepted it.
      const deadline = now() + timeoutMs;
      try {
        await jobs.send(
          new sdk.StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: AWS_TRANSCRIBE_LANGUAGE_CODE,
            MediaFormat: 'mp3',
            Media: { MediaFileUri: `s3://${options.bucket}/${key}` },
            Settings: { ChannelIdentification: true },
          }),
          { abortSignal: signal() },
        );
      } catch (error) {
        if (startRefused(error)) {
          await deleteObject(key);
          return { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' };
        }
        await cleanUp();
        return { ok: false, kind: 'ambiguous', code: nameOf(error) === 'ConflictException' ? 'aws_transcribe_job_exists' : 'aws_transcribe_start_unknown' };
      }

      // 4. Polled to its end, or to the deadline.
      let wait: number = AWS_TRANSCRIBE_POLL.firstMs;
      let transcriptUri: string | null = null;
      for (;;) {
        const left = deadline - now();
        if (left <= 0) {
          await cleanUp();
          return { ok: false, kind: 'ambiguous', code: 'aws_transcribe_timeout' };
        }
        await sleep(Math.min(wait, left));
        wait = Math.min(AWS_TRANSCRIBE_POLL.maxMs, Math.round(wait * AWS_TRANSCRIBE_POLL.factor));
        let job: Record<string, unknown> | null;
        try {
          const answer = record(
            await jobs.send(new sdk.GetTranscriptionJobCommand({ TranscriptionJobName: jobName }), { abortSignal: signal() }),
          );
          job = record(answer?.['TranscriptionJob']);
        } catch {
          // A failed read says nothing about the job; the deadline bounds the asking.
          continue;
        }
        const status = job?.['TranscriptionJobStatus'];
        if (status === 'FAILED') {
          // Terminal: the same audio fails the same way. A failed job is not billed.
          await cleanUp();
          return { ok: false, kind: 'refused', code: 'aws_transcribe_job_failed' };
        }
        if (status === 'COMPLETED') {
          const uri = record(job?.['Transcript'])?.['TranscriptFileUri'];
          transcriptUri = typeof uri === 'string' ? uri : null;
          break;
        }
      }

      // 5. The transcript, from the service-managed output over HTTPS.
      let utterances: CallTranscriptUtterance[] | null = null;
      if (transcriptUri !== null && isServiceTranscriptUri(transcriptUri)) {
        try {
          const response = await http(transcriptUri, { method: 'GET', signal: signal() });
          if (response.status === 200) {
            const bytes = await boundedBody(response, MAX_TRANSCRIPT_BYTES);
            if (bytes !== null) utterances = parseAwsTranscript(JSON.parse(bytes.toString('utf8')) as unknown);
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
        } catch {
          utterances = null;
        }
      }

      // 6. Nothing kept: the audio and the job (with its transcript) deleted.
      await cleanUp();
      if (utterances === null) return { ok: false, kind: 'ambiguous', code: 'aws_transcribe_transcript_unreadable' };
      // The transcript's duration is the uploaded audio's, from its own frames. The job reports
      // no media duration, so nothing reports what was billed: the attempt settles at its
      // reservation (`billedSeconds: null`), which priced exactly this audio's bound.
      const measured = boundMp3(input.audio, Number.POSITIVE_INFINITY)?.seconds ?? 0;
      return { ok: true, durationSeconds: measured, billedSeconds: null, language: 'en', utterances };
    },
  };
}

/** The service-managed output's URL: HTTPS, on an `amazonaws.com` host, and nothing else. */
export function isServiceTranscriptUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && (parsed.hostname === 'amazonaws.com' || parsed.hostname.endsWith('.amazonaws.com'));
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/** The task environment's variables this provider reads; none is a secret. */
export const AWS_TRANSCRIBE_VARIABLES = Object.freeze({
  bucket: 'FSS_CALL_AUDIO_BUCKET',
  region: 'AWS_REGION',
  prefix: 'FSS_NAME_PREFIX',
});

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const NAME_PREFIX = /^[a-z][a-z0-9-]{1,30}$/u;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/u;

/**
 * Amazon Transcribe from the task environment, or null with the problem by variable name.
 * No secret: the task role is the credential.
 */
export function readAwsTranscribeProvider(
  environment: Readonly<Record<string, string | undefined>>,
  options: Omit<AwsTranscribeOptions, 'bucket' | 'region' | 'jobPrefix'> = {},
): { readonly provider: TranscriptionProvider | null; readonly problem: string | null } {
  const bucket = environment[AWS_TRANSCRIBE_VARIABLES.bucket]?.trim() ?? '';
  const region = environment[AWS_TRANSCRIBE_VARIABLES.region]?.trim() ?? '';
  const prefix = environment[AWS_TRANSCRIBE_VARIABLES.prefix]?.trim() ?? '';
  if (!BUCKET_NAME.test(bucket)) return { provider: null, problem: AWS_TRANSCRIBE_VARIABLES.bucket };
  if (!REGION.test(region)) return { provider: null, problem: AWS_TRANSCRIBE_VARIABLES.region };
  if (!NAME_PREFIX.test(prefix)) return { provider: null, problem: AWS_TRANSCRIBE_VARIABLES.prefix };
  return { provider: awsTranscribeTranscription({ ...options, bucket, region, jobPrefix: prefix }), problem: null };
}
