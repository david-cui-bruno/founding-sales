/**
 * Is this file an audio-only MP4/M4A? (Review M4R, minor; M4 reset, R3: the extension is not
 * trusted, and neither is a byte search.)
 *
 * A walk of the ISO-BMFF box tree, by its own size headers, never a search for look-alike
 * bytes:
 *
 *   * each box header is a 32-bit size and a type; `size == 1` is a 64-bit largesize after the
 *     type, `size == 0` runs to the end of the enclosing box (the file, at the top); a `uuid`
 *     box carries 16 more bytes of type. Every box must fit inside its parent: one that does
 *     not, or a walk that does not add up, is `not_audio`;
 *   * the first top-level box must be `ftyp`, and there must be exactly one `moov`;
 *   * only `moov > trak > mdia > hdlr` is descended. Each `trak` must have exactly one `mdia`
 *     with exactly one `hdlr`; the handler type is read at its defined offset, after the
 *     FullBox version and flags (4 bytes) and `pre_defined` (4 bytes);
 *   * the file is audio when at least one track's handler is `soun` and every other track's
 *     is `hint`, `meta` or `text`. `vide`, and any handler not known to be harmless, is
 *     rejected: a file with a track that might be video is never hashed or uploaded.
 *
 * `free`, `skip`, `mdat` and everything else are skipped by their size, so bytes inside them
 * that look like a handler are never read as one. Only box headers and `moov` (bounded) are
 * read, never the media data.
 */

export type SniffVerdict = 'audio' | 'not_audio' | 'unreadable';

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

const MAX_TOP_LEVEL_BOXES = 1024;
const MAX_CHILD_BOXES = 4096;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** Handlers a track may have beside `soun` without carrying a picture. */
const HARMLESS_HANDLERS: ReadonlySet<string> = new Set(['hint', 'meta', 'text']);

class Malformed extends Error {}

interface BoxHeader {
  readonly type: string;
  /** Where the box starts, its header length, and its whole size, relative to the container. */
  readonly start: number;
  readonly headerLength: number;
  readonly size: number;
}

/** The header of the box at `offset` of a container `limit` bytes long, from its first 32 bytes. */
function headerAt(bytes: Buffer, offset: number, limit: number): BoxHeader {
  if (offset + 8 > limit || bytes.length < 8) throw new Malformed();
  const small = bytes.readUInt32BE(0);
  const type = bytes.toString('latin1', 4, 8);
  let headerLength = 8;
  let size: number;
  if (small === 1) {
    if (bytes.length < 16) throw new Malformed();
    const large = bytes.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed();
    size = Number(large);
    headerLength = 16;
  } else if (small === 0) {
    size = limit - offset;
  } else {
    size = small;
  }
  if (type === 'uuid') headerLength += 16;
  if (size < headerLength || offset + size > limit) throw new Malformed();
  return { type, start: offset, headerLength, size };
}

/** The boxes directly inside `body` (a box's payload already in memory). */
function childrenOf(body: Buffer): BoxHeader[] {
  const boxes: BoxHeader[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (boxes.length >= MAX_CHILD_BOXES) throw new Malformed();
    const header = headerAt(body.subarray(offset, offset + 32), offset, body.length);
    boxes.push(header);
    offset += header.size;
  }
  return boxes;
}

const payloadOf = (body: Buffer, box: BoxHeader): Buffer => body.subarray(box.start + box.headerLength, box.start + box.size);

/** The only child of `type`; none, or more than one, is malformed. */
function onlyChild(body: Buffer, type: string): Buffer {
  const found = childrenOf(body).filter(box => box.type === type);
  if (found.length !== 1 || found[0] === undefined) throw new Malformed();
  return payloadOf(body, found[0]);
}

/** A `hdlr` FullBox's handler type: version and flags (4), pre_defined (4), then the type. */
function handlerOf(hdlr: Buffer): string {
  if (hdlr.length < 12) throw new Malformed();
  return hdlr.toString('latin1', 8, 12);
}

/** The handler of every track in `moov`'s payload. */
export function trackHandlers(moov: Buffer): readonly string[] {
  return childrenOf(moov)
    .filter(box => box.type === 'trak')
    .map(trak => handlerOf(onlyChild(onlyChild(payloadOf(moov, trak), 'mdia'), 'hdlr')));
}

export function handlersAreAudioOnly(handlers: readonly string[]): boolean {
  return handlers.includes('soun') && handlers.every(handler => handler === 'soun' || HARMLESS_HANDLERS.has(handler));
}

export async function sniffAudio(source: ByteSource): Promise<SniffVerdict> {
  let moov: Buffer | null = null;
  try {
    let offset = 0;
    for (let index = 0; offset < source.size; index += 1) {
      if (index >= MAX_TOP_LEVEL_BOXES) return 'not_audio';
      const header = headerAt(await source.read(offset, 32), offset, source.size);
      if (index === 0 && header.type !== 'ftyp') return 'not_audio';
      if (header.type === 'moov') {
        if (moov !== null || header.size - header.headerLength > MAX_MOOV_BYTES) return 'not_audio';
        moov = await source.read(offset + header.headerLength, header.size - header.headerLength);
        if (moov.length !== header.size - header.headerLength) return 'unreadable';
      }
      offset += header.size;
    }
    if (moov === null) return 'not_audio';
    return handlersAreAudioOnly(trackHandlers(moov)) ? 'audio' : 'not_audio';
  } catch (error) {
    return error instanceof Malformed ? 'not_audio' : 'unreadable';
  }
}
