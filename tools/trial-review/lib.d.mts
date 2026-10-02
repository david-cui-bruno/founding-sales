// Types for lib.mjs, for the ops checks that test it (test/ops/trialReview.check.ts).
import type { KeyObject } from 'node:crypto';

export interface ExportPart {
  readonly v: 1;
  readonly alg: string;
  readonly exportId: string;
  readonly part: number;
  readonly of: number;
  readonly wrappedKey?: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}
export interface ReviewVerdict {
  readonly callSessionId: string;
  readonly analysisId: string;
  readonly key: string;
  readonly kind: string;
  readonly decision: string;
  readonly verdict: string;
  readonly category: string;
  readonly reason_code: string;
  readonly decision_matches_evidence: string;
}
export interface ReviewNote {
  readonly callSessionId: string;
  readonly key: string;
  readonly note: string;
}
export type ReviewCall = Readonly<Record<string, unknown>> & {
  readonly callSessionId: string;
  readonly analysis: {
    readonly analysisId: string;
    readonly proposals: readonly ({ readonly key: string; readonly kind: string } & Readonly<Record<string, unknown>>)[];
  } & Readonly<Record<string, unknown>>;
  readonly transcript: {
    readonly turns: readonly ({ readonly line: number; readonly speaker: string; readonly text: string } & Readonly<Record<string, unknown>>)[];
  } & Readonly<Record<string, unknown>>;
};

export const EXPORT_ALG: string;
export const ERROR_CODES: readonly string[];
export class ToolError extends Error {
  constructor(code: string, detail?: string);
  readonly code: string;
  readonly detail: string;
}
export function codeOf(error: unknown, fallback?: string): string;
export function pemBlockCount(pem: string): number;
export function assertPassphraseRequired(pem: string): void;
export function loadPrivateKey(pem: string, passphrase: string): KeyObject;
export const REASON_CODES: readonly string[];
export const VERDICTS: readonly string[];
export const CATEGORIES: readonly string[];
export const DECISION_MATCHES: readonly string[];
export const DECISIONS: readonly string[];
export const PROPOSAL_KINDS: readonly string[];
export const OUTPUT_SCHEMA: Readonly<Record<string, unknown>>;
export function schemaViolations(value: unknown, schema: unknown, path?: string): string[];
export function emittedStrings(...values: unknown[]): string[];
export function emittedQuoteCount(runs: TranscriptRuns, ...values: unknown[]): number;
export function partAad(part: ExportPart): Buffer;
export function foldForQuoteCheck(text: string): string;
export const QUOTE_RUN_CHARACTERS: number;
export const REVIEW_MODEL: { readonly inferenceProfileId: string; readonly foundationModelId: string; readonly region: string; readonly profile: string };
export const REVIEW_PRICE: { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };
export const REVIEW_MAX_OUTPUT_TOKENS: number;
export const REVIEW_DEFAULT_CAP_USD: number;
export const REVIEW_REASON_MAX_CHARS: number;
export const QUOTE_RUN_WORDS: number;
export const REVIEW_SYSTEM: string;
export const VERDICT_SCHEMA: Readonly<Record<string, unknown>>;
export function readExportParts(text: string): ExportPart[];
export function decryptExport(parts: readonly ExportPart[], privateKey: KeyObject): unknown;
export function callsOf(exported: unknown): ReviewCall[];
export function reviewInputOf(call: ReviewCall): unknown;
export function reviewRequestOf(call: ReviewCall): Record<string, unknown>;
export function inputTokenBound(body: string): number;
export function costUsd(inputTokens: number, outputTokens: number): number;
export function validateVerdicts(answer: unknown, call: ReviewCall): { readonly verdicts: ReviewVerdict[]; readonly notes: ReviewNote[] };
export function answerOf(response: unknown): unknown;
export interface TranscriptRuns {
  readonly words: ReadonlySet<string>;
  readonly characters: ReadonlySet<string>;
}
export function transcriptRuns(calls: readonly ReviewCall[]): TranscriptRuns;
export function quotedRunCount(text: string, runs: TranscriptRuns): number;
export function reviewCalls(input: {
  readonly calls: readonly ReviewCall[];
  readonly invoke: (modelId: string, body: string) => Promise<unknown>;
  readonly capUsd?: number;
  readonly log?: (line: string) => void;
}): Promise<{ readonly verdicts: ReviewVerdict[]; readonly notes: ReviewNote[]; readonly spentUsd: number; readonly stoppedAtCap: boolean; readonly reviewed: number }>;
export function verdictTable(verdicts: readonly ReviewVerdict[]): string;
