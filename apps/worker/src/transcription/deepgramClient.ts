import { CALL_RECORDING_MAX_BYTES, RECORDING_CHANNEL_ROLES, type CallTranscriptUtterance } from '@fss/contracts';
import { boundedBody } from '@fss/domain/calls/twilioRecording.ts';
import type { TranscriptionOutcome, TranscriptionPricing, TranscriptionProvider } from '@fss/domain/calls/transcription.ts';
import { TRANSCRIPTION_SECRET_VARIABLE, readTranscriptionSecret } from '@fss/domain/calls/transcriptionSecret.ts';

/**
 * Deepgram's pre-recorded speech-to-text, over `fetch` (slice C2). The only request this
 * worker makes to Deepgram, and only from chunk 3 of `call.transcribe`.
 *
 * Built from Deepgram's public documentation, and nothing else (read 30 September 2026):
 *
 *   * https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded —
 *     `POST https://api.deepgram.com/v1/listen`; `Authorization: Token <API_KEY>`; the
 *     audio's own bytes as the body with its content type; the query parameters `model`,
 *     `multichannel`, `punctuate`, `utterances` and `mip_opt_out`; the answer
 *     `{ metadata: { request_id, duration, channels, models }, results: { utterances: [{
 *     start, end, confidence, channel, transcript }] } }`;
 *   * https://developers.deepgram.com/docs/multichannel (read 1 October 2026) —
 *     `multichannel=true` transcribes each channel of the audio independently, and each
 *     utterance says which `channel` it came from.
 *
 * ## Channels, not diarization (slice C3a)
 *
 * The recording is Twilio's dual-channel one, a leg per channel, so who said what is the
 * channel: `RECORDING_CHANNEL_ROLES` (0 you, 1 them). C2 asked for `diarize=true` and
 * numbered voices; that is no longer requested, and a `speaker` in the answer is ignored —
 * a diarizer's number never becomes a role. The transcript is stored as model
 * `nova-3-multichannel`, so the firm page can tell it from C2's diarized rows. Deepgram's
 * pricing page does not say whether multichannel audio is billed per channel, so it is
 * reserved as though it were (`DEEPGRAM_PRICING`, two billed channels): the bound is
 * never below the bill. Deepgram stays for comparison; Amazon Transcribe is primary.
 *   * https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program —
 *     `mip_opt_out=true`: the request is kept only as long as processing it takes and is
 *     not used to improve Deepgram's models. Sent on every request;
 *   * https://developers.deepgram.com/docs/language — `language` defaults to `en`, which
 *     is what this sends (by leaving it out) and what the transcript records;
 *   * https://developers.deepgram.com/docs/errors — the error statuses (400, 401, 402, 403,
 *     404, 422, 429), each a request Deepgram refused rather than processed;
 *   * https://deepgram.com/pricing — Nova-3 pre-recorded, pay as you go, $0.0043 a minute
 *     (the `call_transcription.unitPriceMicros` default, 4 300).
 *
 * ## Bounded
 *
 * The audio is at most `CALL_RECORDING_MAX_BYTES` (a half-hour dual-channel MP3 is far
 * below it); the request has `DEEPGRAM_REQUEST_TIMEOUT_MS`; the answer is read to at most
 * `MAX_ANSWER_BYTES`. A 4xx is `refused` (not processed, not billed). A timeout, a network
 * failure, a 5xx or an answer that is not the documented shape is `ambiguous`: Deepgram may
 * have processed the audio, so the attempt is estimated before the one bounded retry.
 *
 * ## The key
 *
 * It lives in this closure and nowhere else: not on the returned object, not in an
 * outcome code, not in a log line. A failure is a word of ours (`deepgram_http_401`,
 * `deepgram_unreachable`), never the response body or the transport's own message.
 */

export const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
export const DEEPGRAM_MODEL = 'nova-3';
/** The ledger's and the reservations' `provider_key` for this provider and model. */
export const DEEPGRAM_PROVIDER_KEY = `deepgram.${DEEPGRAM_MODEL}`;
/** `call_transcripts.model`: channel-labelled (`CHANNEL_LABELLED_TRANSCRIPTS`), unlike C2's `nova-3` rows. */
export const DEEPGRAM_TRANSCRIPT_MODEL = `${DEEPGRAM_MODEL}-multichannel`;
/** The setting's price a minute, for each of the two channels (see the module's note). */
export const DEEPGRAM_PRICING: TranscriptionPricing = Object.freeze({ unitPriceMicros: null, billedChannels: 2, perSecondMinimumSeconds: null });
/** The query every request carries, in this order. */
export const DEEPGRAM_QUERY: readonly (readonly [string, string])[] = Object.freeze([
  ['model', DEEPGRAM_MODEL],
  ['multichannel', 'true'],
  ['punctuate', 'true'],
  ['utterances', 'true'],
  ['mip_opt_out', 'true'],
]);
/** Long enough for a half-hour call to be processed; the job's lease is longer. */
export const DEEPGRAM_REQUEST_TIMEOUT_MS = 120_000;
/** A transcript of a four-hour call is well under this. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** The longest single utterance kept, in characters. */
const MAX_UTTERANCE_CHARACTERS = 4_000;

export type DeepgramHttp = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

const finiteAtLeastZero = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Channel 0 → you, 1 → them (`RECORDING_CHANNEL_ROLES`); any other value null. */
function speakerOfDeepgramChannel(channel: unknown): number | null {
  if (channel === RECORDING_CHANNEL_ROLES.you) return RECORDING_CHANNEL_ROLES.you;
  if (channel === RECORDING_CHANNEL_ROLES.them) return RECORDING_CHANNEL_ROLES.them;
  return null;
}

/** The documented answer, or null when it is not that shape. */
export function parseDeepgramAnswer(body: unknown): { readonly durationSeconds: number; readonly utterances: CallTranscriptUtterance[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const top = body as Record<string, unknown>;
  const metadata = typeof top['metadata'] === 'object' && top['metadata'] !== null ? (top['metadata'] as Record<string, unknown>) : null;
  const results = typeof top['results'] === 'object' && top['results'] !== null ? (top['results'] as Record<string, unknown>) : null;
  const duration = finiteAtLeastZero(metadata?.['duration']);
  if (duration === null || results === null) return null;
  // The two legs, verified where the answer says how many channels it heard.
  if (metadata?.['channels'] !== undefined && metadata['channels'] !== 2) return null;
  const raw = results['utterances'];
  if (raw !== undefined && !Array.isArray(raw)) return null;
  const utterances: CallTranscriptUtterance[] = [];
  for (const entry of (raw ?? []) as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const item = entry as Record<string, unknown>;
    const start = finiteAtLeastZero(item['start']);
    const end = finiteAtLeastZero(item['end']);
    const text = item['transcript'];
    // The channel is the speaker; a diarizer's `speaker`, if any, is never read.
    const speaker = speakerOfDeepgramChannel(item['channel']);
    if (start === null || end === null || typeof text !== 'string' || speaker === null) return null;
    utterances.push({ speaker, start, end: Math.max(start, end), text: text.slice(0, MAX_UTTERANCE_CHARACTERS) });
  }
  return { durationSeconds: duration, utterances };
}

export function deepgramTranscription(options: { readonly apiKey: string; readonly http?: DeepgramHttp; readonly timeoutMs?: number }): TranscriptionProvider {
  const { apiKey } = options;
  const http: DeepgramHttp = options.http ?? (async (url, init) => await fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEEPGRAM_REQUEST_TIMEOUT_MS;
  return {
    providerKey: DEEPGRAM_PROVIDER_KEY,
    provider: 'deepgram',
    model: DEEPGRAM_TRANSCRIPT_MODEL,
    pricing: DEEPGRAM_PRICING,
    transcribe: async (input): Promise<TranscriptionOutcome> => {
      if (input.audio.byteLength === 0 || input.audio.byteLength > CALL_RECORDING_MAX_BYTES) {
        return { ok: false, kind: 'refused', code: 'audio_size' };
      }
      const url = new URL(DEEPGRAM_LISTEN_URL);
      for (const [name, value] of DEEPGRAM_QUERY) url.searchParams.set(name, value);
      let response: Response;
      try {
        response = await http(url.toString(), {
          method: 'POST',
          headers: {
            authorization: `Token ${apiKey}`,
            'content-type': input.contentType,
            accept: 'application/json',
          },
          body: new Uint8Array(input.audio),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Sent or not, nobody knows: the audio may have been processed.
        return { ok: false, kind: 'ambiguous', code: 'deepgram_unreachable' };
      }
      if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: 'refused', code: `deepgram_http_${String(response.status)}` };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: 'ambiguous', code: `deepgram_http_${String(response.status)}` };
      }
      let parsed: ReturnType<typeof parseDeepgramAnswer> = null;
      try {
        const bytes = await boundedBody(response, MAX_ANSWER_BYTES);
        if (bytes !== null) parsed = parseDeepgramAnswer(JSON.parse(bytes.toString('utf8')) as unknown);
      } catch {
        parsed = null;
      }
      if (parsed === null) return { ok: false, kind: 'ambiguous', code: 'deepgram_answer_unreadable' };
      return { ok: true, durationSeconds: parsed.durationSeconds, language: 'en', utterances: parsed.utterances };
    },
  };
}

/**
 * The worker's transcription provider, from the task environment's `transcription` entry,
 * or null with the reason by field name. Without a key transcription is off; that is a
 * configuration, not a failure.
 */
export function readTranscriptionProvider(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly http?: DeepgramHttp } = {},
): { readonly provider: TranscriptionProvider | null; readonly problem: string | null } {
  const reading = readTranscriptionSecret(environment[TRANSCRIPTION_SECRET_VARIABLE]);
  if (!reading.ok) return { provider: null, problem: reading.problem };
  return {
    provider: deepgramTranscription({ apiKey: reading.apiKey, ...(options.http === undefined ? {} : { http: options.http }) }),
    problem: null,
  };
}
