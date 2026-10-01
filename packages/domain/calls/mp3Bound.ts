/**
 * The duration bound of a transcription, made real (slice C2, review fold 1, P1).
 *
 * A transcription is reserved at the recording's minutes before anything is uploaded, and
 * settled at the provider's measure of what it heard. For the settlement never to pass
 * what was cleared, the provider must not be sent more audio than was priced: this
 * reads Twilio's MP3 frame by frame and keeps only the frames that fit inside the bound,
 * so what Deepgram is given is at most the reserved minutes long whatever Twilio's
 * duration field said. Telephony does the same with `<Dial timeLimit>` and research with
 * its exact token count before the call.
 *
 * MPEG audio Layer III only (Twilio's recordings): MPEG-1, MPEG-2 and MPEG-2.5, with
 * their bit-rate and sample-rate tables (ISO/IEC 11172-3 and 13818-3). A leading ID3v2
 * tag is kept; a trailing ID3v1 tag ends the walk. Anything else that is not a frame
 * header — free-format, a reserved index, bytes that are not MPEG audio — makes the
 * recording unreadable (`null`), and nothing is uploaded: a bound that guessed would not
 * be a bound.
 */

const BITRATES_KBPS = {
  /** MPEG-1 Layer III. */
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  /** MPEG-2 and MPEG-2.5 Layer III. */
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
} as const;

const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  3: [44_100, 48_000, 32_000], // MPEG-1
  2: [22_050, 24_000, 16_000], // MPEG-2
  0: [11_025, 12_000, 8_000], // MPEG-2.5
};

interface Frame {
  readonly length: number;
  readonly seconds: number;
}

/** The Layer III frame whose header starts at `at`, or null when it is not one. */
function frameAt(bytes: Uint8Array, at: number): Frame | null {
  if (at + 4 > bytes.length) return null;
  const b1 = bytes[at + 1] ?? 0;
  const b2 = bytes[at + 2] ?? 0;
  if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return null; // reserved version; not Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const kbps = (version === 3 ? BITRATES_KBPS.mpeg1 : BITRATES_KBPS.mpeg2)[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
  if (kbps === 0 || sampleRate === undefined) return null;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  if (length < 4) return null;
  return { length, seconds: samples / sampleRate };
}

/** The length of a leading ID3v2 tag, or 0. */
function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = (((bytes[6] ?? 0) & 0x7f) << 21) | (((bytes[7] ?? 0) & 0x7f) << 14) | (((bytes[8] ?? 0) & 0x7f) << 7) | ((bytes[9] ?? 0) & 0x7f);
  const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

export interface BoundedAudio {
  /** The audio to upload: the leading tag and every whole frame that fits the bound. */
  readonly bytes: Buffer;
  /** The duration of `bytes`, from its frames. */
  readonly seconds: number;
  /** Whether frames past the bound were left out. */
  readonly trimmed: boolean;
}

/**
 * `audio` cut to at most `maxSeconds`, at a frame boundary; null when it is not readable
 * as MPEG Layer III audio or holds no frame.
 */
export function boundMp3(audio: Buffer, maxSeconds: number): BoundedAudio | null {
  const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  let at = id3v2Length(bytes);
  if (at > bytes.length) return null;
  let seconds = 0;
  let frames = 0;
  let trimmed = false;
  while (at < bytes.length) {
    // A trailing ID3v1 tag ("TAG", 128 bytes) is where the audio ends.
    if (bytes.length - at === 128 && bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47) break;
    const frame = frameAt(bytes, at);
    if (frame === null || at + frame.length > bytes.length) return null;
    if (seconds + frame.seconds > maxSeconds) {
      trimmed = true;
      break;
    }
    seconds += frame.seconds;
    frames += 1;
    at += frame.length;
  }
  if (frames === 0) return null;
  return { bytes: audio.subarray(0, at), seconds, trimmed };
}
