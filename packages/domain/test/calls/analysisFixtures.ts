import type { CallTranscriptUtterance } from '@fss/contracts';
import { CALL_ANALYSIS_PROMPT_VERSION, type CallAnalysisAnswer } from '../../calls/analysisModel.ts';

/** Test answers for the post-call analysis (slice 3a): an empty reading, patched per test. */

export function lines(...spoken: readonly (readonly ['Y' | 'T', string])[]): CallTranscriptUtterance[] {
  return spoken.map(([side, text], index) => ({ speaker: side === 'Y' ? 0 : 1, start: index * 5, end: index * 5 + 4, text }));
}

export function emptyAnswer(): CallAnalysisAnswer {
  return {
    reached: 'person',
    summary: 'You called them. They talked briefly.',
    facts: [],
    interest: { level: 'neutral', signals: [] },
    objections: [],
    follow_up_request: { kind: 'none', quote: '', line: 0 },
    callback: { requested: false, exact: false, phrase: '', line: 0, agreed_line: 0, day: 'none', date_text: '', time: '' },
    stop: { requested: false, scope: 'this_number', quote: '', line: 0 },
    wrong_number: { is_wrong: false, quote: '', line: 0, other_number_given: '' },
    referral: { given: false, name: '', role: '', quote: '', line: 0 },
    voicemail_left: false,
    commitments: [],
    coaching: { observation: '', lines: [] },
    prompt_version: CALL_ANALYSIS_PROMPT_VERSION,
  };
}

type Patch = { readonly [K in keyof CallAnalysisAnswer]?: CallAnalysisAnswer[K] extends object ? Partial<CallAnalysisAnswer[K]> | CallAnalysisAnswer[K] : CallAnalysisAnswer[K] };

export function answer(patch: Patch = {}): string {
  const base = emptyAnswer() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    base[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  return JSON.stringify(base);
}
