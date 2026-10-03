import { deflateSync } from 'node:zlib';

/**
 * M4 verification finding A, synthetic: an M4A whose `moov` shows one sound track and also
 * holds a compressed movie header — `cmov{ dcom 'zlib', cmvd(u32 length, zlib(moov)) }` — whose
 * inflated `moov` describes its samples as `avc1`. A player inflates it and finds video; the
 * audio check must refuse it without inflating anything.
 */

export const mp4Box = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
const fullBox = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => mp4Box(type, Buffer.alloc(4), body);
const hdlr = (handler: string): Buffer => mp4Box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(13));
export const sampleEntry = (codec: string, ...children: Buffer[]): Buffer => mp4Box(codec, Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(20), ...children);
const stsd = (entry: Buffer): Buffer => mp4Box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry);
/** A track whose handler is `handler` and whose one sample entry is `entry`. */
export const mp4Track = (handler: string, entry: Buffer): Buffer =>
  mp4Box('trak', fullBox('tkhd', Buffer.alloc(80)), mp4Box('mdia', fullBox('mdhd', Buffer.alloc(20)), hdlr(handler), mp4Box('minf', mp4Box('stbl', stsd(entry), fullBox('stts', Buffer.alloc(4)), fullBox('stsz', Buffer.alloc(8))))));
export const mvhd = (): Buffer => fullBox('mvhd', Buffer.alloc(96));
const ftyp = mp4Box('ftyp', Buffer.from('M4A ', 'latin1'), Buffer.alloc(4), Buffer.from('M4A isommp42', 'latin1'));
const mdat = mp4Box('mdat', Buffer.from('synthetic media bytes'));

/** The compressed movie header: zlib of a `moov` whose one track's sample entry is `avc1`. */
export function compressedVideoMovie(): Buffer {
  const hidden = mp4Box('moov', mvhd(), mp4Track('vide', sampleEntry('avc1')));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(hidden.length, 0);
  return mp4Box('cmov', mp4Box('dcom', Buffer.from('zlib', 'latin1')), mp4Box('cmvd', length, deflateSync(hidden)));
}

export const m4a = (...boxes: Buffer[]): Buffer => Buffer.concat([ftyp, mdat, ...boxes]);

/** Finding A's file: `moov{ mvhd, cmov{…video…}, <the visible mp4a trak> }`. */
export const cmovPlusAudio = (): Buffer => m4a(mp4Box('moov', mvhd(), compressedVideoMovie(), mp4Track('soun', sampleEntry('mp4a'))));
