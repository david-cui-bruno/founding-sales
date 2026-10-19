import {open} from 'node:fs/promises';
import {parseTrecOrganization, TREC_LIMITS, trecProvenance, verifyTrecFirms, type TrecExistingFirm, type TrecMetadata, type TrecOrganization} from '@fss/domain/sourcing/trecVerification.ts';

/** Owner-selected local uncompressed official legacy file. No fetch, writes, logs or database access.
 * Streams bytes with a bounded line buffer, including files changed after opening. */
export async function loadTrecBrokerSource(path: string, metadata: TrecMetadata, now: Date): Promise<TrecOrganization[]> {
  trecProvenance(metadata, now);
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > TREC_LIMITS.bytes) throw new Error('invalid_trec_file');
    const records: TrecOrganization[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0), bytes = 0, rows = 0;
    const consume = (line: Buffer) => {
      if (++rows > TREC_LIMITS.rows) throw new Error('trec_too_many_rows');
      if (line.at(-1) === 13) line = line.subarray(0,-1);
      if (line.length === 0) return;
      const text = new TextDecoder('utf-8', {fatal:true}).decode(line);
      const record = parseTrecOrganization(text);
      if (record) {
        if (records.length >= TREC_LIMITS.organizations) throw new Error('trec_too_many_organizations');
        records.push(record);
      }
    };
    for (;;) {
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > TREC_LIMITS.bytes) throw new Error('trec_file_too_large');
      const data = Buffer.concat([pending, chunk.subarray(0,read.bytesRead)]);
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        if (i-start > TREC_LIMITS.lineBytes+1) throw new Error('trec_line_too_large');
        consume(data.subarray(start,i));
        start = i+1;
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > TREC_LIMITS.lineBytes+1) throw new Error('trec_line_too_large');
    }
    if (pending.length) consume(pending);
    return records;
  } finally { await file.close(); }
}
export async function verifyTrecBrokerFile(input: {path: string; metadata: TrecMetadata; firms: readonly TrecExistingFirm[]; now: Date}) {
  if (input.firms.length > TREC_LIMITS.firms) throw new Error('trec_too_many_firms');
  return verifyTrecFirms(await loadTrecBrokerSource(input.path,input.metadata,input.now), input.firms,input.metadata,input.now);
}
