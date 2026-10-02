import { type CallOutcome, type CallProposal, type CallProposalKey } from '@fss/contracts';
import { Pencil } from 'lucide-react';
import { useMemo, useRef, useState, type JSX } from 'react';
import type { AnalysisView } from '../../shared/operations.ts';
import { useDraft } from '../app/drafts.tsx';
import { cn } from '../lib/utils.ts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Block, Label, dense } from '../v2/parts.tsx';
import {
  KEY_RESULT_TEXT,
  applicable,
  applyProblem,
  chosenOutcome,
  editsOf,
  evidenceLines,
  keyRefusalText,
  noDefiniteAnswer,
  outcomeChoices,
  refusalOf,
  reviewOnly,
  rowLabel,
  selectable,
  settle,
  startsTicked,
  type FieldDrafts,
} from './afterCallModel.ts';
import { phaseOf } from './useAnalysis.ts';

/**
 * The after-call block (slice 3a, lane C; DESIGN-S3A §2.3, §2.10): one call's notes and
 * **one block of related suggestions**, each a row with a checkbox, its evidence and its own
 * prefilled fields, and **one Apply** for whatever is ticked.
 *
 *   * the three states of the analysis — pending, failed (Retry, or enter it by hand) and
 *     completed;
 *   * David's tick is the safety boundary: stop, open a deal, the e-mail and the callback start
 *     unticked, each with the full line that supports it (`afterCallModel.ts`);
 *   * Apply sends the keys, the three identifiers of the analysis he is looking at and his
 *     edits, in one request with a command id that is the same for the same click; there is no
 *     confirmation dialog, buying signal included;
 *   * the answer is local: a refusal that means "this is out of date" reads the analysis again
 *     and says so once; a first-time answer is on its row;
 *   * a `mode: review` proposal is never a row here — it is a Needs review item, below.
 *
 * It reads only the session it is given. A result for another session never reaches it.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

const RETRY_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  analysis_in_flight: 'The notes are already being written.',
  reanalysis_required: 'These notes were already tried again; ask for a reanalysis instead.',
  transcript_missing: 'There is no transcript to read yet.',
  not_found: 'Callie cannot find that call.',
  offline: 'Callie is offline. Nothing was asked.',
});

const FAILURE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  transcript_missing: 'The call has no transcript to read.',
  transcript_too_long: 'The call is too long to read automatically.',
  not_channel_labelled: 'The transcript does not say who spoke.',
  budget_exhausted: 'Today’s allowance for reading calls is used up.',
  off: 'Reading calls is turned off.',
});

function Notes({ sessionId, notes, onSaved }: { readonly sessionId: string; readonly notes: { readonly summary: string; readonly facts: readonly string[] }; onSaved(): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useDraft(`analysis:${sessionId}:summary`, notes.summary);
  const [facts, setFacts] = useDraft(`analysis:${sessionId}:facts`, notes.facts.join('\n'));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const factList = facts.split('\n').map(line => line.trim()).filter(line => line !== '');
  const dirty = summary.trim() !== notes.summary || factList.join('\n') !== notes.facts.join('\n');

  const save = (): void => {
    const bridge = api();
    if (bridge === undefined || busy || summary.trim() === '') return;
    setBusy(true);
    setProblem(null);
    void bridge
      .command('calling.analysisEdit', { callSessionId: sessionId, notes: { summary: summary.trim(), facts: factList } })
      .then(answer => {
        if (answer.analysis === null) setProblem(answer.reason === 'offline' ? 'Callie is offline. Your edit is kept here.' : 'The notes could not be saved. Your edit is kept here.');
        else {
          setOpen(false);
          onSaved();
        }
      }, () => setProblem('The notes could not be saved. Your edit is kept here.'))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="analysis-notes" className="flex flex-col gap-1.5">
      <Label
        actions={
          <Button variant="ghost" data-testid="analysis-edit" aria-expanded={open} className={cn(dense.sm, 'text-muted-foreground')} onClick={() => setOpen(!open)}>
            <Pencil /> Edit
          </Button>
        }
      >
        Notes
      </Label>
      {open ? (
        <div
          data-testid="analysis-notes-editor"
          className="flex flex-col gap-2"
          onKeyDown={event => {
            // Escape closes it and keeps what was typed: the text is in the shell's draft store.
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Textarea aria-label="Summary" data-testid="analysis-summary" rows={4} value={summary} maxLength={2000} onChange={event => setSummary(event.target.value)} className="resize-none text-sm" />
          <Textarea aria-label="Facts, one per line" data-testid="analysis-facts" rows={3} value={facts} onChange={event => setFacts(event.target.value)} className="resize-none text-sm" placeholder="One fact per line" />
          {problem === null ? null : (
            <p data-testid="analysis-notes-problem" role="alert" className="text-xs text-danger-ink">
              {problem}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button data-testid="analysis-save" className={dense.md} disabled={!dirty || busy || summary.trim() === ''} onClick={save}>
              Save notes
            </Button>
            <span className="text-xs text-faint">Esc to close</span>
          </div>
        </div>
      ) : (
        <>
          <p data-testid="analysis-summary-text" className="text-sm">
            {notes.summary}
          </p>
          {notes.facts.length === 0 ? null : (
            <ul data-testid="analysis-facts-list" className="flex list-disc flex-col gap-0.5 pl-4 text-sm text-muted-foreground">
              {notes.facts.map(fact => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export interface AfterCallAnalysisProps {
  readonly view: AnalysisView | undefined;
  readonly sessionId: string;
  /** The call has just ended, so an analysis that is not there yet is on its way. */
  readonly waiting: boolean;
  /** A log exists for this call, and its outcome when this panel knows it. */
  readonly logged: boolean;
  readonly loggedOutcome?: CallOutcome | null;
  /** The approved e-mails the follow-up may be promised as. */
  readonly templates: readonly { readonly id: string; readonly name: string }[];
  /**
   * An Apply's command id, by call session, kept above the route so a click that lost its
   * answer is retried under the same id after leaving Today and coming back.
   */
  readonly commands?: Map<string, { readonly signature: string; readonly id: string }>;
  /** Read the analysis again. */
  onReload(): void;
  /** Something was applied: the card, the history and Needs review are read again. */
  onChanged(): void;
  /** "Enter manually": opens the first-time outcome form. */
  onEnterManually(): void;
}

export function AfterCallAnalysis(props: AfterCallAnalysisProps): JSX.Element | null {
  const { view, sessionId, waiting, templates } = props;
  const phase = phaseOf(view, waiting);
  const analysis = view?.analysis ?? null;

  if (phase === 'absent') return null;
  if (phase === 'waiting' || phase === 'pending') {
    if (phase === 'waiting' && !waiting) return null;
    return (
      <div data-testid="analysis-pending" data-phase={phase} className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Writing the notes…</p>
        <p>This takes a minute. You can move on to the next call; the notes will be here when you come back.</p>
      </div>
    );
  }
  if (phase === 'failed' && analysis !== null) return <Failed {...props} reason={analysis.failure?.reason ?? null} />;
  if (analysis === null) return null;
  return <Completed {...props} analysis={analysis} templates={templates} key={`${sessionId}:${analysis.authoritative?.proposalHash ?? 'none'}`} />;
}

function Failed({ sessionId, onReload, onEnterManually, reason }: AfterCallAnalysisProps & { readonly reason: string | null }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const retry = (): void => {
    const bridge = api();
    if (bridge === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    void bridge
      .command('calling.analysisRetry', { callSessionId: sessionId, reason: 'retry' })
      .then(answer => {
        if (answer.analysis === null) setProblem(RETRY_SENTENCES[answer.reason ?? ''] ?? 'Callie could not ask again. Nothing was changed.');
        else onReload();
      }, () => setProblem('Callie could not ask again. Nothing was changed.'))
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="analysis-failed" className="flex flex-col gap-2">
      <p className="text-sm font-medium">The notes could not be written.</p>
      {reason === null ? null : (
        <p data-testid="analysis-failure-reason" className="text-xs text-muted-foreground">
          {FAILURE_SENTENCES[reason] ?? 'Something went wrong reading the call.'}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="outline" data-testid="analysis-retry" className={dense.md} disabled={busy} {...(busy ? { 'aria-busy': true } : {})} onClick={retry}>
          Retry
        </Button>
        <Button variant="ghost" data-testid="analysis-manual" className={cn(dense.md, 'text-muted-foreground')} onClick={onEnterManually}>
          Enter manually
        </Button>
      </div>
      {problem === null ? null : (
        <p data-testid="analysis-retry-problem" role="alert" className="text-xs text-danger-ink">
          {problem}
        </p>
      )}
    </div>
  );
}

function Completed({
  analysis,
  sessionId,
  logged,
  loggedOutcome = null,
  templates,
  commands,
  onReload,
  onChanged,
}: AfterCallAnalysisProps & { readonly analysis: NonNullable<AnalysisView['analysis']> }): JSX.Element {
  const authoritative = analysis.authoritative;
  const proposals = useMemo<readonly CallProposal[]>(() => authoritative?.proposals ?? [], [authoritative]);
  const rows = useMemo(() => applicable(proposals), [proposals]);
  const needReview = reviewOnly(proposals);
  const base = `analysis:${authoritative?.analysisId ?? sessionId}`;

  // What was applied or declined stays done for good: it is in the draft store with the ticks, so
  // it survives leaving Today, and a done key is never ticked and never sent again.
  const [doneText, setDoneText] = useDraft(`${base}:done`);
  const done = useMemo<ReadonlySet<string>>(() => new Set(doneText === '' ? [] : doneText.split(',')), [doneText]);
  const [wasLogged, setWasLogged] = useState<CallOutcome | null>(null);
  const isLogged = logged || wasLogged !== null;
  const shownOutcome = wasLogged ?? loggedOutcome;

  // Ticks live in the shell's draft store, so they survive leaving Today like any draft.
  const defaults = useMemo(() => rows.filter(row => startsTicked(row) && !done.has(row.key)).map(row => row.key).join(','), [rows, done]);
  const [tickedText, setTickedText] = useDraft(`${base}:ticked`, defaults);
  const ticked = useMemo(
    () => {
      const open = new Set<CallProposalKey>((tickedText === '' ? [] : (tickedText.split(',') as CallProposalKey[])).filter(key => !done.has(key)));
      return settle(open, rows, isLogged);
    },
    [tickedText, rows, isLogged, done],
  );
  const setTicked = (next: ReadonlySet<CallProposalKey>): void => setTickedText([...settle(next, rows, isLogged)].filter(key => !done.has(key)).join(','));

  const [outcomeDraft, setOutcomeDraft] = useDraft(`${base}:outcome`);
  const [coversAll, setCoversAll] = useDraft(`${base}:coversAll`);
  const [callbackDate, setCallbackDate] = useDraft(`${base}:cbDate`);
  const [callbackTime, setCallbackTime] = useDraft(`${base}:cbTime`);
  const [template, setTemplate] = useDraft(`${base}:template`);
  const drafts: FieldDrafts = {
    ...(outcomeDraft === '' ? {} : { outcome: outcomeDraft as CallOutcome }),
    coversAll: coversAll === 'yes',
    ...(callbackDate === '' ? {} : { callbackDate }),
    ...(callbackTime === '' ? {} : { callbackTime }),
    ...(template === '' ? {} : { templateVersionId: template }),
  };

  const [rowNotes, setRowNotes] = useState<Readonly<Record<string, string>>>({});
  const [blockNote, setBlockNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fallbackCommands = useRef(new Map<string, { readonly signature: string; readonly id: string }>());
  const commandMemory = commands ?? fallbackCommands.current;

  const outcomeProposal = rows.find((row): row is Extract<CallProposal, { kind: 'outcome' }> => row.kind === 'outcome');
  const problem = applyProblem(rows, ticked, drafts);
  const unticked = rows.filter(row => !ticked.has(row.key) && !done.has(row.key) && !(row.kind === 'outcome' && isLogged));

  const apply = (): void => {
    const bridge = api();
    if (bridge === undefined || authoritative === null || busy || problem !== null) return;
    const keys = rows.filter(row => ticked.has(row.key) && !done.has(row.key)).map(row => row.key);
    const edits = editsOf(rows, ticked, drafts);
    const body = {
      analysisId: authoritative.analysisId,
      transcriptSha256: authoritative.transcriptSha256,
      proposalHash: authoritative.proposalHash,
      keys,
      ...(Object.keys(edits).length === 0 ? {} : { edits }),
    };
    const signature = JSON.stringify(body);
    // The command id lives with the session, above the route. It is reused only for the same body
    // after an answer that never came (the server then answers from its receipt); any definite
    // answer, success or refusal, ends it, and a changed selection or edit is a new command.
    const remembered = commandMemory.get(sessionId);
    const command = remembered?.signature === signature ? remembered : { signature, id: crypto.randomUUID() };
    commandMemory.set(sessionId, command);
    setBusy(true);
    setBlockNote(null);
    // An Apply is atomic, so a refusal wrote nothing and every key still stands: the notes a
    // previous refusal left on the rows are cleared, and this one's are drawn fresh.
    setRowNotes(current => Object.fromEntries(Object.entries(current).filter(([key]) => done.has(key))));
    void bridge
      .command('calling.proposalsApply', { ...body, commandId: command.id })
      .then(answer => {
        if (answer.applied !== null) {
          const notes: Record<string, string> = {};
          const finished = new Set(done);
          for (const result of answer.applied.results) {
            notes[result.key] = KEY_RESULT_TEXT[result.result] ?? 'Done';
            finished.add(result.key);
          }
          commandMemory.delete(sessionId);
          setRowNotes(current => ({ ...current, ...notes }));
          setDoneText([...finished].join(','));
          setTickedText([...ticked].filter(key => !finished.has(key)).join(','));
          if (answer.applied.callLogId !== null && keys.includes('outcome')) {
            setWasLogged(outcomeProposal === undefined ? null : chosenOutcome(outcomeProposal, drafts));
          }
          onChanged();
          return;
        }
        // A refusal is a definite answer: the next click is a new command. Only an answer that
        // never came keeps the id.
        if (!noDefiniteAnswer(answer.reason)) commandMemory.delete(sessionId);
        // Nothing was applied. Every tick and every draft stays, so David changes what is wrong
        // and presses Apply again; each refused key says why next to its own suggestion.
        const refusal = refusalOf(answer.reason);
        const named = Object.entries(answer.keyReasons);
        if (named.length > 0) {
          setRowNotes(current => ({ ...current, ...Object.fromEntries(named.map(([key, code]) => [key, keyRefusalText(code)])) }));
          setBlockNote('Nothing was applied. Fix what is marked below, or untick it, and apply again.');
        } else setBlockNote(refusal.text);
        if (refusal.reload) {
          onReload();
          onChanged();
        }
      }, () => setBlockNote('Callie could not apply that. Nothing was changed.'))
      .finally(() => setBusy(false));
  };

  const declineRest = (): void => {
    const bridge = api();
    if (bridge === undefined || authoritative === null || unticked.length === 0) return;
    void bridge
      .command('calling.proposalsDecline', { analysisId: authoritative.analysisId, proposalHash: authoritative.proposalHash, keys: unticked.map(row => row.key) })
      .then(answer => {
        if (answer.declined) {
          setDoneText([...done, ...unticked.map(row => row.key)].join(','));
          setRowNotes(current => ({ ...current, ...Object.fromEntries(unticked.map(row => [row.key, 'Declined'])) }));
          onChanged();
        } else setBlockNote('Callie could not record that. Nothing was changed.');
      }, () => setBlockNote('Callie could not record that. Nothing was changed.'));
  };

  const effectiveOutcome = outcomeProposal === undefined ? undefined : chosenOutcome(outcomeProposal, drafts);

  return (
    <div data-testid="analysis-completed" className="flex flex-col gap-4">
      {analysis.current === null ? null : <Notes sessionId={sessionId} notes={analysis.current.notes} onSaved={onReload} />}

      {rows.length === 0 && needReview.length === 0 ? null : (
        <Block data-testid="suggestions" className="py-0">
          <Label>Suggestions</Label>
          <ul className="flex flex-col">
            {rows.map(row => {
              const rule = selectable(row, { ticked, logged: isLogged });
              const finished = done.has(row.key);
              const loggedRow = row.kind === 'outcome' && isLogged;
              const evidence = evidenceLines(row);
              const id = `suggestion-check-${row.key}`;
              return (
                <li key={row.key} data-testid={`suggestion-${row.key}`} data-ticked={ticked.has(row.key)} className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
                  <div className="flex items-start gap-2">
                    {loggedRow ? (
                      <span data-testid="suggestion-logged" className="text-sm">
                        Logged{shownOutcome === null ? '' : `: ${OUTCOME_LABELS[shownOutcome]}`}
                      </span>
                    ) : (
                      <>
                        <input
                          type="checkbox"
                          id={id}
                          data-testid={id}
                          className="mt-0.5"
                          checked={ticked.has(row.key)}
                          disabled={!rule.ok || finished || busy}
                          onChange={event => {
                            const next = new Set(ticked);
                            if (event.target.checked) next.add(row.key);
                            else next.delete(row.key);
                            setTicked(next);
                          }}
                        />
                        <label htmlFor={id} className="text-sm leading-snug">
                          {rowLabel(row)}
                        </label>
                      </>
                    )}
                  </div>
                  {evidence.length === 0 ? null : (
                    <ul data-testid={`suggestion-evidence-${row.key}`} className="ml-6 flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {evidence.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {rule.why === null || ticked.has(row.key) || finished ? null : (
                    <p data-testid={`suggestion-why-${row.key}`} className="ml-6 text-xs text-muted-foreground">
                      {rule.why}
                    </p>
                  )}
                  {finished || !ticked.has(row.key) ? null : (
                    <div className="ml-6 flex flex-wrap items-center gap-2">
                      {row.kind === 'outcome' ? (
                        <>
                          <Select
                            aria-label="What happened"
                            data-testid="suggestion-outcome-select"
                            className="h-7 w-auto text-xs"
                            value={chosenOutcome(row, drafts)}
                            onChange={event => setOutcomeDraft(event.target.value)}
                          >
                            {outcomeChoices(row).map(value => (
                              <option key={value} value={value}>
                                {OUTCOME_LABELS[value]}
                              </option>
                            ))}
                          </Select>
                          {effectiveOutcome === 'do_not_call' ? (
                            <label className="flex items-center gap-1.5 text-xs">
                              <input type="checkbox" data-testid="suggestion-covers-all" checked={coversAll === 'yes'} onChange={event => setCoversAll(event.target.checked ? 'yes' : '')} />
                              Covers all contact at this firm
                            </label>
                          ) : null}
                        </>
                      ) : null}
                      {row.kind === 'callback' ? (
                        <>
                          <Input aria-label="Callback day" data-testid="suggestion-callback-date" type="date" className="h-7 w-36 text-xs" value={callbackDate === '' ? row.params.localDate : callbackDate} onChange={event => setCallbackDate(event.target.value)} />
                          <Input aria-label="Callback time" data-testid="suggestion-callback-time" type="time" className="h-7 w-24 text-xs" value={callbackTime === '' ? row.params.localTime : callbackTime} onChange={event => setCallbackTime(event.target.value)} />
                          <span className="text-xs text-muted-foreground">{row.params.sourceTimeZone}</span>
                        </>
                      ) : null}
                      {row.kind === 'follow_up' ? (
                        <Select aria-label="The e-mail they agreed to" data-testid="suggestion-template" className="h-7 w-auto max-w-full text-xs" value={template} onChange={event => setTemplate(event.target.value)}>
                          <option value="">Choose the e-mail…</option>
                          {templates.map(entry => (
                            <option key={entry.id} value={entry.id}>
                              {entry.name}
                            </option>
                          ))}
                        </Select>
                      ) : null}
                    </div>
                  )}
                  {(rowNotes[row.key] ?? (finished && !loggedRow ? 'Done' : undefined)) === undefined ? null : (
                    <p data-testid={`suggestion-note-${row.key}`} role="status" className="ml-6 text-xs text-muted-foreground">
                      {rowNotes[row.key] ?? 'Done'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {needReview.length === 0 ? null : (
            <p data-testid="suggestions-review-count" className="mt-1.5 text-xs text-muted-foreground">
              {needReview.length === 1 ? '1 more suggestion needs review' : `${String(needReview.length)} more suggestions need review`}: see Needs review.
            </p>
          )}
          {rows.length === 0 ? null : (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Button data-testid="apply" className={dense.md} disabled={busy || problem !== null} {...(busy ? { 'aria-busy': true } : {})} onClick={apply}>
                  Apply selected
                </Button>
                {unticked.length === 0 ? null : (
                  <Button variant="ghost" data-testid="decline-rest" className={cn(dense.md, 'text-muted-foreground')} disabled={busy} onClick={declineRest}>
                    Decline the rest
                  </Button>
                )}
              </div>
              {problem === null || ticked.size === 0 ? null : (
                <p data-testid="apply-problem" className="text-xs text-muted-foreground">
                  {problem}
                </p>
              )}
              {blockNote === null ? null : (
                <p data-testid="apply-note" role="alert" className="text-xs text-danger-ink">
                  {blockNote}
                </p>
              )}
            </div>
          )}
        </Block>
      )}
    </div>
  );
}
