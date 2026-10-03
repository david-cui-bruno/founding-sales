import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlersAreAudioOnly, sniffAudio, trackHandlers } from '../src/main/recordings/audioSniff.ts';
import { nodeRecordingFs } from '../src/main/recordings/files.ts';

/**
 * M4 reset, R3: the audio check walks the ISO-BMFF box tree (`moov > trak > mdia > hdlr`),
 * never searches for look-alike bytes. Synthetic box trees only, shaped as an encoder writes
 * them (mvhd; trak with tkhd, mdia with mdhd, hdlr, minf), and the reviewer's two crafted
 * files (M4F finding 3) rebuilt the way `mutate_mp4.py` built them: a video `hdlr` with an
 * extended-size header, and a video-only file with a fake sound handler inside a `free` box.
 */

const box = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
/** The same box with ISO-BMFF's extended-size header: size 1, then a 64-bit largesize. */
const largeBox = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
};
const fullBox = (type: string, body: Buffer): Buffer => box(type, Buffer.alloc(4), body);
/** hdlr: version/flags, pre_defined, handler_type, reserved ×3, an empty name. */
const hdlrBody = (handler: string): Buffer => Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0')]);
const hdlr = (handler: string): Buffer => box('hdlr', hdlrBody(handler));
const minf = (): Buffer => box('minf', fullBox('smhd', Buffer.alloc(4)), box('dinf', fullBox('dref', Buffer.alloc(4))), box('stbl'));
const trak = (handler: string, handlerBox: Buffer = hdlr(handler)): Buffer =>
  box('trak', fullBox('tkhd', Buffer.alloc(80)), box('mdia', fullBox('mdhd', Buffer.alloc(20)), handlerBox, minf()));
const ftyp = (brand: string): Buffer => box('ftyp', Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from(`${brand}isommp42`, 'latin1'));
const mvhd = (): Buffer => fullBox('mvhd', Buffer.alloc(96));
const mdat = box('mdat', Buffer.from('synthetic media bytes, never read hdlr\0\0\0\0\0\0\0\0soun'));

const source = (bytes: Buffer) => ({
  size: bytes.length,
  read: async (offset: number, length: number) => await Promise.resolve(bytes.subarray(offset, offset + length)),
});
const sniff = async (bytes: Buffer) => await sniffAudio(source(bytes));

describe('R3: the ISO-BMFF walk', () => {
  it('a synthetic M4A with one sound track is audio, moov before or after the media; a largesize mdat and a hint track are fine', async () => {
    expect(await sniff(Buffer.concat([ftyp('M4A '), box('moov', mvhd(), trak('soun')), mdat]))).toBe('audio');
    expect(await sniff(Buffer.concat([ftyp('M4A '), box('free'), mdat, box('moov', mvhd(), trak('soun'))]))).toBe('audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), largeBox('mdat', Buffer.from('bytes')), box('moov', mvhd(), trak('soun'), trak('soun'), trak('hint'))]))).toBe('audio');
    // A sound handler with an extended-size header is read at its defined offset too.
    expect(await sniff(Buffer.concat([ftyp('M4A '), box('moov', mvhd(), trak('soun', largeBox('hdlr', hdlrBody('soun'))))]))).toBe('audio');
  });

  it('the reviewer’s crafted mixed file: a video hdlr with an extended-size header beside a sound track is rejected', async () => {
    const crafted = Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('vide', largeBox('hdlr', hdlrBody('vide'))), trak('soun')), mdat]);
    expect(await sniff(crafted)).toBe('not_audio');
    expect(trackHandlers(box('moov', mvhd(), trak('vide', largeBox('hdlr', hdlrBody('vide'))), trak('soun')).subarray(8))).toEqual(['vide', 'soun']);
  });

  it('the reviewer’s crafted video-only file: a fake sound handler inside a free box (in moov, at the top, in mdat) is never read', async () => {
    const fake = box('free', Buffer.from('hdlr', 'latin1'), Buffer.alloc(8), Buffer.from('soun', 'latin1'));
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('vide', largeBox('hdlr', hdlrBody('vide'))), fake), mdat]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), fake, box('moov', mvhd(), trak('vide')), mdat]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('vide'), box('skip', hdlr('soun'))), mdat]))).toBe('not_audio');
  });

  it('rejects video, unknown handlers, a track without its handler, two moovs, no ftyp first, and a walk that does not add up', async () => {
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('vide'))]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('soun'), trak('sbtl'))]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('soun'), box('trak', box('mdia', minf())))]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('isom'), box('moov', mvhd(), trak('soun'), box('mdia', hdlr('vide'))), box('moov', trak('soun'))]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([box('free'), ftyp('M4A '), box('moov', mvhd(), trak('soun'))]))).toBe('not_audio');
    expect(await sniff(Buffer.concat([ftyp('M4A '), mdat]))).toBe('not_audio');
    const overrun = Buffer.concat([ftyp('M4A '), box('moov', mvhd(), trak('soun'))]);
    overrun.writeUInt32BE(overrun.readUInt32BE(ftyp('M4A ').length) + 50, ftyp('M4A ').length);
    expect(await sniff(overrun)).toBe('not_audio');
    const childOverrun = box('moov', mvhd(), trak('soun'));
    childOverrun.writeUInt32BE(9999, 8);
    expect(await sniff(Buffer.concat([ftyp('M4A '), childOverrun]))).toBe('not_audio');
    expect(await sniff(Buffer.from('ID3 an mp3 is not an mp4'))).toBe('not_audio');
    expect(handlersAreAudioOnly(['meta', 'text'])).toBe(false);
  });

  it('a read that fails is unreadable', async () => {
    expect(await sniffAudio({ size: 100, read: async () => await Promise.reject(new Error('EIO')) })).toBe('unreadable');
  });

  it('the node port reads a real file’s boxes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fss-sniff-'));
    try {
      const audio = join(directory, 'audioSynthetic1.m4a');
      const video = join(directory, 'audioRenamedVideo1.m4a');
      await writeFile(audio, Buffer.concat([ftyp('M4A '), mdat, box('moov', mvhd(), trak('soun'))]));
      await writeFile(video, Buffer.concat([ftyp('isom'), mdat, box('moov', mvhd(), trak('soun'), trak('vide', largeBox('hdlr', hdlrBody('vide'))))]));
      expect(await nodeRecordingFs.sniff(audio)).toBe('audio');
      expect(await nodeRecordingFs.sniff(video)).toBe('not_audio');
      expect(await nodeRecordingFs.sniff(join(directory, 'absent.m4a'))).toBe('unreadable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
