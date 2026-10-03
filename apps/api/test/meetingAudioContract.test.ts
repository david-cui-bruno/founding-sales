import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { API_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { API_EXIT_CODES, main } from '../src/bootstrap/main.ts';
import { loadMeetingAudioStore, type MeetingAudioSdk } from '../src/integrations/meetingAudio.ts';
import { checkMeetingAudioContract, type ContractPut, type ContractStep } from '../src/integrations/meetingAudioContract.ts';

/**
 * The real-S3 contract check's own logic (lane M4, coordinator's check B), offline: the real
 * SDK presigner with fixed fake credentials, and a fake S3 that does what S3 does with a
 * query-presigned PUT — recomputes SigV4 over the headers the request carries (a signed header
 * missing is a 403), refuses a body whose SHA-256 is not the checksum header's (400 BadDigest),
 * stores the `x-amz-meta-*` headers as metadata, and answers HEAD with them. Each check case
 * makes one of those answers wrong and requires the check to fail on it.
 */

const BUCKET = 'fss-test-call-audio-123456789012';
const REGION = 'us-east-1';
const SECRET = ['fake', 'secret', 'for', 'contract', 'check', '0123456789'].join('-');
const credentials = { accessKeyId: ['AKIA', 'FAKE', 'M4CB', 'KEY00'].join(''), secretAccessKey: SECRET };

const hmac = (key: Buffer | string, text: string): Buffer => createHmac('sha256', key).update(text, 'utf8').digest();
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

/** S3's SigV4 for a query-presigned request, from the headers the request actually carries. */
function signatureOf(url: URL, headers: Readonly<Record<string, string>>): string {
  const query = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  const all: Record<string, string> = { ...headers, host: url.host };
  const canonicalHeaders = signed.map(name => `${name}:${(all[name] ?? '').trim()}\n`).join('');
  const canonical = ['PUT', url.pathname, query, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const date = url.searchParams.get('X-Amz-Date') ?? '';
  const scope = `${date.slice(0, 8)}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date.slice(0, 8)), REGION), 's3'), 'aws4_request');
  return hmac(key, toSign).toString('hex');
}

interface Stored {
  readonly size: number;
  readonly sha256: string;
  readonly metadata: Record<string, string>;
}

interface Lax {
  /** S3 that does not compare the body with the checksum header. */
  readonly noDigestCheck?: boolean;
  /** HEAD that loses the metadata. */
  readonly headDropsMetadata?: boolean;
  /** The presigner hoists the upload id into the query (no `unhoistableHeaders`). */
  readonly hoistUploadId?: boolean;
}

function fakeS3(lax: Lax = {}) {
  const objects = new Map<string, Stored>();
  const puts: { readonly key: string; readonly status: number }[] = [];
  const put: ContractPut = async (url, headers, body) => {
    const target = new URL(url);
    const key = decodeURIComponent(target.pathname.slice(1));
    const answer = (status: number, code: string | null) => {
      puts.push({ key, status });
      return Promise.resolve({ status, code });
    };
    if (signatureOf(target, headers) !== target.searchParams.get('X-Amz-Signature')) return await answer(403, 'SignatureDoesNotMatch');
    if (headers['content-length'] !== String(body.length)) return await answer(400, 'IncompleteBody');
    const sha256 = createHash('sha256').update(body).digest('base64');
    const declared = headers['x-amz-checksum-sha256'] ?? target.searchParams.get('x-amz-checksum-sha256');
    if (lax.noDigestCheck !== true && declared !== sha256) return await answer(400, 'BadDigest');
    const metadata: Record<string, string> = {};
    for (const [name, value] of [...Object.entries(headers), ...target.searchParams.entries()]) {
      if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value;
    }
    objects.set(key, { size: body.length, sha256, metadata });
    return await answer(200, null);
  };
  class HeadingClient extends S3Client {
    override send(command: unknown): Promise<never> {
      if (!(command instanceof HeadObjectCommand)) throw new Error('only HEAD reaches this fake');
      const stored = objects.get(command.input.Key ?? '');
      if (stored === undefined) return Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
      return Promise.resolve({
        ContentLength: stored.size,
        ChecksumSHA256: stored.sha256,
        Metadata: lax.headDropsMetadata === true ? {} : stored.metadata,
      } as never);
    }
  }
  const sdk: MeetingAudioSdk = {
    S3Client: HeadingClient as unknown as MeetingAudioSdk['S3Client'],
    PutObjectCommand: PutObjectCommand as unknown as MeetingAudioSdk['PutObjectCommand'],
    HeadObjectCommand: HeadObjectCommand as unknown as MeetingAudioSdk['HeadObjectCommand'],
    getSignedUrl: (async (client, command, options) =>
      await (getSignedUrl as unknown as MeetingAudioSdk['getSignedUrl'])(
        client,
        command,
        lax.hoistUploadId === true ? { ...options, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) } : options,
      )) as MeetingAudioSdk['getSignedUrl'],
  };
  return { objects, puts, put, sdk };
}

let ids = 0;
const newId = (): string => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`;

async function run(lax: Lax = {}) {
  const s3 = fakeS3(lax);
  const store = await loadMeetingAudioStore({ bucket: BUCKET, region: REGION, sdk: s3.sdk, credentials });
  const result = await checkMeetingAudioContract({ store, put: s3.put, newId });
  const verdict = Object.fromEntries(result.steps.map(step => [step.step, step.ok])) as Partial<Record<ContractStep['step'], boolean>>;
  return { s3, result, verdict };
}

describe('the meeting-audio contract check (check B), against a faithful fake of S3', () => {
  it('passes: the signed PUT lands, HEAD reads size, digest and upload id back, both bad PUTs are refused, the object is left to expiry', async () => {
    const { s3, result, verdict } = await run();
    expect(result.ok).toBe(true);
    expect(verdict).toEqual({ put: true, head: true, put_without_upload_id: true, put_other_digest: true, head_after_refusals: true, cleanup: true });
    expect(result.key).toMatch(/^meetings\/00000000-0000-4000-8000-\d{12}\/[0-9a-f]{64}\.m4a$/u);
    expect(s3.puts.map(put => put.status)).toEqual([200, 403, 400]);
    expect(s3.objects.size).toBe(1);
    expect(result.steps.find(step => step.step === 'cleanup')?.detail).toContain('left_to_one_day_expiry');
    expect(result.steps.find(step => step.step === 'put_without_upload_id')?.detail).toBe('status=403 code=SignatureDoesNotMatch');
  });
});

describe('the check fails on each answer real S3 must give and a wrong setup would not', () => {
  it('the upload id hoisted into the query: a PUT without the header is accepted, so the check fails', async () => {
    const { result, verdict } = await run({ hoistUploadId: true });
    expect(result.ok).toBe(false);
    expect(verdict.put_without_upload_id).toBe(false);
  });

  it('a body whose digest differs is accepted: the check fails', async () => {
    const { result, verdict } = await run({ noDigestCheck: true });
    expect(result.ok).toBe(false);
    expect(verdict.put_other_digest).toBe(false);
  });

  it('HEAD answers no upload id: the check fails', async () => {
    const { result, verdict } = await run({ headDropsMetadata: true });
    expect(result.ok).toBe(false);
    expect(verdict.head).toBe(false);
    expect(result.steps.find(step => step.step === 'head')?.detail).toContain('upload_id=absent');
  });

  it('the first PUT refused (a header the presigner signed that the Mac does not send): the check fails at once', async () => {
    const s3 = fakeS3();
    const store = await loadMeetingAudioStore({ bucket: BUCKET, region: REGION, sdk: s3.sdk, credentials });
    const refusing: ContractPut = async (url, headers, body) => await s3.put(url, { ...headers, 'content-type': 'audio/mpeg' }, body);
    const result = await checkMeetingAudioContract({ store, put: refusing, newId });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([{ step: 'put', ok: false, detail: 'status=403 code=SignatureDoesNotMatch' }]);
  });
});

describe('apps/api --meeting-audio-check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses without a call-audio bucket, before any call', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      lines.push(String(chunk));
      return true;
    });
    const code = await main(['--meeting-audio-check'], {
      DATABASE_URL: 'postgres://check@localhost:5432/check',
      FSS_DEPENDENCIES: 'none',
      FSS_SCHEMA_MIN: String(API_SCHEMA_RANGE.minimum),
      FSS_SCHEMA_MAX: String(API_SCHEMA_RANGE.maximum),
    });
    expect(code).toBe(API_EXIT_CODES.configurationInvalid);
    expect(lines.join('')).toContain('"reason":"no_call_audio_bucket"');
  });
});
