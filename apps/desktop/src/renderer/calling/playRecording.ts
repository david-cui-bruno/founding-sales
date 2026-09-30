/**
 * Play a recording the API proxied (slice C1), without a media URL.
 *
 * The renderer's CSP has no `blob:` or `data:` source and `media-src` names only
 * Twilio's SDK hosts, so an `<audio src>` of the bytes would be refused — as it should
 * be. The Web Audio API decodes bytes already in memory and plays them without loading
 * anything, which is all playback needs.
 */

export interface Playback {
  stop(): void;
  readonly ended: Promise<void>;
}

export async function playRecording(audioBase64: string, context: AudioContext = new AudioContext()): Promise<Playback> {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const buffer = await context.decodeAudioData(bytes.buffer);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const ended = new Promise<void>(resolve => {
    source.onended = () => {
      resolve();
      void context.close();
    };
  });
  source.start();
  return {
    stop: () => {
      source.stop();
    },
    ended,
  };
}
