import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MEETING_AUDIO_URL_SECONDS,
  loadMeetingAudioStore,
  meetingAudioKey,
  sha256Base64,
  MeetingAudioUnavailableError,
  type MeetingAudioSdk,
} from '../src/integrations/meetingAudio.ts';

/**
 * Contract check CC1 (lane M4): a presigned PUT from the API role works for the `meetings/`
 * prefix of the call-audio bucket under its SSE-S3 policy.
 *
 * Run with the real SDK presigner and fixed fake credentials (assembled at runtime), then
 * checked against an independent SigV4 computation written here, so the test fails if the
 * URL stops binding the length, the type or the digest, adds a header the Mac cannot send
 * (the SDK's own CRC32, an encryption header the bucket's default makes unnecessary), or
 * stops being https. The real PUT is the coordinator's, in rehearsal.
 */

const BUCKET = 'fss-test-call-audio-123456789012';
const REGION = 'us-east-1';
const MEETING = '3f1e2d4c-5b6a-4789-8abc-def012345678';
const SHA = createHash('sha256').update('synthetic audio bytes').digest('hex');
const SIZE = 1_234_567;
const credentials = {
  accessKeyId: ['AKIA', 'FAKE', 'M4CC1', 'KEY0'].join(''),
  secretAccessKey: ['fake', 'secret', 'for', 'cc1', 'only', '0123456789'].join('-'),
  sessionToken: ['fake', 'session', 'token'].join('-'),
};

const realSdk: MeetingAudioSdk = {
  S3Client: S3Client as unknown as MeetingAudioSdk['S3Client'],
  PutObjectCommand: PutObjectCommand as unknown as MeetingAudioSdk['PutObjectCommand'],
  HeadObjectCommand: HeadObjectCommand as unknown as MeetingAudioSdk['HeadObjectCommand'],
  getSignedUrl: getSignedUrl as unknown as MeetingAudioSdk['getSignedUrl'],
};

const hmac = (key: Buffer | string, text: string): Buffer => createHmac('sha256', key).update(text, 'utf8').digest();
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

/** S3's SigV4 for a query-presigned request, computed from the request a client would send. */
function signatureFor(url: URL, method: string, headers: Readonly<Record<string, string>>, secret: string): string {
  const query = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  const all: Record<string, string> = { ...headers, host: url.host };
  const canonicalHeaders = signed.map(name => `${name}:${(all[name] ?? '').trim()}\n`).join('');
  const canonical = [method, url.pathname, query, canonicalHeaders, signed.join(';'), url.searchParams.get('X-Amz-Content-Sha256') ?? ''].join('\n');
  const date = url.searchParams.get('X-Amz-Date') ?? '';
  const scope = `${date.slice(0, 8)}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date.slice(0, 8)), REGION), 's3'), 'aws4_request');
  return hmac(key, toSign).toString('hex');
}

describe('CC1: the presigned PUT for a meeting recording', () => {
  it('is an https PUT to meetings/<meeting>/<sha256>.m4a, valid 15 minutes, binding type, length and digest', async () => {
    const store = await loadMeetingAudioStore({ bucket: BUCKET, region: REGION, sdk: realSdk, credentials, now: () => new Date('2026-10-03T12:00:00Z') });
    const key = meetingAudioKey(MEETING, SHA);
    expect(key).toBe(`meetings/${MEETING}/${SHA}.m4a`);
    const put = await store.presignPut({ key, sizeBytes: SIZE, sha256Hex: SHA });
    const url = new URL(put.url);

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(MEETING_AUDIO_URL_SECONDS));
    expect(MEETING_AUDIO_URL_SECONDS).toBe(900);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256');
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(put.expiresAt).toBe('2026-10-03T12:15:00.000Z');
    expect(put.headers).toEqual({
      'content-type': 'audio/mp4',
      'content-length': String(SIZE),
      'x-amz-checksum-sha256': sha256Base64(SHA),
    });
    // Nothing the Mac cannot send, and no encryption header: the bucket's default is SSE-S3.
    const everything = `${url.search} ${JSON.stringify(put.headers)}`.toLowerCase();
    for (const absent of ['x-amz-server-side-encryption', 'crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-crc']) {
      expect(everything).not.toContain(absent);
    }

    // The URL's signature is the one S3 computes for exactly these headers…
    expect(signatureFor(url, 'PUT', put.headers, credentials.secretAccessKey)).toBe(url.searchParams.get('X-Amz-Signature'));
    // …and for no other length, type or digest, so S3 refuses any other body.
    for (const changed of [
      { ...put.headers, 'content-length': String(SIZE + 1) },
      { ...put.headers, 'content-type': 'video/mp4' },
      { ...put.headers, 'x-amz-checksum-sha256': sha256Base64(createHash('sha256').update('other').digest('hex')) },
    ]) {
      expect(signatureFor(url, 'PUT', changed, credentials.secretAccessKey)).not.toBe(url.searchParams.get('X-Amz-Signature'));
    }
    // Not a GET: the URL cannot be used to read the object back.
    expect(signatureFor(url, 'GET', put.headers, credentials.secretAccessKey)).not.toBe(url.searchParams.get('X-Amz-Signature'));
  });

  it('HEAD: a found object with its checksum, NotFound and 403 as absent, anything else as no answer', async () => {
    const answers: unknown[] = [
      { ContentLength: SIZE, ChecksumSHA256: sha256Base64(SHA) },
      Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
      Object.assign(new Error('slow'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } }),
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    ];
    const sent: Record<string, unknown>[] = [];
    class FakeHead {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const sdk: MeetingAudioSdk = {
      ...realSdk,
      HeadObjectCommand: FakeHead,
      S3Client: class {
        async send(command: unknown): Promise<unknown> {
          sent.push((command as FakeHead).input);
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return await Promise.resolve(next);
        }
      },
    };
    const store = await loadMeetingAudioStore({ bucket: BUCKET, region: REGION, sdk, credentials });
    const key = meetingAudioKey(MEETING, SHA);
    await expect(store.head(key)).resolves.toEqual({ found: true, sizeBytes: SIZE, sha256Base64: sha256Base64(SHA) });
    await expect(store.head(key)).resolves.toEqual({ found: false });
    await expect(store.head(key)).rejects.toBeInstanceOf(MeetingAudioUnavailableError);
    // Review M4R, finding 9: without ListBucket a missing object is 403, which is "not there".
    await expect(store.head(key)).resolves.toEqual({ found: false });
    expect(sent[0]).toEqual({ Bucket: BUCKET, Key: key, ChecksumMode: 'ENABLED' });
  });
});
