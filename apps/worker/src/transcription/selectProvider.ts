import type { TranscriptionProvider } from '@fss/domain/calls/transcription.ts';
import { readAwsTranscribeProvider, type AwsTranscribeOptions } from './awsTranscribeClient.ts';
import { readTranscriptionProvider as readDeepgramProvider, type DeepgramHttp } from './deepgramClient.ts';

/**
 * Which transcription provider the worker uses (slice C3a), from the task environment.
 *
 *   * `FSS_TRANSCRIPTION_PROVIDER=aws_transcribe` — Amazon Transcribe, the primary engine
 *     (David, 1 October 2026). Needs `FSS_CALL_AUDIO_BUCKET`, `AWS_REGION` and
 *     `FSS_NAME_PREFIX`, and no secret: the task role is the credential. Both roots set it
 *     (`infra/modules/stack`).
 *   * `FSS_TRANSCRIPTION_PROVIDER=deepgram`, or unset — Deepgram, from the `transcription`
 *     entry's key, as slice C2 built it. Kept selectable for comparison.
 *
 * Anything else is a configuration problem, named by the variable, and transcription is off.
 */
export const TRANSCRIPTION_PROVIDER_VARIABLE = 'FSS_TRANSCRIPTION_PROVIDER';
export const TRANSCRIPTION_PROVIDER_CHOICES = ['aws_transcribe', 'deepgram'] as const;

export function readSelectedTranscriptionProvider(
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly deepgramHttp?: DeepgramHttp | undefined;
    readonly aws?: Omit<AwsTranscribeOptions, 'bucket' | 'region' | 'jobPrefix'> | undefined;
  } = {},
): { readonly provider: TranscriptionProvider | null; readonly problem: string | null } {
  const chosen = environment[TRANSCRIPTION_PROVIDER_VARIABLE]?.trim() ?? '';
  if (chosen === 'aws_transcribe') return readAwsTranscribeProvider(environment, options.aws ?? {});
  if (chosen === '' || chosen === 'deepgram') {
    return readDeepgramProvider(environment, options.deepgramHttp === undefined ? {} : { http: options.deepgramHttp });
  }
  return { provider: null, problem: TRANSCRIPTION_PROVIDER_VARIABLE };
}
