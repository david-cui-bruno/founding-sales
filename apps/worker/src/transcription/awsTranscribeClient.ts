import { CALL_RECORDING_MAX_BYTES, RECORDING_CHANNEL_ROLES, type CallTranscriptUtterance } from '@fss/contracts';
import type { CollectOutcome, TranscriptionOutcome, TranscriptionPricing, TranscriptionProvider } from '@fss/domain/calls/transcription.ts';

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
 *     ChannelIdentification`, and `OutputBucketName` with an `OutputKey` ending `.json`,
 *     which is then the output object's own key;
 *   * https://docs.aws.amazon.com/transcribe/latest/APIReference/API_GetTranscriptionJob.html —
 *     `TranscriptionJobStatus` QUEUED | IN_PROGRESS | FAILED | COMPLETED and
 *     `FailureReason`. A name with no job answers 400 `BadRequestException` ("The requested
 *     job couldn't be found"; probed read-only on 1 October 2026), not a 404;
 *   * https://docs.aws.amazon.com/transcribe/latest/dg/channel-id.html — a two-channel file
 *     is transcribed per channel; the output's `results.channel_labels.channels[]` carry
 *     `ch_0` and `ch_1`, and `results.audio_segments[]` carry each segment's
 *     `channel_label`;
 *   * https://aws.amazon.com/transcribe/pricing/ — $0.024 a minute at the first tier, billed
 *     per second with a 15-second minimum per request; channel identification costs
 *     nothing more. The AWS Price List API gave $0.0001 a second for this account's
 *     region (E1, 1 October 2026): `AWS_TRANSCRIBE_PRICING`.
 *
 * ## The flow (slice C3a, simplified after review C3-F)
 *
 * `packages/domain/calls/transcription.ts` drives it, through `transcribe` (the one paid
 * request) and `jobs` (one look at a job):
 *
 *   1. chunk 3a records the job's names (`jobs.names`) and commits, before anything is sent;
 *   2. chunk 3b (`transcribe`): the recording's bytes — already bounded to the reserved
 *      minutes by `boundMp3` — put in the private call-audio bucket at
 *      `calls/<session>/attempt-<n>.mp3`; the final settings read (`finalCheck`, the pause
 *      boundary, nothing between it and the request); `StartTranscriptionJob` as
 *      `<prefix>-<session>-a<n>`, en-US, mp3, channel identification on, its output
 *      written to the same bucket at `calls/<session>/attempt-<n>.json`
 *      (`OutputBucketName`, `OutputKey`). The answer is `started` at once; the domain
 *      commits that;
 *   3. later, short claims (`jobs.collect`): one `GetTranscriptionJob` each and, once it
 *      completed, one `GetObject` of the output, mapped by channel to utterances.
 *
 * Nothing is deleted afterwards and nothing is owed: the bucket's one-day lifecycle expires
 * the audio and the transcript, so no prospect speech stays in service-managed storage. The
 * job record AWS keeps holds only metadata (the names, a status, the two S3 URIs), and
 * `DeleteTranscriptionJob` is not used at all. The deletion workflow deletes a deleted
 * call's objects early, best effort, after its commit.
 *
 * Transcribe writes the output with the caller's permissions (the task role's
 * `s3:PutObject` on `calls/*`; https://docs.aws.amazon.com/transcribe/latest/dg/security_iam_id-based-policy-examples.html,
 * "Amazon S3 output bucket policy"), and the role may start a job only with this bucket as
 * its output (`transcribe:OutputBucketName`, `transcribe:OutputKey` in
 * `infra/modules/cluster`).
 *
 * Both SDK clients make exactly one attempt per request (`maxAttempts: 1`): an automatic
 * retry of `StartTranscriptionJob` would be a second paid request with no final settings
 * read before it. Every retry is the application's.
 *
 * ## Settled at the reservation
 *
 * `GetTranscriptionJob` reports no media duration, and the transcript none either, so
 * nothing Transcribe answers says what it billed. The attempt is settled at its
 * reservation — the started minutes of the bounded audio at $0.006 a minute, at most a
 * minute's $0.006 above the per-second bill — as the paid-call pattern settles every answer
 * that reports no usage. The stored transcript's duration is its last segment's end.
 *
 * ## Failure classes
 *
 *   * `transcribe` answers `refused` when no job can exist: the upload failed, or Transcribe
 *     refused Start with a 4xx other than a name already taken; `withdrawn` when the final
 *     settings read said off. Anything else — accepted, a 5xx, a timeout, a dropped
 *     connection, the name taken — is `started`: the job's own status, read by `collect`,
 *     says whether it exists, so an attempt that may have started is never bought twice.
 *   * `collect` answers `failed` for a FAILED job (terminal, not billed), `unreadable` for a
 *     COMPLETED one whose output is missing, cannot be read or is not two channels (billed),
 *     `not_found` when there is no such job, `unknown` when the look itself failed.
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
/** Each request's own bound: the upload, Start, one status read, one output read, one delete. */
export const AWS_REQUEST_TIMEOUT_MS = 20_000;
/** One attempt per request: no SDK retry ever repeats a paid request past the final settings read. */
export const AWS_SDK_MAX_ATTEMPTS = 1;
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
  readonly S3Client: new (configuration: { region: string; maxAttempts: number }) => AwsSdkClient;
  readonly PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly TranscribeClient: new (configuration: { region: string; maxAttempts: number }) => AwsSdkClient;
  readonly StartTranscriptionJobCommand: new (input: Record<string, unknown>) => unknown;
  readonly GetTranscriptionJobCommand: new (input: Record<string, unknown>) => unknown;
}

export async function loadAwsTranscribeSdk(): Promise<AwsTranscribeSdk> {
  // Lazily, as `loadS3SuppressionJournal` does: a worker that never transcribes never imports them.
  const s3Specifier = '@aws-sdk/client-s3';
  const transcribeSpecifier = '@aws-sdk/client-transcribe';
  const s3 = (await import(s3Specifier)) as Pick<AwsTranscribeSdk, 'S3Client' | 'PutObjectCommand' | 'GetObjectCommand' | 'DeleteObjectCommand'>;
  const transcribeSdk = (await import(transcribeSpecifier)) as Pick<
    AwsTranscribeSdk,
    'TranscribeClient' | 'StartTranscriptionJobCommand' | 'GetTranscriptionJobCommand'
  >;
  return {
    S3Client: s3.S3Client,
    PutObjectCommand: s3.PutObjectCommand,
    GetObjectCommand: s3.GetObjectCommand,
    DeleteObjectCommand: s3.DeleteObjectCommand,
    TranscribeClient: transcribeSdk.TranscribeClient,
    StartTranscriptionJobCommand: transcribeSdk.StartTranscriptionJobCommand,
    GetTranscriptionJobCommand: transcribeSdk.GetTranscriptionJobCommand,
  };
}

export interface AwsTranscribeOptions {
  readonly bucket: string;
  readonly region: string;
  /** The job-name prefix the worker's role may Get (`<name_prefix>-`). */
  readonly jobPrefix: string;
  readonly sdk?: AwsTranscribeSdk | undefined;
  /** For tests only: merged into both clients' configuration (an in-memory transport, credentials). */
  readonly clientConfiguration?: Readonly<Record<string, unknown>> | undefined;
  /** A line for a best-effort delete that failed: the error's name only, never a key or a message. */
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `calls/<session>/attempt-<n>.mp3`: the input, unique to the call and the paid attempt. */
export function callAudioObjectKey(sessionId: string, attempt: number): string {
  return `calls/${sessionId}/attempt-${String(attempt)}.mp3`;
}

/** `calls/<session>/attempt-<n>.json`: the job's output, beside its input. */
export function callTranscriptObjectKey(sessionId: string, attempt: number): string {
  return `calls/${sessionId}/attempt-${String(attempt)}.json`;
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

/** An S3 answer body as bytes, at most `limit`; null when larger. */
async function bodyBytes(body: unknown, limit: number): Promise<Buffer | null> {
  const source = record(body);
  if (source !== null && typeof source['transformToByteArray'] === 'function') {
    const bytes = Buffer.from(await (source['transformToByteArray'] as () => Promise<Uint8Array>)());
    return bytes.byteLength > limit ? null : bytes;
  }
  if (body instanceof Uint8Array) return body.byteLength > limit ? null : Buffer.from(body);
  if (typeof body === 'string') return Buffer.byteLength(body) > limit ? null : Buffer.from(body);
  return null;
}

export function awsTranscribeTranscription(options: AwsTranscribeOptions): TranscriptionProvider {
  type Clients = { readonly sdk: AwsTranscribeSdk; readonly s3: AwsSdkClient; readonly jobs: AwsSdkClient };
  let clients: Promise<Clients> | null = null;
  const connect = async (): Promise<Clients> => {
    clients ??= (async () => {
      const sdk = options.sdk ?? (await loadAwsTranscribeSdk());
      const configuration = { ...options.clientConfiguration, region: options.region, maxAttempts: AWS_SDK_MAX_ATTEMPTS };
      return { sdk, s3: new sdk.S3Client(configuration), jobs: new sdk.TranscribeClient(configuration) };
    })();
    return await clients;
  };
  const signal = (): AbortSignal => AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS);
  const names = (subject: { readonly sessionId: string; readonly attempt: number }) => ({
    jobName: transcriptionJobName(options.jobPrefix, subject.sessionId, subject.attempt),
    inputKey: callAudioObjectKey(subject.sessionId, subject.attempt),
    outputKey: callTranscriptObjectKey(subject.sessionId, subject.attempt),
  });
  /** Best effort, never owed: an object not deleted here expires with the bucket's lifecycle. */
  const deleteObject = async (objectKey: string): Promise<void> => {
    const { sdk, s3 } = await connect();
    try {
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey }), { abortSignal: signal() });
    } catch (error) {
      options.log?.('aws_transcribe_object_delete_failed', { error: nameOf(error) });
    }
  };

  return {
    providerKey: AWS_TRANSCRIBE_PROVIDER_KEY,
    provider: AWS_TRANSCRIBE_PROVIDER,
    model: AWS_TRANSCRIBE_MODEL,
    pricing: AWS_TRANSCRIBE_PRICING,
    // The upload and Start, each one bounded request (a refusal adds one delete).
    maxCallSeconds: 3 * Math.ceil(AWS_REQUEST_TIMEOUT_MS / 1000),
    transcribe: async (input): Promise<TranscriptionOutcome> => {
      if (input.audio.byteLength === 0 || input.audio.byteLength > CALL_RECORDING_MAX_BYTES) {
        return { ok: false, kind: 'refused', code: 'audio_size' };
      }
      // Without a subject (a caller from before C3a) the attempt is unique by a random tag.
      const subject = input.subject ?? { sessionId: crypto.randomUUID(), attempt: 1 };
      const { jobName, inputKey, outputKey } = names(subject);
      const { sdk, s3, jobs } = await connect();

      // The upload. Nothing has been asked of Transcribe yet, so a failure bills nothing.
      try {
        await s3.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: inputKey,
            Body: input.audio,
            ContentType: input.contentType,
            ServerSideEncryption: 'AES256',
          }),
          { abortSignal: signal() },
        );
      } catch {
        await deleteObject(inputKey);
        return { ok: false, kind: 'refused', code: 'aws_transcribe_upload_failed' };
      }

      // The pause boundary: the final settings read, immediately before the request. The
      // upload above is a network round trip; a turn-off during it stops the job here. A
      // read that throws sends nothing either, and the object is deleted all the same.
      let withdrawn: Awaited<ReturnType<NonNullable<typeof input.finalCheck>>> = null;
      try {
        withdrawn = input.finalCheck === undefined ? null : await input.finalCheck();
      } catch (error) {
        await deleteObject(inputKey);
        throw error;
      }
      if (withdrawn !== null) {
        await deleteObject(inputKey);
        return { ok: false, kind: 'withdrawn', reason: withdrawn };
      }

      // The paid request, once: the client makes one attempt (`AWS_SDK_MAX_ATTEMPTS`).
      try {
        await jobs.send(
          new sdk.StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: AWS_TRANSCRIBE_LANGUAGE_CODE,
            MediaFormat: 'mp3',
            Media: { MediaFileUri: `s3://${options.bucket}/${inputKey}` },
            OutputBucketName: options.bucket,
            OutputKey: outputKey,
            Settings: { ChannelIdentification: true },
          }),
          { abortSignal: signal() },
        );
      } catch (error) {
        if (startRefused(error)) {
          await deleteObject(inputKey);
          return { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' };
        }
        // It may have been accepted: the job's status will say.
        return { ok: false, kind: 'started', code: nameOf(error) === 'ConflictException' ? 'aws_transcribe_job_exists' : 'aws_transcribe_start_unknown' };
      }
      return { ok: false, kind: 'started', code: 'started' };
    },
    jobs: {
      names,
      collect: async ({ jobName, outputKey }): Promise<CollectOutcome> => {
        const { sdk, s3, jobs } = await connect();
        let job: Record<string, unknown> | null;
        try {
          const answer = record(await jobs.send(new sdk.GetTranscriptionJobCommand({ TranscriptionJobName: jobName }), { abortSignal: signal() }));
          job = record(answer?.['TranscriptionJob']);
        } catch (error) {
          // "The requested job couldn't be found" (probed 1 October 2026): never started.
          if (nameOf(error) === 'BadRequestException') return { kind: 'not_found' };
          return { kind: 'unknown', code: 'aws_transcribe_status_unknown' };
        }
        const status = job?.['TranscriptionJobStatus'];
        if (status === 'FAILED') return { kind: 'failed', code: 'aws_transcribe_job_failed' };
        if (status !== 'COMPLETED') return status === 'QUEUED' || status === 'IN_PROGRESS' ? { kind: 'running' } : { kind: 'unknown', code: 'aws_transcribe_status_unknown' };
        // The output, from our own bucket: never the job's presigned URL.
        let utterances: CallTranscriptUtterance[] | null = null;
        try {
          const answer = record(await s3.send(new sdk.GetObjectCommand({ Bucket: options.bucket, Key: outputKey }), { abortSignal: signal() }));
          const bytes = await bodyBytes(answer?.['Body'], MAX_TRANSCRIPT_BYTES);
          if (bytes !== null) utterances = parseAwsTranscript(JSON.parse(bytes.toString('utf8')) as unknown);
        } catch (error) {
          // Gone (it lives a day) is a billed job whose result is lost; anything else is a look to repeat.
          if (nameOf(error) === 'NoSuchKey') return { kind: 'unreadable', code: 'aws_transcribe_output_missing' };
          return { kind: 'unknown', code: 'aws_transcribe_output_unavailable' };
        }
        if (utterances === null) return { kind: 'unreadable', code: 'aws_transcribe_transcript_unreadable' };
        // The job reports no media duration: settled at the reservation (`billedSeconds: null`).
        const durationSeconds = utterances.reduce((latest, utterance) => Math.max(latest, utterance.end), 0);
        return { kind: 'completed', durationSeconds, billedSeconds: null, language: 'en', utterances };
      },
    },
  };
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
