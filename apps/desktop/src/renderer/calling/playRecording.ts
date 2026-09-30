/**
 * Play a recording the API proxied (slice C1).
 *
 * The bytes become a `blob:` URL played by an `<audio>` element, so the page holds about
 * the compressed size — an MP3 — rather than the whole call decoded to PCM, which for a
 * long call is gigabytes (review of C1, fold 1, finding 11). `media-src` admits `blob:`
 * for exactly this and nothing else admits it. The URL is revoked when playback stops,
 * ends, fails, or the history leaves the screen.
 */

export interface Playback {
  stop(): void;
  readonly ended: Promise<void>;
}

export interface PlaybackPorts {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  audio(url: string): HTMLAudioElement;
}

const browserPorts = (): PlaybackPorts => ({
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => {
    URL.revokeObjectURL(url);
  },
  audio: url => new Audio(url),
});

export async function playRecording(
  audioBase64: string,
  contentType: string = 'audio/mpeg',
  ports: PlaybackPorts = browserPorts(),
): Promise<Playback> {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = ports.createObjectURL(new Blob([bytes], { type: contentType }));
  const audio = ports.audio(url);
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    audio.removeAttribute('src');
    ports.revokeObjectURL(url);
  };
  let settle: () => void = () => undefined;
  const ended = new Promise<void>(resolve => {
    settle = resolve;
  });
  const done = (): void => {
    revoke();
    settle();
  };
  audio.addEventListener('ended', done);
  audio.addEventListener('error', done);
  try {
    await audio.play();
  } catch (error: unknown) {
    done();
    throw error;
  }
  return {
    stop: () => {
      audio.pause();
      done();
    },
    ended,
  };
}
