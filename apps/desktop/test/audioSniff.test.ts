import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffAudio } from '../src/main/recordings/audioSniff.ts';
import { nodeRecordingFs } from '../src/main/recordings/files.ts';

/**
 * Review M4R (minor): the extension is not trusted. An `.m4a` is uploaded only when its boxes
 * say audio-only MP4: `ftyp` first, and in `moov` a `soun` handler and no `vide` one. Synthetic
 * boxes only: no media.
 */

const box = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const hdlr = (handler: string): Buffer => box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12)]));
const trak = (handler: string): Buffer => box('trak', box('mdia', hdlr(handler)));
const ftyp = (brand: string): Buffer => box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from(`${brand}isom`, 'latin1')]));
const mdat = box('mdat', Buffer.from('synthetic media bytes, never read'));

const source = (bytes: Buffer) => ({
  size: bytes.length,
  read: async (offset: number, length: number) => await Promise.resolve(bytes.subarray(offset, offset + length)),
});

describe('the audio sniff', () => {
  it('an M4A with one sound track is audio, the moov before or after the media', async () => {
    expect(await sniffAudio(source(Buffer.concat([ftyp('M4A '), box('moov', trak('soun')), mdat])))).toBe('audio');
    expect(await sniffAudio(source(Buffer.concat([ftyp('M4A '), mdat, box('moov', trak('soun'))])))).toBe('audio');
    expect(await sniffAudio(source(Buffer.concat([ftyp('isom'), mdat, box('moov', Buffer.concat([trak('soun'), trak('soun')]))])))).toBe('audio');
  });

  it('a video renamed .m4a is not audio: a video track anywhere, no sound track, no ftyp, a broken walk', async () => {
    expect(await sniffAudio(source(Buffer.concat([ftyp('isom'), box('moov', Buffer.concat([trak('vide'), trak('soun')])), mdat])))).toBe('not_audio');
    expect(await sniffAudio(source(Buffer.concat([ftyp('isom'), box('moov', trak('vide')), mdat])))).toBe('not_audio');
    expect(await sniffAudio(source(Buffer.concat([box('free', Buffer.alloc(4)), box('moov', trak('soun'))])))).toBe('not_audio');
    expect(await sniffAudio(source(Buffer.concat([ftyp('M4A '), mdat])))).toBe('not_audio');
    const truncated = Buffer.concat([ftyp('M4A '), box('moov', trak('soun'))]).subarray(0, 40);
    expect(await sniffAudio(source(truncated))).toBe('not_audio');
    expect(await sniffAudio(source(Buffer.from('ID3 an mp3 is not an mp4')))).toBe('not_audio');
  });

  it('a read that fails is unreadable', async () => {
    expect(await sniffAudio({ size: 100, read: async () => await Promise.reject(new Error('EIO')) })).toBe('unreadable');
  });

  it('the node port reads a real file’s boxes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fss-sniff-'));
    try {
      const audio = join(directory, 'audioSynthetic1.m4a');
      const video = join(directory, 'audioRenamedVideo1.m4a');
      await writeFile(audio, Buffer.concat([ftyp('M4A '), mdat, box('moov', trak('soun'))]));
      await writeFile(video, Buffer.concat([ftyp('isom'), mdat, box('moov', Buffer.concat([trak('soun'), trak('vide')]))]));
      expect(await nodeRecordingFs.sniff(audio)).toBe('audio');
      expect(await nodeRecordingFs.sniff(video)).toBe('not_audio');
      expect(await nodeRecordingFs.sniff(join(directory, 'absent.m4a'))).toBe('unreadable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
