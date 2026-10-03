import { createReadStream } from 'node:fs';
import { addAbortSignal, Readable } from 'node:stream';
import { loadAwsTranscribeSdk, type AwsTranscribeSdk } from './awsTranscribeClient.ts';

export interface MeetingProcessingStore {
  download(key: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  upload(key: string, path: string, sizeBytes: number, sha256: string, signal: AbortSignal): Promise<void>;
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const meetingInputKey = new RegExp(`^meetings-processing/${uuid}/${uuid}\\.flac$`, 'u');
export const meetingOutputKey = new RegExp(`^meetings-processing/${uuid}/${uuid}\\.json$`, 'u');
export const meetingSourceKey = new RegExp(`^meetings/${uuid}/[0-9a-f]{64}\\.m4a$`, 'u');
export function streamingBody(body: unknown): AsyncIterable<Uint8Array> {
  if (body === null || typeof body !== 'object' || !(Symbol.asyncIterator in body)) throw new Error('unreadable_body');
  return body as AsyncIterable<Uint8Array>;
}
/** Never call transformToByteArray: the bound must be enforced before buffering. */
export async function boundedBody(body: unknown, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  signal.throwIfAborted();
  const original = streamingBody(body);
  const stream = addAbortSignal(signal, original instanceof Readable ? original : Readable.from(original));
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new Error('unreadable_body');
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('output_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally {
    stream.destroy();
    (original as Partial<Readable>).destroy?.();
  }
}
export function meetingProcessingStore(options: { bucket: string; region: string; sdk?: AwsTranscribeSdk }): MeetingProcessingStore {
  const loaded = (async () => { const sdk = options.sdk ?? await loadAwsTranscribeSdk(); return { sdk, client: new sdk.S3Client({ region: options.region, maxAttempts: 1 }) }; })();
  return {
    async download(key, signal) {
      if (!meetingSourceKey.test(key)) throw new Error('invalid_source_key');
      const { sdk, client } = await loaded;
      const result = await client.send(new sdk.GetObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal }) as { Body?: unknown };
      return streamingBody(result.Body);
    },
    async upload(key, path, sizeBytes, sha256, signal) {
      if (!meetingInputKey.test(key)) throw new Error('invalid_input_key');
      const { sdk, client } = await loaded; const body = createReadStream(path);
      try {
        await client.send(new sdk.PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentLength: sizeBytes,
          ContentType: 'audio/flac', ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }), { abortSignal: signal });
      } finally { body.destroy(); }
    },
  };
}
