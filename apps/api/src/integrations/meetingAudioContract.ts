import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { meetingAudioKey, sha256Base64, UPLOAD_ID_HEADER, type MeetingAudioStore } from './meetingAudio.ts';

/**
 * The meeting-audio upload contract, against the real bucket (lane M4, the coordinator's early
 * contract check B). `apps/api --meeting-audio-check` runs it inside a one-off API task, so it
 * presigns with the API task role and the API's own `loadMeetingAudioStore`, and the PUTs go
 * from inside the environment's network to S3 exactly as the Mac's do (`node:https`, the
 * signed headers and nothing else). `infra/scripts/rehearsal.sh meeting-audio` launches it in
 * a rehearsal run; nothing launches it in production.
 *
 * Four answers only real S3 gives:
 *   1. a PUT with exactly `put.headers` is accepted (200): the checksum and the upload-id
 *      headers are signed headers, not hoisted into the query, and the SDK added no header of
 *      its own the Mac could not send (`requestChecksumCalculation: 'WHEN_REQUIRED'`);
 *   2. HEAD answers the size, the SHA-256 S3 computed (`ChecksumMode: 'ENABLED'`) and the
 *      upload id from `Metadata['callie-upload']`;
 *   3. the same URL without `x-amz-meta-callie-upload` is refused (a 4xx);
 *   4. the same URL and headers with a body of the same length whose digest differs is
 *      refused (a 4xx); and, after both refusals, HEAD still answers the first object.
 *
 * The object is synthetic bytes under `meetings/<random uuid>/<sha256>.m4a`, a meeting id no
 * row can carry. The API role has no delete on `meetings/*` (by design), so it is left: the
 * bucket's one-day expiry removes it, and a rehearsal's teardown destroys the bucket with it
 * (`force_destroy` on a destroyable stack) sooner.
 */

export interface ContractPutAnswer {
  /** The HTTP status, or null when nothing answered. */
  readonly status: number | null;
  /** S3's error `<Code>`, when the body carried one. */
  readonly code: string | null;
}

export type ContractPut = (url: string, headers: Readonly<Record<string, string>>, body: Buffer) => Promise<ContractPutAnswer>;

export interface ContractStep {
  readonly step: 'put' | 'head' | 'put_without_upload_id' | 'put_other_digest' | 'head_after_refusals' | 'cleanup';
  readonly ok: boolean;
  readonly detail: string;
}

export interface ContractResult {
  readonly ok: boolean;
  /** The object key written (public: a random meeting id and the synthetic body's digest). */
  readonly key: string;
  readonly steps: readonly ContractStep[];
}

const PUT_TIMEOUT_MS = 30_000;
const ERROR_BODY_BYTES = 4096;

/** One PUT over `node:https`, as the Mac's uploader sends it: these headers, this body. */
export const httpsContractPut: ContractPut = async (url, headers, body) =>
  await new Promise<ContractPutAnswer>(resolve => {
    const outgoing = request(new URL(url), { method: 'PUT', headers: { ...headers }, timeout: PUT_TIMEOUT_MS }, response => {
      const chunks: Buffer[] = [];
      let held = 0;
      response.on('data', (chunk: Buffer) => {
        if (held < ERROR_BODY_BYTES) chunks.push(chunk);
        held += chunk.length;
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).subarray(0, ERROR_BODY_BYTES).toString('utf8');
        resolve({ status: response.statusCode ?? null, code: /<Code>([^<]{1,100})<\/Code>/u.exec(text)?.[1] ?? null });
      });
      response.on('error', () => {
        resolve({ status: null, code: null });
      });
    });
    outgoing.on('timeout', () => {
      outgoing.destroy(new Error('timeout'));
    });
    outgoing.on('error', () => {
      resolve({ status: null, code: null });
    });
    outgoing.end(body);
  });

const refused = (answer: ContractPutAnswer): boolean => answer.status !== null && answer.status >= 400 && answer.status < 500;
const described = (answer: ContractPutAnswer): string => `status=${answer.status ?? 'none'} code=${answer.code ?? 'none'}`;

export async function checkMeetingAudioContract(deps: {
  readonly store: MeetingAudioStore;
  readonly put?: ContractPut;
  readonly newId?: () => string;
}): Promise<ContractResult> {
  const put = deps.put ?? httpsContractPut;
  const newId = deps.newId ?? randomUUID;
  const meetingId = newId();
  const uploadId = newId();
  const body = Buffer.from(`callie meeting-audio contract check ${meetingId}; synthetic bytes, not audio\n`, 'utf8');
  const sha256Hex = createHash('sha256').update(body).digest('hex');
  const key = meetingAudioKey(meetingId, sha256Hex);
  const steps: ContractStep[] = [];
  const done = (): ContractResult => ({ ok: steps.every(step => step.ok), key, steps });

  const signed = await deps.store.presignPut({ key, sizeBytes: body.length, sha256Hex, uploadId });

  // 1. Exactly the signed headers: accepted.
  const first = await put(signed.url, signed.headers, body);
  steps.push({ step: 'put', ok: first.status === 200, detail: described(first) });
  if (first.status !== 200) return done();

  // 2. HEAD: the size, S3's own digest and the upload id read back.
  const expected = { sizeBytes: body.length, sha256Base64: sha256Base64(sha256Hex), uploadId };
  const headMatches = async (step: 'head' | 'head_after_refusals'): Promise<void> => {
    try {
      const head = await deps.store.head(key);
      const ok =
        head.found && head.sizeBytes === expected.sizeBytes && head.sha256Base64 === expected.sha256Base64 && head.uploadId === expected.uploadId;
      steps.push({
        step,
        ok,
        detail: head.found
          ? `size=${head.sizeBytes === expected.sizeBytes ? 'match' : 'differs'} sha256=${head.sha256Base64 === null ? 'absent' : head.sha256Base64 === expected.sha256Base64 ? 'match' : 'differs'} upload_id=${head.uploadId === null ? 'absent' : head.uploadId === expected.uploadId ? 'match' : 'differs'}`
          : 'not_found',
      });
    } catch (error) {
      steps.push({ step, ok: false, detail: error instanceof Error ? error.name : 'error' });
    }
  };
  await headMatches('head');

  // 3. The same URL without the upload-id header: the signature no longer holds.
  const withoutUploadId = Object.fromEntries(Object.entries(signed.headers).filter(([name]) => name !== UPLOAD_ID_HEADER));
  const third = await put(signed.url, withoutUploadId, body);
  steps.push({ step: 'put_without_upload_id', ok: refused(third), detail: described(third) });

  // 4. The same URL and headers, a body of the same length with another digest.
  const other = Buffer.from(body);
  other[other.length - 2] = other[other.length - 2] === 0x2e ? 0x21 : 0x2e;
  const fourth = await put(signed.url, signed.headers, other);
  steps.push({ step: 'put_other_digest', ok: refused(fourth), detail: described(fourth) });

  // Neither refusal replaced the object.
  await headMatches('head_after_refusals');

  // 5. The API role cannot delete under meetings/: the object is left to the one-day expiry.
  steps.push({ step: 'cleanup', ok: true, detail: 'left_to_one_day_expiry (the API role has no delete on meetings/*)' });
  return done();
}
