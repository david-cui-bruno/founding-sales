import { ArrowUpRight, CalendarClock, CornerDownLeft, HelpCircle, ListTodo, NotebookPen, Pencil, PhoneIncoming, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { TodayCardBlocker } from '@fss/contracts';
import type { FirmBasicsAnswer } from '../../shared/operations.ts';
import type { CallControl } from '../calling/useCall.ts';
import { useCallingStatus } from '../calling/useCallingStatus.ts';
import type { HomeView } from '../homeView.ts';
import { cn } from '../lib/utils.ts';
import { navigate } from '../routes.ts';
import type { TodayCard, TodayState } from '../todayContract.ts';
import { noticeSentence, type TodayScreenView } from '../todayView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Input } from '../ui/input.tsx';
import { Block, Chip, dense, Kbd, Label, StepChip } from '../v2/parts.tsx';
import { SHORTCUTS, useShortcuts, type ShortcutAction } from '../v2/shortcuts.ts';
import { BasicsEditor, type BasicsField } from './BasicsEditor.tsx';
import { CallPanel } from './CallPanel.tsx';
import { LogIncomingDialog, type Contact } from './LogIncomingDialog.tsx';
import { OutcomeForm } from './OutcomeForm.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { BLOCKER_FIXES, BLOCKER_SENTENCES, blockersOf, groupOf, nextToCall, stepFrom } from './queueView.ts';
import { TaskRow } from './TaskRow.tsx';
import { HomeExtras, UpdatedLine } from './TodayColumn.tsx';
import { TodayBrief } from './TodayBrief.tsx';
import { useCallProgress } from './useCallProgress.ts';
import { todayForm, type Today } from './useToday.ts';

/**
 * Today in the v2 design (slice S2): the queue, the selected firm's brief, and the call.
 *
 * Three regions, all on screen from 1280 px: the queue on the left, the firm in the
 * middle, the call panel on the right. Below 1280 the queue folds behind a "Queue" button
 * so the firm and the call keep their width. The selected firm *is* the expanded card the
 * main process holds (`today.expand`), so choosing a firm is the read that brings its
 * tasks, numbers, advice and brief.
 *
 * **Nothing is lost by moving on (plan §4).** The selected firm is the main process's;
 * every draft — a note typed during a call, an outcome half-entered, a firm's basics — is
 * keyed by firm above the route (`app/drafts.tsx`); the call itself is `useCall`, hoisted
 * to the shell so leaving Today mid-call does not hang up; and the scroll of the queue and
 * of each firm is kept in `TodayMemory`, which outlives this view.
 *
 * **Keyboard.** J/K and the arrows walk the queue, ⌘K and / search, E edits the firm's
 * basics, ? lists the keys, Esc closes. No key dials, and none fires while typing
 * (`v2/shortcuts.ts`, the prototype's map and its test). The queue does not move while a
 * call is live.
 */

/** What Today keeps while the person is elsewhere: the shell owns it. */
export interface TodayMemory {
  readonly done: ReadonlySet<string>;
  markDone(firmId: string): void;
  readonly queueScroll: { current: number };
  readonly firmScroll: { current: Map<string, number> };
}

export function useTodayMemory(): TodayMemory {
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const queueScroll = useRef(0);
  const firmScroll = useRef(new Map<string, number>());
  const markDone = useCallback((firmId: string): void => {
    setDone(current => (current.has(firmId) ? current : new Set([...current, firmId])));
  }, []);
  return useMemo(() => ({ done, markDone, queueScroll, firmScroll }), [done, markDone]);
}

/** A call worth showing the steps of: placed in the last day. Older ones are history. */
function recentCall(call: { readonly startedAt: string | null; readonly endedAt: string | null }): boolean {
  const at = Date.parse(call.endedAt ?? call.startedAt ?? '');
  return Number.isFinite(at) && Date.now() - at < 24 * 60 * 60_000;
}

const SUPPORTED: readonly ShortcutAction[] = ['next', 'previous', 'search', 'edit', 'help', 'close'];

function laneChip(card: TodayCard | undefined, blockers: readonly TodayCardBlocker[]): JSX.Element {
  if (card === undefined) return <Chip tone="outline">Not on today’s list</Chip>;
  const group = groupOf(card);
  if (group === 'blocked') return <Chip tone="warn">Can’t call yet · {blockers.map(code => BLOCKER_SENTENCES[code].toLowerCase()).join(', ')}</Chip>;
  if (group === 'callbacks') return <Chip icon={<CalendarClock />}>Callback</Chip>;
  if (group === 'replies') return <Chip tone="info">Replied</Chip>;
  if (group === 'due') return <Chip tone="outline">Due today</Chip>;
  return <Chip tone="outline">New prospect</Chip>;
}

function SearchDialog({
  open,
  cards,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly cards: readonly TodayCard[];
  onClose(): void;
  onPick(firmId: string): void;
}): JSX.Element | null {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  if (!open) return null;
  const query = text.trim().toLowerCase();
  const found = cards.filter(card => card.firmName.toLowerCase().includes(query)).slice(0, 8);
  return (
    <Dialog open title="Search today’s firms" onClose={onClose} data-testid="search">
      <Input
        aria-label="Search firms"
        data-testid="search-input"
        placeholder="Firm name"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && found[0] !== undefined) onPick(found[0].firmId);
        }}
        className="h-8 border-strong text-sm"
      />
      <ul className="mt-2 flex flex-col">
        {found.map((card, index) => (
          <li key={card.firmId}>
            <button
              type="button"
              data-testid="search-result"
              onClick={() => onPick(card.firmId)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', index === 0 && query !== '' && 'bg-muted')}
            >
              <span className="min-w-0 flex-1 truncate">{card.firmName}</span>
              {index === 0 && query !== '' ? <CornerDownLeft className="size-3 text-faint" /> : null}
            </button>
          </li>
        ))}
        {found.length === 0 ? (
          <li className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Search className="size-3.5" /> No firm on today’s list matches. Every firm is under Firms (⌘4).
          </li>
        ) : null}
      </ul>
    </Dialog>
  );
}

function FirmHeader({
  card,
  name,
  blockers,
  meta,
  onEdit,
  onOpen,
  onOutcome,
}: {
  readonly card: TodayCard | undefined;
  readonly name: string;
  readonly blockers: readonly TodayCardBlocker[];
  readonly meta: readonly string[];
  onEdit(): void;
  onOpen(): void;
  onOutcome(): void;
}): JSX.Element {
  return (
    <header data-testid="firm-header" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">{laneChip(card, blockers)}</div>
      <div className="flex items-start justify-between gap-4">
        <h1 data-testid="firm-name" title={name} className="line-clamp-2 min-w-0 text-2xl font-semibold tracking-tight text-balance">
          {name}
        </h1>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button variant="ghost" data-testid="firm-outcome" title="Notes and outcome" aria-label="Notes and outcome" className={cn(dense.md, 'text-muted-foreground')} onClick={onOutcome}>
            <NotebookPen /> <span className="hidden min-[1440px]:inline">Notes and outcome</span>
          </Button>
          <Button variant="ghost" data-testid="firm-edit" className={cn(dense.md, 'text-muted-foreground')} onClick={onEdit}>
            <Pencil /> Edit <Kbd className="ml-0.5">E</Kbd>
          </Button>
          <Button
            variant="ghost"
            data-testid="card-open-firm"
            className={cn(dense.icon, 'text-muted-foreground')}
            aria-label="Open firm page"
            title="Open firm page"
            onClick={onOpen}
          >
            <ArrowUpRight />
          </Button>
        </div>
      </div>
      <p data-testid="firm-meta" className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        {meta.map((part, index) => (
          <span key={part} className={cn(index > 0 && "before:mr-1.5 before:text-faint before:content-['·']")}>
            {part}
          </span>
        ))}
        {blockers.map(blocker => (
          <span key={blocker} className="text-warn-ink before:mr-1.5 before:text-faint before:content-['·'] first:before:content-none">
            {BLOCKER_SENTENCES[blocker].toLowerCase()}
          </span>
        ))}
      </p>
    </header>
  );
}

export function TodayWorkspace({
  home,
  today,
  todayView,
  call,
  memory,
  hasTodayBridge,
  onRefresh,
  onConnectMailbox,
}: {
  readonly home: HomeView;
  readonly today: Today;
  readonly todayView: TodayScreenView | null;
  readonly call: CallControl;
  readonly memory: TodayMemory;
  readonly hasTodayBridge: boolean;
  onRefresh(): void;
  onConnectMailbox(): void;
}): JSX.Element {
  const state: TodayState | null = today.state;
  const actions = today.actions;
  const cards = useMemo(() => state?.cards ?? [], [state]);
  const expanded = state?.expanded ?? null;
  const firmId = expanded?.firmId ?? null;
  const card = cards.find(entry => entry.firmId === firmId);
  const basics = expanded?.basics;
  const blockers: readonly TodayCardBlocker[] = basics?.blockers ?? (card === undefined ? [] : blockersOf(card));

  const status = useCallingStatus(firmId);
  const history = useCallProgress(firmId);
  const [dialog, setDialog] = useState<'search' | 'help' | 'incoming' | null>(null);
  const [editing, setEditing] = useState<BasicsField | null>(null);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [incomingNotice, setIncomingNotice] = useState<string | null>(null);

  const live = call.state.phase === 'starting' || call.state.phase === 'ringing' || call.state.phase === 'connected';
  const callFirm = 'firmId' in call.state ? call.state.firmId : null;

  const select = useCallback(
    (next: string | null): void => {
      if (next === null || actions === null || next === firmId) return;
      // Never leave a live call by a keystroke or a click: the queue is locked while one is.
      if (live && callFirm !== next) return;
      actions.expand(next);
      setQueueOpen(false);
    },
    [actions, firmId, live, callFirm],
  );

  // The first firm of the queue, when nothing is selected: the morning starts on a card.
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (actions === null || expanded !== null || cards.length === 0) return;
    const first = stepFrom(cards, null, 1);
    if (first === null || tried.current === first) return;
    tried.current = first;
    actions.expand(first);
  }, [actions, expanded, cards]);

  // Moving to another firm: the edit and the outcome form close (their drafts stay), the
  // last firm's scroll is kept, and an ended call on the last firm is put away.
  const firmRegion = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const region = firmRegion.current;
    const before = shown.current;
    if (before === firmId) return;
    if (before !== null && region !== null) memory.firmScroll.current.set(before, region.scrollTop);
    shown.current = firmId;
    setEditing(null);
    setOutcomeOpen(false);
    if (region !== null) region.scrollTop = firmId === null ? 0 : (memory.firmScroll.current.get(firmId) ?? 0);
    if (call.state.phase === 'ended' || call.state.phase === 'refused') {
      if (callFirm !== firmId) call.dismiss();
    }
  }, [firmId, memory, call, callFirm]);

  // A call that ended: read the card and the cadence again, read the history now (and
  // while its steps are on their way), and tick the firm off for this sitting.
  const endedSession = call.state.phase === 'ended' ? call.state.sessionId : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (endedSession === null || seen.current === endedSession || callFirm === null) return;
    seen.current = endedSession;
    memory.markDone(callFirm);
    actions?.expand(callFirm);
    status.reload();
    history.refresh();
  }, [endedSession, callFirm, actions, status, history, memory]);

  const next = nextToCall(cards, firmId, new Set([...memory.done, ...(firmId === null ? [] : [firmId])]));
  const goNext = (): void => {
    call.dismiss();
    select(next);
  };

  const editFirst = (): BasicsField => (blockers.includes('no_phone') ? 'phone' : blockers.includes('no_location') ? 'regionCode' : 'phone');

  useShortcuts({
    next: () => select(stepFrom(cards, firmId, 1)),
    previous: () => select(stepFrom(cards, firmId, -1)),
    search: () => setDialog('search'),
    help: () => setDialog('help'),
    edit: () => {
      if (firmId !== null) setEditing(editFirst());
    },
    close: () => {
      if (dialog !== null) setDialog(null);
      else if (editing !== null) setEditing(null);
      else if (outcomeOpen) setOutcomeOpen(false);
      else if (queueOpen) setQueueOpen(false);
    },
  });

  const onSaved = (answer: FirmBasicsAnswer): void => {
    setEditing(null);
    if (firmId !== null) actions?.expand(firmId);
    today.refresh();
    void answer;
  };

  const contactsFor = (id: string): readonly Contact[] => {
    if (expanded === null || expanded.firmId !== id) return [];
    const seenIds = new Set<string>();
    const contacts: Contact[] = [];
    const add = (contactId: string | null | undefined, name: string | null | undefined): void => {
      if (contactId == null || name == null || seenIds.has(contactId)) return;
      seenIds.add(contactId);
      contacts.push({ contactId, name });
    };
    add(expanded.brief?.likelyPerson?.contactId, expanded.brief?.likelyPerson?.name);
    for (const task of expanded.tasks) add(task.contactId, task.contactName);
    return contacts;
  };

  const primaryRoute = todayView?.dialRoutes[0]?.route ?? null;
  const localTime = todayView?.dialRoutes.find(entry => entry.advice?.firmLocalTime != null)?.advice?.firmLocalTime ?? null;
  const meta = [
    basics === undefined || (basics.locality === null && basics.regionCode === null)
      ? null
      : [basics.locality, basics.regionCode].filter((part): part is string => part !== null).join(', '),
    localTime === null ? null : `${localTime} there`,
    primaryRoute?.e164 ?? null,
  ].filter((part): part is string => part !== null && part !== '');

  const unavailable = !hasTodayBridge || actions === null || state === null || todayView === null;

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <Button
        variant="ghost"
        data-testid="queue-toggle"
        className={cn(dense.md, 'text-muted-foreground min-[1280px]:hidden')}
        aria-expanded={queueOpen}
        onClick={() => setQueueOpen(!queueOpen)}
      >
        <ListTodo /> Queue
      </Button>
      <h1 data-testid="heading" className="shrink-0 text-sm font-semibold whitespace-nowrap">
        {home.heading}
      </h1>
      <span data-testid="summary" className="hidden truncate text-sm text-muted-foreground empty:hidden min-[1100px]:inline">
        {home.summary ?? ''}
      </span>
      {state === null || !hasTodayBridge ? null : (
        <span className="hidden whitespace-nowrap min-[1280px]:inline">
          <UpdatedLine state={state} now={today.now} refreshAnswered={today.refreshAnswered} onRefresh={onRefresh} />
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          data-testid="log-incoming"
          className={cn(dense.md, 'text-muted-foreground')}
          disabled={unavailable}
          onClick={() => setDialog('incoming')}
        >
          <PhoneIncoming /> Log incoming call
        </Button>
        <Button variant="ghost" data-testid="search-open" className={cn(dense.md, 'text-muted-foreground')} onClick={() => setDialog('search')}>
          <Search /> <Kbd>⌘K</Kbd>
        </Button>
        <Button variant="ghost" data-testid="refresh" className={cn(dense.md, 'text-muted-foreground')} onClick={onRefresh}>
          Refresh
        </Button>
        <Button
          variant="ghost"
          className={cn(dense.icon, 'text-muted-foreground')}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => setDialog('help')}
        >
          <HelpCircle />
        </Button>
      </div>
    </div>
  );

  const notices = [...home.notices, ...(incomingNotice === null ? [] : [{ tone: 'info' as const, text: incomingNotice }])];

  return (
    <div data-testid="home" data-region="today" aria-busy={today.pending > 0} className="callie-v2 flex h-screen min-w-0 flex-col">
      {header}
      {notices.length === 0 ? null : (
        <div data-testid="banners" className="flex flex-col gap-1.5 border-b border-border px-5 py-2">
          {notices.map(notice => (
            <Alert key={`${notice.tone}:${notice.text}`} tone={notice.tone} data-testid={`banner-${notice.tone}`} className="py-1.5 text-sm">
              {notice.text}
            </Alert>
          ))}
        </div>
      )}
      {unavailable ? (
        <p data-testid="today-unavailable" className="p-6 text-sm text-muted-foreground">
          {home.lanes?.emptyLine ?? 'Unavailable in this build'}
        </p>
      ) : (
        <div data-testid="today" className="relative flex min-h-0 flex-1">
          <div
            data-testid="queue-region"
            className={cn(
              'w-[256px] shrink-0 flex-col border-r border-border bg-sidebar min-[1440px]:w-[280px] min-[1920px]:w-[320px]',
              queueOpen ? 'absolute inset-y-0 left-0 z-30 flex shadow-lg' : 'hidden min-[1280px]:flex',
            )}
          >
            <QueuePanel
              cards={cards}
              selected={firmId}
              done={memory.done}
              locked={live}
              scrollTop={memory.queueScroll.current}
              onScroll={top => {
                memory.queueScroll.current = top;
              }}
              onSelect={select}
              footer={<HomeExtras home={home} onConnectMailbox={onConnectMailbox} compact />}
            />
          </div>

          <div ref={firmRegion} data-region="firm" data-testid="today-firm" className="min-w-0 flex-1 overflow-y-auto">
            {expanded === null ? (
              <p data-testid="today-empty" className="pt-24 text-center text-sm text-muted-foreground">
                {cards.length === 0 ? (todayView.emptyMessage ?? 'Nothing is due today.') : 'Pick a firm from the queue.'}
              </p>
            ) : (
              <div className="mx-auto flex max-w-[760px] flex-col px-8 pt-6 pb-16">
                <FirmHeader
                  card={card}
                  name={expanded.firmName}
                  blockers={blockers}
                  meta={meta}
                  onEdit={() => setEditing(editFirst())}
                  onOpen={() => navigate({ name: 'firm', firmId: expanded.firmId })}
                  onOutcome={() => setOutcomeOpen(true)}
                />
                {editing !== null || blockers.length > 0 ? (
                  <div className="mt-4">
                    {editing === null ? (
                      <div data-testid="firm-blocked" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-warn-soft/50 px-3 py-2">
                        <span className="text-sm text-warn-ink">{blockers.map(code => BLOCKER_SENTENCES[code]).join(' · ')}.</span>
                        {blockers.map(blocker => (
                          <Button
                            key={blocker}
                            variant="outline"
                            data-testid={`firm-fix-${blocker}`}
                            className={cn(dense.sm, 'bg-background')}
                            onClick={() => setEditing(blocker === 'no_phone' ? 'phone' : 'regionCode')}
                          >
                            {BLOCKER_FIXES[blocker]}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <BasicsEditor
                        key={expanded.firmId}
                        firmId={expanded.firmId}
                        values={{
                          locality: basics?.locality ?? null,
                          regionCode: basics?.regionCode ?? null,
                          timeZone: basics?.timeZone ?? null,
                        }}
                        phone={primaryRoute === null ? null : { routeId: primaryRoute.routeId, e164: primaryRoute.e164 }}
                        focus={editing}
                        enabled={todayView.actionsEnabled}
                        onSaved={onSaved}
                        onCancel={() => setEditing(null)}
                      />
                    )}
                  </div>
                ) : null}

                {outcomeOpen ? (
                  <Block className="mt-4 rounded-lg border border-border px-4 py-3 first:pt-3">
                    <Label
                      actions={
                        <Button variant="ghost" className={dense.sm} onClick={() => setOutcomeOpen(false)}>
                          Close
                        </Button>
                      }
                    >
                      Notes and outcome
                    </Label>
                    <OutcomeForm
                      state={state}
                      view={todayView}
                      enabled={todayView.actionsEnabled}
                      actions={actions}
                      callSessionId={call.state.phase === 'ended' && callFirm === expanded.firmId ? call.state.sessionId : null}
                    />
                  </Block>
                ) : null}

                {todayView.tasks.length === 0 ? null : (
                  <Block className="mt-4">
                    <Label>On today’s list</Label>
                    <ul data-testid="today-tasks" className="flex flex-col">
                      {todayView.tasks.map(entry => (
                        <TaskRow key={entry.task.itemId} entry={entry} state={state} actionsEnabled={todayView.actionsEnabled} actions={actions} />
                      ))}
                    </ul>
                  </Block>
                )}

                {history.progress !== null && history.latest !== null && recentCall(history.latest) ? (
                  <Block data-testid="latest-call" className="mt-4 rounded-lg border border-border px-4 py-3 first:pt-3">
                    <Label>Latest call</Label>
                    <div className="flex flex-wrap gap-1.5">
                      <StepChip label="Call" state={history.progress.call.state} word={history.progress.call.word} testId="latest-step-call" />
                      <StepChip label="Recording" state={history.progress.recording.state} word={history.progress.recording.word} testId="latest-step-recording" />
                      <StepChip label="Transcript" state={history.progress.transcription.state} word={history.progress.transcription.word} testId="latest-step-transcription" />
                      <StepChip label="Summary" state={history.progress.analysis.state} word={history.progress.analysis.word} testId="latest-step-analysis" />
                    </div>
                    {history.latest.summary === undefined ? (
                      history.progress.sentence === null ? null : (
                        <p className="mt-2 text-sm text-muted-foreground">{history.progress.sentence}</p>
                      )
                    ) : (
                      <p data-testid="latest-call-summary" className="mt-2 text-base">
                        {history.latest.summary.summary}
                      </p>
                    )}
                  </Block>
                ) : null}

                <div className="mt-6">
                  <TodayBrief
                    brief={expanded.brief ?? null}
                    calls={history.calls}
                    enabled={todayView.actionsEnabled}
                    researching={actions.busy(todayForm.research(expanded.firmId))}
                    onResearchAgain={() => actions.researchAgain(expanded.firmId)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex w-[280px] shrink-0 flex-col border-l border-border min-[1280px]:w-[300px] min-[1440px]:w-[320px] min-[1920px]:w-[360px]">
            <CallPanel
              state={state}
              view={todayView}
              actions={actions}
              call={call}
              status={status}
              firmId={firmId}
              blockers={blockers}
              progress={history.progress}
              hasNext={next !== null}
              onFix={blocker => setEditing(blocker === 'no_phone' ? 'phone' : 'regionCode')}
              onNext={goNext}
              onOutcome={() => setOutcomeOpen(true)}
            />
          </div>
        </div>
      )}

      <Dialog open={dialog === 'help'} title="Keyboard shortcuts" onClose={() => setDialog(null)} data-testid="help">
        <ul className="flex flex-col">
          {SHORTCUTS.filter(shortcut => SUPPORTED.includes(shortcut.action)).map(shortcut => (
            <li key={shortcut.action} className="flex items-center justify-between border-b border-border py-1.5 last:border-b-0">
              <span>{shortcut.label}</span>
              <span className="flex gap-1">
                {shortcut.keys.map(key => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">No shortcut starts a call. Shortcuts pause while you type in a field.</p>
      </Dialog>

      <SearchDialog
        open={dialog === 'search'}
        cards={cards}
        onClose={() => setDialog(null)}
        onPick={id => {
          setDialog(null);
          select(id);
        }}
      />

      <LogIncomingDialog
        open={dialog === 'incoming'}
        cards={cards}
        firmId={firmId}
        contactsFor={contactsFor}
        enabled={todayView?.actionsEnabled ?? false}
        onClose={() => setDialog(null)}
        onLogged={(_id, answer) => {
          setDialog(null);
          setIncomingNotice(noticeSentence(answer.reason ?? 'incoming_logged'));
          today.refresh();
        }}
      />
    </div>
  );
}
