/**
 * Is this file an audio-only MP4/M4A? (Review M4R, minor: the extension is not trusted.)
 *
 * Not a parse: the first box must be `ftyp`; then the top-level boxes are walked by their
 * size headers until `moov`, which is read (bounded) and searched for `hdlr` boxes. The file
 * is audio when some track's handler is `soun` and none is `vide`. Anything else — no `ftyp`,
 * no `moov`, a video track, a box walk that does not add up — is `not_audio`, and the file is
 * never hashed or uploaded. Only box headers and `moov` are read, never the media data.
 */

export type SniffVerdict = 'audio' | 'not_audio' | 'unreadable';

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

const MAX_BOXES = 64;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

export async function sniffAudio(source: ByteSource): Promise<SniffVerdict> {
  try {
    const head = await source.read(0, 16);
    if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return 'not_audio';
    let offset = 0;
    for (let box = 0; box < MAX_BOXES && offset + 8 <= source.size; box += 1) {
      const header = await source.read(offset, 16);
      if (header.length < 8) return 'not_audio';
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerLength = 8;
      if (size === 1) {
        if (header.length < 16) return 'not_audio';
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return 'not_audio';
        size = Number(large);
        headerLength = 16;
      } else if (size === 0) {
        size = source.size - offset;
      }
      if (size < headerLength || offset + size > source.size) return 'not_audio';
      if (type === 'moov') {
        if (size - headerLength > MAX_MOOV_BYTES) return 'not_audio';
        return handlersSay(await source.read(offset + headerLength, size - headerLength));
      }
      offset += size;
    }
    return 'not_audio';
  } catch {
    return 'unreadable';
  }
}

/** The handler types of the `hdlr` boxes in `moov`: `soun` and no `vide` is audio. */
function handlersSay(moov: Buffer): SniffVerdict {
  const handlers = new Set<string>();
  let at = moov.indexOf('hdlr', 0, 'latin1');
  while (at !== -1) {
    if (at + 16 <= moov.length) handlers.add(moov.toString('latin1', at + 12, at + 16));
    at = moov.indexOf('hdlr', at + 4, 'latin1');
  }
  return handlers.has('soun') && !handlers.has('vide') ? 'audio' : 'not_audio';
}
