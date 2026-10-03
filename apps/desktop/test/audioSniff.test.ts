import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describe as describeBoxes, sniffAudio } from '../src/main/recordings/audioSniff.ts';
import { nodeRecordingFs } from '../src/main/recordings/files.ts';
import { cmovPlusAudio, compressedVideoMovie, m4a, mp4Box, mp4Track, mvhd as plainMvhd, sampleEntry } from './support/cmovFixture.ts';

/**
 * M4 reset R3, repaired after M4RR finding 1: the audio check decides by CODEC. The whole box
 * tree is walked; every sample entry of every `stsd` must be an allowlisted audio codec and no
 * `hdlr` anywhere may name pictures. Synthetic box trees shaped as an encoder writes them, and
 * the reviewer's fixtures rebuilt the way `reset_media.py` and `mutate_mp4.py` built them: a
 * video track nested in a second `moov`, video tracks labelled `text`, `hint` and `meta`, an
 * extended-size video `hdlr`, a fake sound handler in a `free` box.
 */

const box = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
const largeBox = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
};
const fullBox = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => box(type, Buffer.alloc(4), body);
const hdlrBody = (handler: string): Buffer => Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('\0')]);
const hdlr = (handler: string): Buffer => box('hdlr', hdlrBody(handler));
/** A sample entry: six reserved bytes, a data reference index, and a codec-shaped body. */
const entry = (codec: string): Buffer => box(codec, Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(20));
const stsd = (...codecs: string[]): Buffer => {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(codecs.length, 0);
  return box('stsd', Buffer.alloc(4), count, ...codecs.map(entry));
};
const stbl = (...codecs: string[]): Buffer => box('stbl', stsd(...codecs), fullBox('stts', Buffer.alloc(4)), fullBox('stsz', Buffer.alloc(8)));
const minf = (...codecs: string[]): Buffer => box('minf', fullBox('smhd', Buffer.alloc(4)), box('dinf', fullBox('dref', Buffer.alloc(4))), stbl(...codecs));
/** A track: its handler LABEL and its sample descriptions' CODECS, which need not agree. */
const trak = (label: string, codecs: string[] = [label === 'vide' ? 'avc1' : 'mp4a'], handlerBox: Buffer = hdlr(label)): Buffer =>
  box('trak', fullBox('tkhd', Buffer.alloc(80)), box('mdia', fullBox('mdhd', Buffer.alloc(20)), handlerBox, minf(...codecs)));
const ftyp = (brand: string): Buffer => box('ftyp', Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from(`${brand}isommp42`, 'latin1'));
const mvhd = (): Buffer => fullBox('mvhd', Buffer.alloc(96));
const mdat = box('mdat', Buffer.from('synthetic media bytes, never read hdlr\0\0\0\0\0\0\0\0soun stsd avc1'));
const udta = (): Buffer => box('udta', box('meta', Buffer.alloc(4), hdlr('mdir'), box('ilst')), Buffer.alloc(4));

const sniff = async (bytes: Buffer) =>
  await sniffAudio({ size: bytes.length, read: async (offset: number, length: number) => await Promise.resolve(bytes.subarray(offset, offset + length)) });
const file = (...boxes: Buffer[]): Buffer => Buffer.concat([ftyp('M4A '), ...boxes]);

describe('R3 by codec: what is accepted', () => {
  it('a synthetic M4A whose every sample entry is mp4a, with or without metadata, moov before or after the media', async () => {
    expect(await sniff(file(box('moov', mvhd(), trak('soun')), mdat))).toBe('audio');
    expect(await sniff(file(mdat, box('moov', mvhd(), trak('soun'), trak('soun'), udta())))).toBe('audio');
    expect(await sniff(file(largeBox('mdat', Buffer.from('bytes')), box('moov', mvhd(), trak('soun', ['mp4a'], largeBox('hdlr', hdlrBody('soun'))))))).toBe('audio');
    // QuickTime's meta is a plain container, not a FullBox.
    expect(await sniff(file(box('moov', mvhd(), trak('soun'), box('udta', box('meta', hdlr('mdir'), box('ilst'))))))).toBe('audio');
    expect(await sniff(file(box('moov', mvhd(), trak('soun', ['alac']))))).toBe('audio');
    expect(await sniff(file(box('moov', mvhd(), trak('soun', ['Opus']))))).toBe('audio');
  });
});

describe('R3 by codec: the reviewer’s fixtures and their kin are rejected (M4RR finding 1)', () => {
  it('a video track nested in a second moov', async () => {
    expect(await sniff(file(box('moov', mvhd(), trak('soun'), box('moov', trak('vide'))), mdat))).toBe('not_audio');
    expect(await sniff(file(box('moov', mvhd(), trak('soun')), box('moov', trak('vide')), mdat))).toBe('not_audio');
    expect(await sniff(file(box('moov', mvhd(), trak('soun'), box('udta', box('moov', trak('vide')))), mdat))).toBe('not_audio');
  });

  it('a video track labelled text, hint, meta or soun: its samples are avc1', async () => {
    for (const label of ['text', 'hint', 'meta', 'soun']) {
      expect(await sniff(file(box('moov', mvhd(), trak('soun'), trak(label, ['avc1'])), mdat))).toBe('not_audio');
    }
  });

  it('a picture handler anywhere, with or without an extended-size header; a fake sound handler in free changes nothing', async () => {
    expect(await sniff(file(box('moov', mvhd(), trak('vide', ['mp4a'], largeBox('hdlr', hdlrBody('vide'))), trak('soun')), mdat))).toBe('not_audio');
    const fake = box('free', Buffer.from('hdlr', 'latin1'), Buffer.alloc(8), Buffer.from('soun', 'latin1'), stsd('mp4a'));
    expect(await sniff(file(box('moov', mvhd(), trak('vide'), fake), mdat))).toBe('not_audio');
    expect(await sniff(file(fake, box('moov', mvhd(), trak('vide')), mdat))).toBe('not_audio');
  });

  it('any sample entry not on the allowlist, encrypted audio included; no stsd at all; no ftyp first', async () => {
    for (const codec of ['avc1', 'hvc1', 'mp4v', 'enca', 'samr', 'zzzz']) {
      expect(await sniff(file(box('moov', mvhd(), trak('soun', ['mp4a', codec]))))).toBe('not_audio');
    }
    expect(await sniff(file(box('moov', mvhd(), box('trak', box('mdia', hdlr('soun'))))))).toBe('not_audio');
    expect(await sniff(file(mdat))).toBe('not_audio');
    expect(await sniff(Buffer.concat([box('free'), ftyp('M4A '), box('moov', mvhd(), trak('soun'))]))).toBe('not_audio');
    expect(await sniff(Buffer.from('ID3 an mp3 is not an mp4'))).toBe('not_audio');
  });

  it('a walk that does not add up: a child past its parent, an stsd with fewer entries than it says, a truncated file', async () => {
    const overrun = box('moov', mvhd(), trak('soun'));
    overrun.writeUInt32BE(9999, 8);
    expect(await sniff(file(overrun))).toBe('not_audio');
    const short = stsd('mp4a');
    short.writeUInt32BE(2, 12);
    expect(await sniff(file(box('moov', mvhd(), box('trak', box('mdia', hdlr('soun'), box('minf', box('stbl', short)))))))).toBe('not_audio');
    const whole = file(box('moov', mvhd(), trak('soun')));
    expect(await sniff(whole.subarray(0, whole.length - 3))).toBe('not_audio');
    const huge = Buffer.alloc(16);
    huge.writeUInt32BE(1, 0);
    huge.write('moov', 4, 'latin1');
    huge.writeBigUInt64BE(2n ** 63n, 8);
    expect(await sniff(file(huge))).toBe('not_audio');
  });

  it('describe() reports every codec and handler at any depth', () => {
    const found = describeBoxes(box('moov', trak('soun'), box('moov', trak('text', ['avc1']))));
    expect([...found.codecs].sort()).toEqual(['avc1', 'mp4a']);
    expect([...found.handlers].sort()).toEqual(['soun', 'text']);
    expect(found.descriptions).toBe(2);
  });
});

describe('M4 verification finding A: a compressed movie header is refused wherever it is, never inflated', () => {
  const soundTrack = (): Buffer => mp4Track('soun', sampleEntry('mp4a'));
  const part = (type: 'dcom' | 'cmvd'): Buffer => mp4Box(type, Buffer.from('zlib', 'latin1'));

  it('the reviewer’s shape: moov{ mvhd, cmov{ dcom zlib, cmvd(zlib(moov with avc1)) }, a visible mp4a trak }', async () => {
    expect(await sniff(cmovPlusAudio())).toBe('not_audio');
    // The same file without the cmov is plain audio: the cmov alone decides.
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), soundTrack())))).toBe('audio');
  });

  it('at the top level, inside udta or meta, as a lone dcom or cmvd, or nested where the walk does not descend', async () => {
    expect(await sniff(m4a(compressedVideoMovie(), mp4Box('moov', plainMvhd(), soundTrack())))).toBe('not_audio');
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), soundTrack(), mp4Box('udta', compressedVideoMovie()))))).toBe('not_audio');
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), soundTrack(), mp4Box('meta', Buffer.alloc(4), compressedVideoMovie()))))).toBe('not_audio');
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), part('dcom'), soundTrack())))).toBe('not_audio');
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), part('cmvd'), soundTrack())))).toBe('not_audio');
    // Inside the mp4a sample entry and inside an ilst: boxes the walk does not open.
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), mp4Track('soun', sampleEntry('mp4a', compressedVideoMovie())))))).toBe('not_audio');
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), soundTrack(), mp4Box('udta', mp4Box('ilst', compressedVideoMovie())))))).toBe('not_audio');
  });

  it('the word alone, where no box could start, is not a box: a title that says cmov is still audio', async () => {
    const title = mp4Box('udta', mp4Box('\u00a9nam', Buffer.from('\xff\xff\xff\xffcmov and dcom', 'latin1')));
    expect(await sniff(m4a(mp4Box('moov', plainMvhd(), soundTrack(), title)))).toBe('audio');
  });
});

describe('the node port', () => {
  it('reads a real file’s boxes; a read that fails is unreadable', async () => {
    expect(await sniffAudio({ size: 100, read: async () => await Promise.reject(new Error('EIO')) })).toBe('unreadable');
    const directory = await mkdtemp(join(tmpdir(), 'fss-sniff-'));
    try {
      const audio = join(directory, 'audioSynthetic1.m4a');
      const video = join(directory, 'audioRenamedVideo1.m4a');
      await writeFile(audio, file(mdat, box('moov', mvhd(), trak('soun'))));
      await writeFile(video, file(mdat, box('moov', mvhd(), trak('soun'), box('moov', trak('text', ['avc1'])))));
      expect(await nodeRecordingFs.sniff(audio)).toBe('audio');
      expect(await nodeRecordingFs.sniff(video)).toBe('not_audio');
      expect(await nodeRecordingFs.sniff(join(directory, 'absent.m4a'))).toBe('unreadable');
      const compressed = join(directory, 'audioCompressedMovie1.m4a');
      await writeFile(compressed, cmovPlusAudio());
      expect(await nodeRecordingFs.sniff(compressed)).toBe('not_audio');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
