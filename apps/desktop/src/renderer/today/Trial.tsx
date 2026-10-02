import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { CALL_TRIAL_UNCHANGED_BAR, type CallAnalysisExclusionReason, type CallProposal, type CallTrialResponse, type CallTrialSample } from '@fss/contracts';
import { Block, Chip, Label } from '../v2/parts.tsx';
import { startsTicked } from './afterCallModel.ts';
import { acceptanceWord } from './Recap.tsx';

/**
 * Today › Overview › Trial (slice S3T; David's rules of 2 October 2026). A read: the 10-call
 * shadow trial since the 3a release, from `GET /calls/trial`.
 *
 *   * "n of 10 answered calls analysed, since 2 Oct";
 *   * per type: unchanged, edited, declined, bypassed, unresolved, and the share applied
 *     unchanged, or "too few" below five decided; a "starts ticked" marker on the types whose
 *     suggestions start ticked in the after-call block (the desktop's own `startsTicked`,
 *     asked of the server's sample), because "unchanged" there is weaker evidence;
 *   * the calls that do not count, by reason, each expandable to its list;
 *   * every incorrect stop or deal suggestion.
 *
 * Hidden when the read does not answer (an API before S3T answers 404).
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

export const EXCLUSION_WORDS: Readonly<Record<CallAnalysisExclusionReason, string>> = Object.freeze({
  not_answered: 'Not answered',
  answered_at_missing: 'Answered by provider status only (no answer recorded)',
  not_terminal: 'Still in progress',
  no_recording: 'No recording',
  too_short: 'Too short',
  transcription_off: 'Transcription was off',
  transcription_unconfigured: 'No transcription worker took it',
  transcription_failed: 'Transcription failed',
  not_channel_labelled: 'Older transcript (not channel-labelled)',
  summary_path: 'Older summary path',
});

/** "2 Oct": the day an instant falls on, here. */
export function shortDay(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant;
  return `${String(at.getDate())} ${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(at)}`;
}

/**
 * The sample as the suggestion `startsTicked` reads: its kind, its mode and (for an outcome)
 * its value. The trial read carries nothing more (no quotes), and the rule reads nothing more;
 * a change to `startsTicked` that reads another field must widen `callTrialSampleSchema`.
 */
export function sampleAsProposal(sample: CallTrialSample): CallProposal {
  return { key: sample.kind, kind: sample.kind, mode: sample.mode, reason: '', params: sample.outcome === null ? {} : { outcome: sample.outcome } } as unknown as CallProposal;
}

/** Whether a type's suggestions start ticked: the desktop's own rule, asked of the sample. */
export function typeStartsTicked(type: CallTrialResponse['types'][number]): boolean {
  return type.applySample !== null && startsTicked(sampleAsProposal(type.applySample));
}

export function exclusionWord(reason: CallAnalysisExclusionReason, minimumSeconds: number): string {
  return reason === 'too_short' ? `${EXCLUSION_WORDS.too_short} (recording under ${String(minimumSeconds)} s)` : EXCLUSION_WORDS[reason];
}

const seconds = (value: number | null): string => (value === null ? '–' : `${String(value)} s`);

function TypeRow({ type, minimumDecided }: { readonly type: CallTrialResponse['types'][number]; readonly minimumDecided: number }): JSX.Element {
  const decided = type.unchanged + type.edited + type.declined + type.bypassed;
  const ticked = typeStartsTicked(type);
  const corrected = type.correctedOriginalError + type.correctedNewInformation;
  const share = type.acceptedUnchangedShare;
  return (
    <tr data-testid="trial-type" data-type={type.type} data-insufficient={type.insufficient} className="border-b border-border last:border-b-0">
      <td className="py-1.5 pr-2">
        <span className="flex flex-wrap items-center gap-1.5">
          {acceptanceWord(type.type)}
          {ticked ? (
            <Chip data-testid="trial-ticked" tone="outline" title="These suggestions start ticked, so “unchanged” is weaker evidence">
              starts ticked
            </Chip>
          ) : null}
        </span>
        {corrected > 0 ? (
          <span data-testid="trial-corrected" className="block text-xs text-muted-foreground">
            corrected later: {type.correctedOriginalError} model error, {type.correctedNewInformation} new information
          </span>
        ) : null}
      </td>
      <td className="tabular px-1 text-right">{type.unchanged}</td>
      <td className="tabular px-1 text-right">{type.edited}</td>
      <td className="tabular px-1 text-right">{type.declined}</td>
      <td className="tabular px-1 text-right">{type.bypassed}</td>
      <td className="tabular px-1 text-right">{type.undecided}</td>
      <td data-testid="trial-share" className="tabular pl-1 text-right whitespace-nowrap">
        {type.insufficient ? (
          <span className="text-xs text-muted-foreground" title={`${String(decided)} of ${String(minimumDecided)} decided`}>
            too few
          </span>
        ) : (
          <span className={share !== null && share >= CALL_TRIAL_UNCHANGED_BAR ? '' : 'text-warn-ink'}>{Math.round((share ?? 0) * 100)}%</span>
        )}
      </td>
    </tr>
  );
}

export function TrialSection({ trial }: { readonly trial: CallTrialResponse }): JSX.Element {
  const { progress, analysis } = trial;
  const sessionsOf = (reason: CallAnalysisExclusionReason) => trial.excluded.sessions.filter(row => row.reason === reason);
  return (
    <Block data-testid="trial" className="py-0">
      <Label>Trial</Label>
      <p data-testid="trial-progress" className="text-sm">
        {progress.analysed} of {trial.target} answered calls analysed, since {shortDay(trial.since)}
      </p>
      <p data-testid="trial-funnel" className="text-xs text-muted-foreground">
        {progress.answered} answered · {progress.eligible} eligible · {progress.fullyDecided} fully decided
        {analysis.pending > 0 ? ` · ${String(analysis.pending)} pending` : ''}
        {analysis.held > 0 ? ` · ${String(analysis.held)} held` : ''}
        {analysis.failed > 0 ? ` · ${String(analysis.failed)} failed (${analysis.failedByReason.map(entry => `${entry.reason.replace(/_/gu, ' ')} ${String(entry.count)}`).join(', ')})` : ''}
      </p>
      {trial.heldButExcluded > 0 ? (
        <p data-testid="trial-check" className="text-xs text-danger-ink">
          {trial.heldButExcluded} held for review but not analysable. This should be 0.
        </p>
      ) : null}

      {trial.types.length === 0 ? (
        <p data-testid="trial-types-empty" className="mt-2 text-sm text-muted-foreground">
          No suggestions yet.
        </p>
      ) : (
        <table data-testid="trial-types" className="mt-2 w-full border-t border-border text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-1 pr-2 text-left font-normal">Suggestion</th>
              <th className="px-1 text-right font-normal">Unchanged</th>
              <th className="px-1 text-right font-normal">Edited</th>
              <th className="px-1 text-right font-normal">Declined</th>
              <th className="px-1 text-right font-normal">Bypassed</th>
              <th className="px-1 text-right font-normal">Unresolved</th>
              <th className="pl-1 text-right font-normal">Unchanged %</th>
            </tr>
          </thead>
          <tbody>
            {trial.types.map(type => (
              <TypeRow key={type.type} type={type} minimumDecided={trial.minimumDecided} />
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        The bar: at least {Math.round(CALL_TRIAL_UNCHANGED_BAR * 100)}% unchanged, and no incorrect stop or deal suggestion. Below {trial.minimumDecided} decided a type stays manual.
      </p>

      <div data-testid="trial-incorrect" className="mt-3">
        <p className="text-xs font-medium text-muted-foreground">Incorrect stop or deal suggestions</p>
        {trial.incorrect.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col">
            {trial.incorrect.map(row => (
              <li key={`${row.analysisId}:${row.key}:${row.result}`} data-testid="trial-incorrect-row" className="text-sm">
                {row.type === 'stop' ? 'Stop' : 'Open a deal'} · {row.result} · {shortDay(row.decidedAt)}{' '}
                <span className="text-xs text-muted-foreground">call {row.callSessionId.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="trial-excluded" className="mt-3">
        <p className="text-xs font-medium text-muted-foreground">Not counted</p>
        <p data-testid="trial-unanswered" className="text-sm">
          Unanswered: {trial.unanswered.total}
          {trial.unanswered.byProviderStatus.length === 0 ? null : (
            <span className="text-xs text-muted-foreground">
              {' '}
              ({trial.unanswered.byProviderStatus.map(entry => `${entry.providerStatus} ${String(entry.count)}`).join(', ')})
            </span>
          )}
        </p>
        {trial.excluded.byReason.length === 0 ? (
          <p className="text-sm text-muted-foreground">No answered call was excluded.</p>
        ) : (
          <ul className="flex flex-col">
            {trial.excluded.byReason.map(entry => (
              <li key={entry.reason} data-testid="trial-excluded-reason" data-reason={entry.reason}>
                <details>
                  <summary className="cursor-pointer text-sm">
                    {exclusionWord(entry.reason, trial.minimumRecordingSeconds)} · {entry.count}
                  </summary>
                  <ul className="mb-1 ml-4 flex flex-col text-xs text-muted-foreground">
                    {sessionsOf(entry.reason).map(row => (
                      <li key={row.callSessionId} data-testid="trial-excluded-session">
                        {row.firmName} · {shortDay(row.occurredAt)} · call {seconds(row.callSeconds)}, recording {seconds(row.recordingSeconds)}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Block>
  );
}

/** The section, read; hidden until (and unless) the read answers. */
export function Trial(): JSX.Element | null {
  const read = useQuery({
    queryKey: ['calling.trial'],
    queryFn: async () => (await api()?.read('calling.trial', {}))?.trial ?? null,
    enabled: api() !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const trial = read.data ?? null;
  return trial === null ? null : <TrialSection trial={trial} />;
}
