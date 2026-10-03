/**
 * A meeting's recorded audio in the call-audio bucket (lane M4): the presigned PUT the Mac
 * uploads one per-participant file with, and the HEAD the register command checks it by.
 *
 * ## Where it goes
 *
 * The bucket the call audio already uses (`infra/modules/recordings`): SSE-S3 by the
 * bucket's default encryption (so the PUT names no encryption header), every object
 * expires a day after it is written, TLS only. A meeting's file is
 * `meetings/<meetingId>/<sha256>.m4a`, beside the calls' `calls/` prefix; the API task role
 * may put and get under `meetings/*` and nothing else there (`infra/modules/cluster`).
 *
 * ## What the URL binds
 *
 * A SigV4 query-presigned PUT, valid for 15 minutes, whose signature covers four headers
 * the Mac must send exactly: `content-type: audio/mp4`, `content-length` (the declared
 * size), `x-amz-checksum-sha256` (the declared digest, base64) and `host`. S3 refuses a
 * body of another length, and computes the body's SHA-256 itself and refuses a mismatch
 * (flexible checksums), so an object under a key can only ever be the bytes the key's
 * digest names. The checksum header is kept a header (`unhoistableHeaders`) rather than a
 * query parameter, so S3 validates it rather than merely signing it.
 *
 * `requestChecksumCalculation: 'WHEN_REQUIRED'`: the SDK's default would add its own CRC32
 * header to the signature, which the Mac cannot know how to compute for a body it streams.
 *
 * ## Credentials
 *
 * The task role, through the SDK's default chain; presigning is local and makes no call.
 * A URL is a bearer credential for 15 minutes, for one key and one body, so it is never
 * stored: the command receipt keeps the key and the route signs a fresh URL per answer.
 */

export const MEETING_AUDIO_PREFIX = 'meetings/';

/** Fifteen minutes (the brief): long enough for a 300 MB file on a slow line. */
export const MEETING_AUDIO_URL_SECONDS = 15 * 60;

export const MEETING_AUDIO_CONTENT_TYPE = 'audio/mp4';

/** HEAD is bounded on its own and across a register's files, as the deletes are (C3-N). */
export const MEETING_AUDIO_HEAD_TIMEOUT_MS = 5_000;
export const MEETING_AUDIO_TOTAL_TIMEOUT_MS = 20_000;

/** The object key of one meeting file. The migration's CHECK holds every row to it. */
export function meetingAudioKey(meetingId: string, sha256Hex: string): string {
  return `${MEETING_AUDIO_PREFIX}${meetingId}/${sha256Hex}.m4a`;
}

/** The checksum header's value: the digest as base64, as S3 spells it. */
export function sha256Base64(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64');
}

export interface PresignedPut {
  readonly url: string;
  /** Exactly the headers the signature covers, other than `host`. */
  readonly headers: Readonly<Record<'content-type' | 'content-length' | 'x-amz-checksum-sha256', string>>;
  readonly expiresAt: string;
}

export type HeadAnswer =
  | { readonly found: false }
  | { readonly found: true; readonly sizeBytes: number; readonly sha256Base64: string | null };

/** S3 did not answer definitely (a timeout, a 5xx, a refusal): nothing is decided from it. */
export class MeetingAudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingAudioUnavailableError';
  }
}

export interface MeetingAudioStore {
  presignPut(input: { readonly key: string; readonly sizeBytes: number; readonly sha256Hex: string }): Promise<PresignedPut>;
  /** One HEAD with the checksum asked for. Throws `MeetingAudioUnavailableError` unless definite. */
  head(key: string, signal?: AbortSignal): Promise<HeadAnswer>;
}

type Client = { send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> };

/** The pieces of the SDK used, narrowed so a test can hand in fakes or the real presigner. */
export interface MeetingAudioSdk {
  readonly S3Client: new (configuration: Record<string, unknown>) => Client;
  readonly PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  readonly getSignedUrl: (
    client: Client,
    command: unknown,
    options: { expiresIn: number; signableHeaders?: Set<string>; unhoistableHeaders?: Set<string> },
  ) => Promise<string>;
}

/** The headers the URL's signature covers; the presigner always adds `host`. */
export const SIGNED_PUT_HEADERS: readonly string[] = Object.freeze(['content-type', 'content-length', 'x-amz-checksum-sha256']);

export async function loadMeetingAudioStore(options: {
  readonly bucket: string;
  readonly region: string;
  readonly sdk?: MeetingAudioSdk | undefined;
  /** Tests only: fixed credentials, so the presigner runs without the default chain. */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string } | undefined;
  readonly now?: (() => Date) | undefined;
}): Promise<MeetingAudioStore> {
  const sdk = options.sdk ?? (await loadSdk());
  const now = options.now ?? (() => new Date());
  const client = new sdk.S3Client({
    region: options.region,
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
  return {
    async presignPut(input) {
      const command = new sdk.PutObjectCommand({
        Bucket: options.bucket,
        Key: input.key,
        ContentType: MEETING_AUDIO_CONTENT_TYPE,
        ContentLength: input.sizeBytes,
        ChecksumSHA256: sha256Base64(input.sha256Hex),
      });
      const issuedAt = now();
      const url = await sdk.getSignedUrl(client, command, {
        expiresIn: MEETING_AUDIO_URL_SECONDS,
        signableHeaders: new Set(SIGNED_PUT_HEADERS),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      });
      return {
        url,
        headers: {
          'content-type': MEETING_AUDIO_CONTENT_TYPE,
          'content-length': String(input.sizeBytes),
          'x-amz-checksum-sha256': sha256Base64(input.sha256Hex),
        },
        expiresAt: new Date(issuedAt.getTime() + MEETING_AUDIO_URL_SECONDS * 1000).toISOString(),
      };
    },
    async head(key, signal) {
      const abortSignal = AbortSignal.any([AbortSignal.timeout(MEETING_AUDIO_HEAD_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])]);
      try {
        const answer = (await client.send(new sdk.HeadObjectCommand({ Bucket: options.bucket, Key: key, ChecksumMode: 'ENABLED' }), {
          abortSignal,
        })) as { ContentLength?: unknown; ChecksumSHA256?: unknown };
        const size = typeof answer.ContentLength === 'number' ? answer.ContentLength : Number.NaN;
        if (!Number.isSafeInteger(size)) throw new MeetingAudioUnavailableError('head answered no length');
        return { found: true, sizeBytes: size, sha256Base64: typeof answer.ChecksumSHA256 === 'string' ? answer.ChecksumSHA256 : null };
      } catch (error) {
        if (error instanceof MeetingAudioUnavailableError) throw error;
        if (isNotFound(error)) return { found: false };
        throw new MeetingAudioUnavailableError('head did not answer');
      }
    },
  };
}

/**
 * HEAD has no body, so S3's 404 arrives as `NotFound` (or a bare 404 status). Without
 * `s3:ListBucket` — which the API role deliberately lacks — S3 answers a missing object with
 * 403 instead (review M4R, finding 9; HeadObject's documented behaviour), so 403 is "not
 * there" too: the Mac uploads it again, a bounded number of times.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status = record.$metadata?.httpStatusCode;
  return record.name === 'NotFound' || record.name === 'NoSuchKey' || record.name === 'Forbidden' || record.name === 'AccessDenied' || status === 404 || status === 403;
}

async function loadSdk(): Promise<MeetingAudioSdk> {
  // Specifiers in variables, as `callAudio.ts` loads the client: nothing here is imported
  // by a process that never configured the bucket.
  const clientSpecifier = '@aws-sdk/client-s3';
  const presignerSpecifier = '@aws-sdk/s3-request-presigner';
  const s3 = (await import(clientSpecifier)) as Pick<MeetingAudioSdk, 'S3Client' | 'PutObjectCommand' | 'HeadObjectCommand'>;
  const presigner = (await import(presignerSpecifier)) as Pick<MeetingAudioSdk, 'getSignedUrl'>;
  return { S3Client: s3.S3Client, PutObjectCommand: s3.PutObjectCommand, HeadObjectCommand: s3.HeadObjectCommand, getSignedUrl: presigner.getSignedUrl };
}
