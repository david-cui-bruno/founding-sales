import {ManualWork} from '../ask/ManualWork.tsx';
import {NotificationStatus,type NotificationStatusPort} from './NotificationStatus.tsx';
import {operations} from '../app/bridges.ts';
import { ActionQueue } from './ActionQueue.tsx';
import {FirmQualification} from '../sourcing/FirmQualification.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CornerDownLeft, HelpCircle, ListTodo, NotebookPen, Pencil, PhoneIncoming, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { TodayCardBlocker } from '@fss/contracts';
import type { AnalysisView, FirmBasicsAnswer } from '../../shared/operations.ts';
import type { CallControl } from '../calling/useCall.ts';
import { useCallingStatus } from '../calling/useCallingStatus.ts';
import { UNAVAILABLE, type HomeView } from '../homeView.ts';
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
import { BLOCKER_FIXES, BLOCKER_SENTENCES, blockersOf, groupOf } from './queueView.ts';
import { TaskRow } from './TaskRow.tsx';
import { Feedback } from './Feedback.tsx';
import { AfterCallAnalysis } from './AfterCallAnalysis.tsx';
import { Overview } from './Overview.tsx';
import { Recap } from './Recap.tsx';
import { ReviewGroup, ReviewPanel } from './ReviewItems.tsx';
import { MeetingRecoveryQueue } from '../recordings/MeetingRecoveryQueue.tsx';
import { RecordingsToSort } from '../recordings/RecordingsToSort.tsx';
import { WAITING_WINDOW_MS, analysisKey, phaseOf, useAnalyses, useReview, type Watch } from './useAnalysis.ts';
import { HomeExtras, UpdatedLine } from './TodayColumn.tsx';
import { TodayBrief } from './TodayBrief.tsx';
import { PreparedBrief } from '../research/PreparedBrief.tsx';
import { callTimer } from '../calling/callText.ts';
import { callHistoryKey, useCallProgress } from './useCallProgress.ts';
import { todayForm, type Today } from './useToday.ts';
import { useTodayInteraction, type TodayMemory } from './useTodayInteraction.ts';

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

export { useTodayMemory, type TodayMemory, type OpenPanels } from './useTodayInteraction.ts';

/** A call worth showing the steps of: placed in the last day. Older ones are history. */
function recentCall(call: { readonly startedAt: string | null; readonly endedAt: string | null }): boolean {
  const at = Date.parse(call.endedAt ?? call.startedAt ?? '');
  return Number.isFinite(at) && Date.now() - at < 24 * 60 * 60_000;
}

const SUPPORTED: readonly ShortcutAction[] = ['next', 'previous', 'search', 'edit', 'help', 'close'];

/**
 * The one chip above a firm's name, and only when it says something the queue beside it
 * does not. The lane — callback, replied, due, new — is the queue's group heading and the
 * task rows' own words (slice 3a, C0), so repeating it here was noise; what stays is the
 * firm that is not on the list at all and the one that cannot be called, with the reason.
 */
function laneChip(card: TodayCard | undefined, blockers: readonly TodayCardBlocker[]): JSX.Element | null {
  if (card === undefined) return <Chip tone="outline">Not on today’s list</Chip>;
  if (groupOf(card) === 'blocked' && blockers.length > 0) return <Chip tone="warn">Can’t call yet</Chip>;
  return null;
}

/**
 * The latest call's steps. The notes chip reads the CURRENT analysis (the same state the
 * after-call block shows), not the legacy summary chip: while the block says "Writing the
 * notes…" this must not say "Summary done" or "in progress" from an older record.
 */
function LatestCall({
  history,
  view,
  waiting,
}: {
  readonly history: ReturnType<typeof useCallProgress>;
  readonly view: AnalysisView | undefined;
  readonly waiting: boolean;
}): JSX.Element | null {
  const progress = history.progress;
  const latest = history.latest;
  if (progress === null || latest === null) return null;
  const phase = view === undefined ? 'absent' : phaseOf(view, waiting);
  const notes =
    phase === 'pending' || phase === 'waiting'
      ? { state: 'pending' as const, word: 'being written' }
      : phase === 'completed'
        ? { state: 'done' as const, word: 'ready' }
        : phase === 'failed'
          ? { state: 'failed' as const, word: 'could not be written' }
          : { state: progress.analysis.state, word: progress.analysis.word };
  const known = phase !== 'absent';
  return (
    <Block data-testid="latest-call" className="mt-4 rounded-lg border border-border px-4 py-3 first:pt-3">
      <Label>Latest call</Label>
      <div className="flex flex-wrap gap-1.5">
        <StepChip label="Call" state={progress.call.state} word={progress.call.word} testId="latest-step-call" />
        <StepChip label="Recording" state={progress.recording.state} word={progress.recording.word} testId="latest-step-recording" />
        <StepChip label="Transcript" state={progress.transcription.state} word={progress.transcription.word} testId="latest-step-transcription" />
        <StepChip label="Notes" state={notes.state} word={notes.word} testId="latest-step-analysis" />
      </div>
      {known ? null : latest.summary === undefined ? (
        progress.sentence === null ? null : (
          <p className="mt-2 text-sm text-muted-foreground">{progress.sentence}</p>
        )
      ) : (
        <p data-testid="latest-call-summary" className="mt-2 text-base">
          {latest.summary.summary}
        </p>
      )}
    </Block>
  );
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
  editing,
  outcomeOpen,
  onEdit,
  onOpen,
  onOutcome,
}: {
  readonly card: TodayCard | undefined;
  readonly name: string;
  readonly blockers: readonly TodayCardBlocker[];
  readonly meta: readonly string[];
  /** Whether each of the two forms is open: its button is then a toggle that closes it. */
  readonly editing: boolean;
  readonly outcomeOpen: boolean;
  onEdit(): void;
  onOpen(): void;
  onOutcome(): void;
}): JSX.Element {
  const chip = laneChip(card, blockers);
  return (
    <header data-testid="firm-header" className="flex flex-col gap-1.5">
      {chip === null ? null : <div className="flex flex-wrap items-center gap-1.5">{chip}</div>}
      <div className="flex items-start justify-between gap-4">
        <h1 data-testid="firm-name" title={name} className="line-clamp-2 min-w-0 text-2xl font-semibold tracking-tight text-balance">
          {name}
        </h1>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button variant="ghost" data-testid="firm-outcome" aria-expanded={outcomeOpen} title="Notes and outcome" aria-label="Notes and outcome" className={cn(dense.md, 'text-muted-foreground')} onClick={onOutcome}>
            <NotebookPen /> <span className="hidden min-[1440px]:inline">Notes and outcome</span>
          </Button>
          <Button variant="ghost" data-testid="firm-edit" aria-expanded={editing} className={cn(dense.md, 'text-muted-foreground')} onClick={onEdit}>
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

/** What needs acting on, whichever subtab is open and however narrow the window is. */
function Warnings({ warnings, onConnectMailbox }: { readonly warnings: HomeView['warnings']; onConnectMailbox(): void }): JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <ul data-testid="today-warnings" className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border bg-warn-soft/50 px-5 py-1.5">
      {warnings.map(row => (
        <li key={row.key} data-testid={`warning-${row.key}`} className="flex items-center gap-2 text-sm text-warn-ink">
          <span>{row.text}</span>
          {row.action === null ? null : row.action.kind === 'connect_mailbox' ? (
            <Button variant="outline" className={cn(dense.sm, 'bg-background')} data-testid="warning-action" disabled={!row.action.enabled} onClick={onConnectMailbox}>
              {row.action.label}
            </Button>
          ) : (
            <Button
              variant="outline"
              className={cn(dense.sm, 'bg-background')}
              data-testid="warning-action"
              onClick={() => {
                if (row.action?.kind === 'open') navigate(row.action.route);
              }}
            >
              {row.action.label}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const notificationStatusPort:NotificationStatusPort={
 read:async()=>{const api=operations();return api?await api.read('notifications.read',{}):{ok:false,reason:'unavailable',offline:false};},
 runtime:async()=>{const api=operations();return api?await api.read('notifications.runtime',{}):{state:'unavailable',lastCheckedAt:null};},
};
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

  // Slice 3a, lane C: each call's analysis is read by its own session (`useAnalysis.ts`), never by
  // the open view. The open firm's panel reads its latest recent answered call; every call placed
  // in this sitting is watched too, so notes that finish while David is on the next call are found
  // and update only their own firm's mark and Needs review items.
  const latest = history.latest;
  const latestEnded = latest === null ? Number.NaN : Date.parse(latest.endedAt ?? latest.startedAt ?? '');
  const panelSession: Watch | null =
    firmId === null
      ? null
      : latest !== null && latest.answeredAt !== null && recentCall(latest)
        ? { callSessionId: latest.sessionId, endedAt: Number.isFinite(latestEnded) ? latestEnded : Date.now() }
        : (memory.sessions.current.get(firmId) ?? null);
  const watched = new Map<string, Watch>();
  for (const entry of memory.sessions.current.values()) watched.set(entry.callSessionId, entry);
  if (panelSession !== null) watched.set(panelSession.callSessionId, panelSession);
  const analyses = useAnalyses([...watched.values()]);
  const queries = useQueryClient();
  const queryReload = async (callSessionId: string): Promise<void> => {
    await queries.invalidateQueries({ queryKey: analysisKey(callSessionId) });
  };
  const [dialog, setDialog] = useState<'search' | 'help' | 'incoming' | null>(null);
  const review = useReview(hasTodayBridge);
  // Today opens on the Queue every time it is mounted; Overview is a look away from it.
  const [subtab, setSubtab] = useState<'queue' | 'overview'>('queue');
  const {
    live, callFirm, editing, outcomeTarget, outcomeOpen, queueOpen, firmRegion,
    select, openSessionOutcome, closeOutcome, openCurrentOutcome, outcomeSubmitted, toggleOutcome,
    editBasics, closeBasics, toggleQueue, closeQueue, walkQueue, hasNext, goNext,
  } = useTodayInteraction({ today, call, memory, reloadCallingStatus: status.reload, refreshCallHistory: history.refresh });
  const [incomingNotice, setIncomingNotice] = useState<string | null>(null);

  const editFirst = (): BasicsField => (blockers.includes('no_phone') ? 'phone' : blockers.includes('no_location') ? 'regionCode' : 'phone');

  useShortcuts({
    next: () => walkQueue(1),
    previous: () => walkQueue(-1),
    search: () => setDialog('search'),
    help: () => setDialog('help'),
    edit: () => {
      if (firmId !== null) editBasics(editFirst());
    },
    close: () => {
      if (dialog !== null) setDialog(null);
      else if (editing !== null) closeBasics();
      else if (outcomeOpen) closeOutcome();
      else if (queueOpen) closeQueue();
    },
  });

  const onSaved = (answer: FirmBasicsAnswer): void => {
    closeBasics();
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

  // No registry: say so where Today would be. No answer yet: the regions wait, empty.
  const unavailable = !hasTodayBridge || actions === null;
  const loading = state === null || todayView === null;

  const loggedSessions = new Set((history.calls ?? []).filter(call => call.callLogId !== null).map(call => call.sessionId));
  // `reload` is captured by a pending Apply, so a late answer for firm A can arrive after Today
  // was left and another firm opened. It captures the firm at Apply time, always invalidates that
  // firm's caches, and re-opens a firm only when the firm on screen according to the shell's
  // memory (which outlives this view) is still that firm. It never navigates.
  const reload = (): void => {
    review.reload();
    if (firmId !== null) void queries.invalidateQueries({ queryKey: callHistoryKey(firmId) });
    if (firmId !== null && memory.panels.current.firmId === firmId) actions?.expand(firmId);
    today.refresh();
  };
  const marks: Record<string, string> = {};
  for (const [entryFirm, entry] of memory.sessions.current) {
    if (entryFirm === firmId) continue;
    const phase = phaseOf(analyses.get(entry.callSessionId), Date.now() - entry.endedAt < WAITING_WINDOW_MS);
    if (phase === 'pending' || phase === 'waiting') marks[entryFirm] = 'Writing the notes…';
    else if (phase === 'completed') marks[entryFirm] = 'Notes ready';
    else if (phase === 'failed') marks[entryFirm] = 'Notes could not be written';
  }
  const reviewItems = review.items ?? [];
  const afterBlock =
    firmId === null || expanded === null ? null : (
      <div className="flex flex-col gap-4" data-testid="after-block">
        {panelSession === null ? null : (
          <AfterCallAnalysis
            view={analyses.get(panelSession.callSessionId)}
            sessionId={panelSession.callSessionId}
            waiting={Date.now() - panelSession.endedAt < WAITING_WINDOW_MS}
            logged={loggedSessions.has(panelSession.callSessionId)}
            loggedOutcome={(history.calls ?? []).find(call => call.sessionId === panelSession.callSessionId)?.outcome ?? null}
            loggedCallLogId={(history.calls ?? []).find(call => call.sessionId === panelSession.callSessionId)?.callLogId ?? null}
            timeZone={basics?.timeZone ?? null}
            onCorrected={() => {
              reload();
              void queryReload(panelSession.callSessionId);
            }}
            templates={state?.followUpTemplates ?? []}
            commands={memory.applyCommands}
            onReload={() => {
              void queryReload(panelSession.callSessionId);
            }}
            onChanged={reload}
            onEnterManually={() => {
              openSessionOutcome(panelSession.callSessionId);
            }}
          />
        )}
        <ReviewPanel
          items={reviewItems}
          firm={{
            firmId,
            values: { locality: basics?.locality ?? null, regionCode: basics?.regionCode ?? null, timeZone: basics?.timeZone ?? null },
            phone: primaryRoute === null ? null : { routeId: primaryRoute.routeId, e164: primaryRoute.e164 },
            enabled: todayView?.actionsEnabled ?? false,
            loggedSessions,
          }}
          onChanged={() => {
            reload();
            if (panelSession !== null) void queryReload(panelSession.callSessionId);
          }}
          onLog={callSessionId => {
            openSessionOutcome(callSessionId);
          }}
        />
      </div>
    );

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <Button
        variant="ghost"
        data-testid="queue-toggle"
        className={cn(dense.md, 'text-muted-foreground min-[1280px]:hidden', subtab !== 'queue' && 'hidden')}
        aria-expanded={queueOpen}
        aria-label="Show the list of firms"
        title="Show the list of firms"
        onClick={toggleQueue}
      >
        <ListTodo />
      </Button>
      <h1 data-testid="heading" className="shrink-0 text-sm font-semibold whitespace-nowrap">
        {home.heading}
      </h1>
      <nav aria-label="Today" className="flex shrink-0 items-center gap-0.5">
        {(['queue', 'overview'] as const).map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={subtab === name}
            data-testid={`today-tab-${name}`}
            onClick={() => setSubtab(name)}
            className={cn(
              'rounded-md px-2 py-1 text-sm transition-colors',
              subtab === name ? 'bg-selected font-medium text-foreground' : 'text-muted-foreground hover:bg-pressed hover:text-foreground',
            )}
          >
            {name === 'queue' ? 'Queue' : 'Overview'}
          </button>
        ))}
      </nav>
      <span data-testid="summary" className="hidden truncate text-sm text-muted-foreground empty:hidden min-[1100px]:inline">
        {home.summary ?? ''}
      </span>
      {/* "Updated 2 min ago" is routine and lives in Settings › Status. Only the failure
          stays here, with its Retry: that is something to act on. */}
      {state === null || !hasTodayBridge ? null : (
        <span className="hidden whitespace-nowrap min-[1280px]:inline">
          <UpdatedLine state={state} now={today.now} refreshAnswered={today.refreshAnswered} onRefresh={onRefresh} failureOnly />
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

  // What is true of the whole list. A command's answer is drawn where it was pressed.
  const notices = home.notices;
  const feedback = todayView?.feedback == null ? null : {
    ...todayView.feedback,
    zone:
      todayView.feedback.zone === 'outcome' && !outcomeOpen
        ? ('firm' as const)
        : todayView.feedback.zone === 'tasks' && todayView.tasks.length === 0
          ? ('firm' as const)
          : todayView.feedback.zone,
  };

  return (
    <div data-testid="home" data-region="today" aria-busy={today.pending > 0} className="callie-v2 flex h-screen min-w-0 flex-col">
      {header}
      <Warnings warnings={home.warnings ?? []} onConnectMailbox={onConnectMailbox} />
      {notices.length === 0 ? null : (
        <div data-testid="banners" className="flex flex-col gap-1.5 border-b border-border px-5 py-2">
          {notices.map(notice => (
            <Alert key={`${notice.tone}:${notice.text}`} tone={notice.tone} data-testid={`banner-${notice.tone}`} className="py-1.5 text-sm">
              {notice.text}
            </Alert>
          ))}
        </div>
      )}
      {live && subtab === 'overview' ? (
        // The call and the recording stay visible whichever tab is open.
        <div data-testid="today-live-call" className="flex items-center gap-3 border-b border-border bg-ok-soft px-5 py-1.5 text-sm">
          <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-hidden />
          <span data-testid="today-live-call-status" className="flex-1 text-ok-ink">
            {call.state.phase === 'connected' ? 'On a call · recording' : call.state.phase === 'ringing' ? 'Ringing…' : 'Starting the call…'}
            {call.state.phase === 'connected' ? <span className="ml-2 font-mono tabular">{callTimer(call.seconds)}</span> : null}
          </span>
          <button type="button" data-testid="today-live-call-show" className="text-sm font-medium underline-offset-2 hover:underline" onClick={() => setSubtab('queue')}>
            Back to the call
          </button>
        </div>
      ) : null}
      <ManualWork scope={{kind:'today'}} enabled={hasTodayBridge} privacyKey={state?.asOf??null}/>
      <ActionQueue refreshKey={state?.asOf ?? null} enabled={hasTodayBridge} />
      <NotificationStatus port={notificationStatusPort}/>
      {unavailable ? (
        <div className="max-w-[640px] p-6">
          <p data-testid="today-unavailable" className="text-sm text-muted-foreground">
            {UNAVAILABLE}
          </p>
          <HomeExtras home={home} onConnectMailbox={onConnectMailbox} />
        </div>
      ) : loading ? (
        <div data-testid="today" aria-busy={today.pending > 0} className="flex-1" />
      ) : subtab === 'overview' ? (
        <Overview home={home} extras={<Recap />} />
      ) : (
        <div data-testid="today" aria-busy={today.pending > 0} className="relative flex min-h-0 flex-1">
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
              callFirm={live ? callFirm : null}
              scrollTop={memory.queueScroll.current}
              onScroll={top => {
                memory.queueScroll.current = top;
              }}
              onSelect={select}
              footer={<HomeExtras home={home} onConnectMailbox={onConnectMailbox} compact showFigures={false} />}
              marks={marks}
              review={
                <>
                {review.items === null ? null : (
                  <>
                    <ReviewGroup items={review.items} cards={cards} selected={firmId} onSelect={select} onChanged={reload} />
                    {review.failed ? (
                      <p data-testid="review-refresh-failed" role="status" className="mb-3 flex items-center gap-1 px-2 text-xs text-muted-foreground">
                        Couldn’t refresh.
                        <button type="button" data-testid="review-refresh-retry" className="underline underline-offset-2 hover:text-foreground" onClick={review.reload}>
                          Retry
                        </button>
                      </p>
                    ) : null}
                  </>
                )}
                {/* Lane M4: a demo recording that needs a meeting chosen, or failed. Quiet otherwise. */}
                <RecordingsToSort />
                <MeetingRecoveryQueue />
                </>
              }
            />
          </div>

          <div ref={firmRegion} data-region="firm" data-testid="today-firm" className="min-w-0 flex-1 overflow-y-auto">
            {expanded === null ? (
              <p data-testid="today-empty" className="pt-24 text-center text-sm text-muted-foreground">
                {cards.length === 0 ? (home.lanes?.emptyLine ?? todayView.emptyMessage ?? 'Nothing is due today.') : 'Pick a firm from the queue.'}
              </p>
            ) : (
              <div className="mx-auto flex max-w-[760px] flex-col px-8 pt-6 pb-16">
                <FirmHeader
                  card={card}
                  name={expanded.firmName}
                  blockers={blockers}
                  meta={meta}
                  editing={editing !== null}
                  outcomeOpen={outcomeOpen}
                  onEdit={() => editing === null ? editBasics(editFirst()) : closeBasics()}
                  onOpen={() => navigate({ name: 'firm', firmId: expanded.firmId })}
                  onOutcome={toggleOutcome}
                />
                {incomingNotice === null ? null : (
                  <p data-testid="feedback-incoming" role="status" className="py-1 text-sm text-muted-foreground">
                    {incomingNotice}
                  </p>
                )}
                <Feedback feedback={feedback} zone="firm" />
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
                            onClick={() => editBasics(blocker === 'no_phone' ? 'phone' : 'regionCode')}
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
                        onCancel={closeBasics}
                      />
                    )}
                  </div>
                ) : null}

                {outcomeTarget !== null ? (
                  <div
                    data-testid="outcome-panel"
                    onKeyDown={event => {
                      // Escape closes the form and keeps what was typed: the text is in the
                      // shell's draft store, not in this form.
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        closeOutcome();
                      }
                    }}
                  >
                  <Block className="mt-4 rounded-lg border border-border px-4 py-3 first:pt-3">
                    <Label
                      actions={
                        <Button variant="ghost" className={dense.sm} onClick={closeOutcome}>
                          Close <Kbd className="ml-0.5">Esc</Kbd>
                        </Button>
                      }
                    >
                      Notes and outcome
                    </Label>
                    <Feedback feedback={feedback} zone="outcome" />
                    <OutcomeForm
                      state={state}
                      view={todayView}
                      enabled={todayView.actionsEnabled}
                      actions={actions}
                      callSessionId={call.state.phase === 'ended' && callFirm === expanded.firmId ? call.state.sessionId : null}
                      target={outcomeTarget}
                      onSubmitted={outcomeSubmitted}
                    />
                  </Block>
                  </div>
                ) : null}

                {todayView.tasks.length === 0 ? null : (
                  <Block className="mt-4">
                    <Label>On today’s list</Label>
                    <Feedback feedback={feedback} zone="tasks" />
                    <ul data-testid="today-tasks" className="flex flex-col">
                      {todayView.tasks.map(entry => (
                        <TaskRow key={entry.task.itemId} entry={entry} state={state} actionsEnabled={todayView.actionsEnabled} actions={actions} />
                      ))}
                    </ul>
                  </Block>
                )}

                {history.progress !== null && history.latest !== null && recentCall(history.latest) ? (
                  <LatestCall history={history} view={analyses.get(history.latest.sessionId)} waiting={Date.now() - (Number.isFinite(latestEnded) ? latestEnded : Date.now()) < WAITING_WINDOW_MS} />
                ) : null}

                {/* Lane PB: the prepared brief, negotiated on the card read, above Callie's own research. */}
                {state?.role==='admin'?<FirmQualification key={`qualification:${expanded.firmId}`} firmId={expanded.firmId} enabled={state.mayMutate&&!live}/>:null}
                {expanded.preparedBrief == null ? null : (
                  <div className="mt-6">
                    <PreparedBrief key={expanded.firmId} brief={expanded.preparedBrief} />
                  </div>
                )}

                <div className="mt-6">
                  <TodayBrief
                    brief={expanded.brief ?? null}
                    calls={history.calls}
                    enabled={todayView.actionsEnabled}
                    researching={actions.busy(todayForm.research(expanded.firmId))}
                    onResearchAgain={() => actions.researchAgain(expanded.firmId)}
                    timeZone={basics?.timeZone ?? null}
                    onCorrected={reload}
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
              hasNext={hasNext}
              onFix={blocker => editBasics(blocker === 'no_phone' ? 'phone' : 'regionCode')}
              onNext={goNext}
              onOutcome={openCurrentOutcome}
              feedback={feedback}
              afterBlock={afterBlock}
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
