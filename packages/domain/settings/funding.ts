/**
 * Who pays for each paid provider (slice C3a, David's decision of 1 October 2026).
 *
 * Amazon Transcribe and Claude through Amazon Bedrock (slice BR1) are paid from the AWS
 * account's credits; every other provider is paid in cash. The two are tracked apart: the month-to-date cash ceiling (`cashCeiling.ts`) and
 * every ceiling that reads `research/ledger.ts`'s `readSpend` count cash only, and
 * Settings shows "credits this month" on its own line. A kind's own daily ceiling is not
 * about who pays: the transcription day's cap (`calls/transcription.ts`,
 * `transcriptionSpentCents`) counts every transcription reservation, Transcribe's included.
 *
 * A provider is known by its kind: the part of its `provider_key` before the first dot
 * (`aws_transcribe.standard` → `aws_transcribe`, `twilio.voice` → `twilio`). A kind this
 * table does not name is cash, so a new provider is counted against the ceiling until
 * somebody decides otherwise — the direction in which a mistake costs nothing.
 */

export type ProviderFunding = 'cash' | 'credits';

export const PROVIDER_KIND_FUNDING: Readonly<Record<string, ProviderFunding>> = Object.freeze({
  aws_transcribe: 'credits',
  twilio: 'cash',
  deepgram: 'cash',
  anthropic_extraction: 'cash',
  anthropic_classifier: 'cash',
  // Slice C3b: after-call summaries, cash like every direct Anthropic API call.
  anthropic_call_summary: 'cash',
  // Slice BR1: every Claude call made through Amazon Bedrock — `aws_bedrock.classifier`,
  // `aws_bedrock.call_summary`, `aws_bedrock.extraction` (`classification/modelTransport.ts`).
  // Cost Explorer shows AWS credits applied to Claude on Bedrock (1 Sep – 2 Oct 2026).
  aws_bedrock: 'credits',
});

/** The kind a `provider_key` names: everything before its first dot. */
export function providerKind(providerKey: string): string {
  const dot = providerKey.indexOf('.');
  return dot === -1 ? providerKey : providerKey.slice(0, dot);
}

export function providerFunding(providerKey: string): ProviderFunding {
  return PROVIDER_KIND_FUNDING[providerKind(providerKey)] ?? 'cash';
}

/** The kinds paid from credits, for SQL: `split_part(provider_key, '.', 1) = ANY($n)`. */
export const CREDIT_FUNDED_PROVIDER_KINDS: readonly string[] = Object.freeze(
  Object.entries(PROVIDER_KIND_FUNDING)
    .filter(([, funding]) => funding === 'credits')
    .map(([kind]) => kind)
    .sort(),
);
