/**
 * Is this file audio and nothing else? (Review M4R, minor; M4 reset R3, repaired after M4RR
 * finding 1: decided by CODEC, never by a track's label.)
 *
 * A walk of the WHOLE ISO-BMFF box tree, recursively, at any depth, through every container a
 * player reads — every `moov` (however many, however nested), `trak`, `mdia`, `minf`, `stbl`,
 * `edts`, `dinf`, `udta`, `meta`, `mvex`, `moof`, `traf`, `mfra`, `tref`, `sinf`, `schi` — by
 * the boxes' own size headers, bounds-checked against their parent: 32-bit sizes, `size == 1`
 * a 64-bit largesize, `size == 0` to the end of the parent, `uuid` boxes 16 bytes more. A box
 * that does not fit, or a container that does not parse, makes the file `not_audio`.
 *
 * The file is audio only when:
 *   * its first box is `ftyp`;
 *   * at least one `stsd` (sample description) exists;
 *   * EVERY sample entry of EVERY `stsd` anywhere is an audio codec on the allowlist
 *     (`mp4a`, Zoom's; `alac`; `Opus`) — any other type, `avc1`, `hvc1`, `mp4v`, an
 *     encrypted `enca`, anything unknown, is rejected; and
 *   * no `hdlr` anywhere names a picture handler (`vide`, `pict`, `auxv`); and
 *   * no compressed movie header is anywhere (M4 verification, finding A): a `cmov`, `dcom` or
 *     `cmvd` box at the top level, at any depth of the walk, or with a plausible box header
 *     anywhere in the bytes of a container read (inside a sample entry, `ilst`, `wave`…).
 *     Players inflate `cmov` and read the movie inside it, which can carry video; it is never
 *     inflated here, only refused.
 *
 * A track's handler label no longer makes anything acceptable: a video track labelled `text`,
 * `hint` or `meta` still describes its samples as video, and that is what is read. Bytes in
 * `free`, `skip`, `mdat` or any box that is not a container are never read as boxes. Only box
 * headers and the containers (bounded) are read, never the media data.
 */

export type SniffVerdict = 'audio' | 'not_audio' | 'unreadable';

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** The sample entry types (codecs) accepted: Zoom writes `mp4a`. */
export const AUDIO_CODECS: ReadonlySet<string> = new Set(['mp4a', 'alac', 'Opus']);
/** Handlers that carry pictures: none may appear anywhere. */
const PICTURE_HANDLERS: ReadonlySet<string> = new Set(['vide', 'pict', 'auxv']);
/** Boxes whose payload is a sequence of boxes. `meta` is handled on its own (FullBox or not). */
const CONTAINERS: ReadonlySet<string> = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi']);
const TOP_LEVEL_READ = new Set([...CONTAINERS, 'meta']);
/** A compressed movie header and its parts: refused wherever they appear, never inflated. */
export const COMPRESSED_MOVIE: ReadonlySet<string> = new Set(['cmov', 'dcom', 'cmvd']);

const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_BOXES = 100_000;
const MAX_DEPTH = 32;
/** All containers read into memory together, at most. */
const MAX_CONTAINER_BYTES = 64 * 1024 * 1024;

class Malformed extends Error {}

interface BoxHeader {
  readonly type: string;
  readonly start: number;
  readonly headerLength: number;
  readonly size: number;
}

/** The header of the box at `offset` in a parent `limit` bytes long, from up to its first 32 bytes. */
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

/** The boxes directly inside `body`. A trailing all-zero terminator shorter than a box is allowed. */
function childrenOf(body: Buffer): BoxHeader[] {
  const boxes: BoxHeader[] = [];
  let offset = 0;
  while (offset < body.length) {
    const rest = body.length - offset;
    if (rest < 8 && body.subarray(offset).every(byte => byte === 0)) break;
    const header = headerAt(body.subarray(offset, offset + 32), offset, body.length);
    boxes.push(header);
    offset += header.size;
  }
  return boxes;
}

const payloadOf = (body: Buffer, box: BoxHeader): Buffer => body.subarray(box.start + box.headerLength, box.start + box.size);

interface Found {
  descriptions: number;
  readonly codecs: Set<string>;
  readonly handlers: Set<string>;
  boxes: number;
}

/** A `stsd`: version and flags (4), entry_count (4), then that many sample entries, each a box named by its codec. */
function readSampleDescription(stsd: Buffer, found: Found): void {
  if (stsd.length < 8) throw new Malformed();
  const count = stsd.readUInt32BE(4);
  if (count < 1) throw new Malformed();
  const body = stsd.subarray(8);
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = headerAt(body.subarray(offset, offset + 32), offset, body.length);
    found.codecs.add(entry.type);
    offset += entry.size;
  }
  found.descriptions += 1;
}

/** A `hdlr`: version and flags (4), pre_defined (4), then handler_type. */
function readHandler(hdlr: Buffer, found: Found): void {
  if (hdlr.length < 12) throw new Malformed();
  found.handlers.add(hdlr.toString('latin1', 8, 12));
}

/** `meta` is a FullBox in ISO files and a plain container in QuickTime's: whichever parses. */
function metaChildren(payload: Buffer): { readonly body: Buffer; readonly boxes: BoxHeader[] } {
  for (const skip of [4, 0]) {
    if (payload.length < skip) continue;
    const body = payload.subarray(skip);
    try {
      return { body, boxes: childrenOf(body) };
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
    }
  }
  throw new Malformed();
}

/**
 * Any 4-byte `cmov`/`dcom`/`cmvd` in `bytes` preceded by a size a box could have (0, 1, or 8 up
 * to the bytes that remain): such bytes are refused even where the walk does not descend.
 */
function holdsCompressedMovie(bytes: Buffer): boolean {
  for (const type of COMPRESSED_MOVIE) {
    const needle = Buffer.from(type, 'latin1');
    for (let at = bytes.indexOf(needle, 4); at !== -1; at = bytes.indexOf(needle, at + 1)) {
      const size = bytes.readUInt32BE(at - 4);
      if (size === 0 || size === 1 || (size >= 8 && size <= bytes.length - (at - 4))) return true;
    }
  }
  return false;
}

/** Every box inside a container's payload, at any depth. */
function walk(body: Buffer, boxes: readonly BoxHeader[], found: Found, depth: number): void {
  if (depth > MAX_DEPTH) throw new Malformed();
  for (const box of boxes) {
    found.boxes += 1;
    if (found.boxes > MAX_BOXES) throw new Malformed();
    if (COMPRESSED_MOVIE.has(box.type)) throw new Malformed();
    const payload = payloadOf(body, box);
    if (box.type === 'stsd') readSampleDescription(payload, found);
    else if (box.type === 'hdlr') readHandler(payload, found);
    else if (box.type === 'meta') {
      const inner = metaChildren(payload);
      walk(inner.body, inner.boxes, found, depth + 1);
    } else if (CONTAINERS.has(box.type)) walk(payload, childrenOf(payload), found, depth + 1);
  }
}

export function verdictOf(found: Pick<Found, 'descriptions' | 'codecs' | 'handlers'>): 'audio' | 'not_audio' {
  if (found.descriptions === 0 || found.codecs.size === 0) return 'not_audio';
  for (const codec of found.codecs) if (!AUDIO_CODECS.has(codec)) return 'not_audio';
  for (const handler of found.handlers) if (PICTURE_HANDLERS.has(handler)) return 'not_audio';
  return 'audio';
}

/** The codecs and handlers of a box tree already in memory (tests, and the walk's core). */
export function describe(bytes: Buffer): Found {
  const found: Found = { descriptions: 0, codecs: new Set(), handlers: new Set(), boxes: 0 };
  if (holdsCompressedMovie(bytes)) throw new Malformed();
  walk(bytes, childrenOf(bytes), found, 0);
  return found;
}

export async function sniffAudio(source: ByteSource): Promise<SniffVerdict> {
  const found: Found = { descriptions: 0, codecs: new Set(), handlers: new Set(), boxes: 0 };
  try {
    let offset = 0;
    let held = 0;
    for (let index = 0; offset < source.size; index += 1) {
      if (index >= MAX_TOP_LEVEL_BOXES) return 'not_audio';
      const header = headerAt(await source.read(offset, 32), offset, source.size);
      if (index === 0 && header.type !== 'ftyp') return 'not_audio';
      if (COMPRESSED_MOVIE.has(header.type)) return 'not_audio';
      if (TOP_LEVEL_READ.has(header.type)) {
        // The box, header included, so the walk sees it as the box it is.
        held += header.size;
        if (held > MAX_CONTAINER_BYTES) return 'not_audio';
        const bytes = await source.read(offset, header.size);
        if (bytes.length !== header.size) return 'unreadable';
        if (holdsCompressedMovie(bytes)) return 'not_audio';
        walk(bytes, [{ ...header, start: 0 }], found, 0);
      }
      offset += header.size;
    }
    return verdictOf(found);
  } catch (error) {
    return error instanceof Malformed ? 'not_audio' : 'unreadable';
  }
}
