import { CornerDownLeft, HelpCircle, PhoneIncoming, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { cn } from '../renderer/lib/utils.ts';
import { Button } from '../renderer/ui/button.tsx';
import { Dialog } from '../renderer/ui/dialog.tsx';
import { Input } from '../renderer/ui/input.tsx';
import { Select } from '../renderer/ui/select.tsx';
import { Textarea } from '../renderer/ui/textarea.tsx';
import { BOARD_ONLY, FIRMS, firmById, ineligibility } from './fixtures.ts';
import { dense, Kbd } from './parts.tsx';
import { FirmScreen } from './firm/FirmScreen.tsx';
import { Pipeline } from './pipeline/Pipeline.tsx';
import { Rail } from './shell/Rail.tsx';
import { SHORTCUTS, useShortcuts } from './shortcuts.ts';
import type { Analysis, CallPhase, LoadState, Start, View } from './state.ts';
import type { Steps } from './today/CallPanel.tsx';
import { orderedQueue } from './today/Queue.tsx';
import { Today } from './today/Today.tsx';

/**
 * The prototype's shell and its one piece of state. Everything is fixture data held in
 * memory; nothing is fetched, nothing is saved, and the call is a simulation that moves
 * through the real states when its buttons are pressed.
 */

function stepsFor(analysis: Analysis): Steps {
  if (analysis === 'done') return { recording: 'done', transcription: 'done', analysis: 'done' };
  if (analysis === 'failed') return { recording: 'done', transcription: 'failed', analysis: 'waiting' };
  if (analysis === 'pending') return { recording: 'done', transcription: 'done', analysis: 'pending' };
  return { recording: 'pending', transcription: 'waiting', analysis: 'waiting' };
}

const PRESETS: readonly { readonly label: string; readonly query: string }[] = [
  { label: 'Today · idle', query: '' },
  { label: 'Today · connected', query: 'call=connected' },
  { label: 'Today · analysis pending', query: 'call=ended&analysis=pending' },
  { label: 'Today · analysis done', query: 'call=ended&analysis=done' },
  { label: 'Today · transcription failed', query: 'call=ended&analysis=failed' },
  { label: 'Today · long name', query: 'firm=brazos-valley' },
  { label: 'Today · missing phone', query: 'firm=bluebonnet' },
  { label: 'Today · missing location', query: 'firm=elm-fork' },
  { label: 'Today · loading', query: 'queue=loading' },
  { label: 'Today · error', query: 'queue=error' },
  { label: 'Today · empty queue', query: 'queue=empty' },
  { label: 'Pipeline', query: 'view=pipeline' },
  { label: 'Pipeline · panel', query: 'view=pipeline&panel=cedar-hollow' },
  { label: 'Firm detail', query: 'view=firm' },
];

export function App({ start }: { readonly start: Start }): JSX.Element {
  const [view, setView] = useState<View>(start.view);
  const [from, setFrom] = useState<'today' | 'pipeline'>('today');
  const [firmId, setFirmId] = useState(start.firm);
  const [queueState, setQueueState] = useState<LoadState>(start.queue);
  const [phase, setPhase] = useState<CallPhase>(start.call);
  const [startedAt, setStartedAt] = useState(() => Date.now() - 134_000);
  const [endedSec, setEndedSec] = useState(252);
  const [steps, setSteps] = useState<Steps>(() => stepsFor(start.call === 'ended' && start.analysis === 'running' ? 'pending' : start.analysis));
  const [running, setRunning] = useState(start.call === 'ended' && start.analysis === 'running');
  const [done, setDone] = useState<readonly string[]>([]);
  const [editField, setEditField] = useState<string | null>(start.edit);
  const [dialog, setDialog] = useState<Start['dialog']>(start.dialog);
  const [panel, setPanel] = useState<string | null>(start.panel);
  const [showLost, setShowLost] = useState(start.lost);

  const queue = useMemo(() => (queueState === 'empty' ? [] : orderedQueue(FIRMS)), [queueState]);
  const firm = queueState === 'empty' ? undefined : firmById(firmId);

  // The post-call steps, advancing in place as the server would report them.
  useEffect(() => {
    if (!running) return;
    setSteps(stepsFor('running'));
    const timers = [
      setTimeout(() => setSteps({ recording: 'done', transcription: 'pending', analysis: 'waiting' }), 1200),
      setTimeout(() => setSteps({ recording: 'done', transcription: 'done', analysis: 'pending' }), 3500),
      setTimeout(() => {
        setSteps({ recording: 'done', transcription: 'done', analysis: 'done' });
        setRunning(false);
      }, 7000),
    ];
    return () => timers.forEach(clearTimeout);
  }, [running]);

  // Dialling connects on its own after a moment, as an answered call would.
  useEffect(() => {
    if (phase !== 'dialling') return;
    const id = setTimeout(() => {
      setStartedAt(Date.now());
      setPhase('connected');
    }, 2500);
    return () => clearTimeout(id);
  }, [phase]);

  const select = useCallback((id: string): void => {
    setFirmId(id);
    setEditField(null);
    setPhase('idle');
    setRunning(false);
  }, []);

  const move = (delta: 1 | -1): void => {
    if (view !== 'today' || queue.length === 0) return;
    if (phase === 'dialling' || phase === 'connected') return; // never leave a live call by a keystroke
    const index = queue.findIndex(item => item.id === firmId);
    const next = queue[Math.min(queue.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) select(next.id);
  };

  const edit = (): void => {
    if (firm === undefined) return;
    if (view === 'pipeline') return;
    const blocked = ineligibility(firm);
    setEditField(blocked?.field === 'Location' ? 'location' : 'phone');
  };

  useShortcuts({
    next: () => move(1),
    previous: () => move(-1),
    search: () => setDialog('search'),
    help: () => setDialog('help'),
    edit,
    today: () => setView('today'),
    pipeline: () => setView('pipeline'),
    firm: () => {
      setFrom(view === 'pipeline' ? 'pipeline' : 'today');
      setView('firm');
    },
    close: () => {
      if (dialog !== null) setDialog(null);
      else if (editField !== null) setEditField(null);
      else if (panel !== null) setPanel(null);
    },
  });

  const title = view === 'today' ? 'Today' : view === 'pipeline' ? 'Pipeline' : 'Firm';

  return (
    <div className="callie-v2 flex h-full">
      <Rail view={view} onView={setView} onSearch={() => setDialog('search')} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
          <h1 className="text-sm font-semibold">{title}</h1>
          {view === 'today' ? <span className="text-sm text-muted-foreground">Thursday 2 October · 4 calls done</span> : null}
          <div className="ml-auto flex items-center gap-1">
            {view === 'today' ? (
              <Button variant="ghost" data-testid="log-incoming" className={cn(dense.md, 'text-muted-foreground')} onClick={() => setDialog('log')}>
                <PhoneIncoming /> Log incoming call
              </Button>
            ) : null}
            <Button variant="ghost" className={cn(dense.icon, 'text-muted-foreground')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setDialog('help')}>
              <HelpCircle />
            </Button>
          </div>
        </div>

        {view === 'today' ? (
          <Today
            firms={queue}
            firm={firm}
            queueState={queueState}
            briefState={start.brief}
            phase={phase}
            startedAt={startedAt}
            endedSec={endedSec}
            steps={steps}
            done={done}
            editField={editField}
            researchOpen={start.research}
            onSelect={select}
            onCall={() => setPhase('dialling')}
            onHangUp={() => {
              if (phase === 'dialling') {
                setPhase('idle');
                return;
              }
              setEndedSec(Math.floor((Date.now() - startedAt) / 1000));
              setPhase('ended');
              setRunning(true);
            }}
            onNext={() => {
              setDone([...done, firmId]);
              const eligible = queue.filter(item => ineligibility(item) === null && item.id !== firmId && !done.includes(item.id));
              if (eligible[0] !== undefined) select(eligible[0].id);
            }}
            onRetryStep={() => setRunning(true)}
            onRetryQueue={() => {
              setQueueState('loading');
              setTimeout(() => setQueueState('ready'), 900);
            }}
            onEdit={edit}
            onOpenFirm={() => {
              setFrom('today');
              setView('firm');
            }}
          />
        ) : view === 'pipeline' ? (
          <Pipeline
            showLost={showLost}
            panel={panel}
            onToggleLost={() => setShowLost(!showLost)}
            onOpen={setPanel}
            onClose={() => setPanel(null)}
            onOpenFull={id => {
              if (firmById(id) === undefined) return;
              setFirmId(id);
              setFrom('pipeline');
              setView('firm');
            }}
          />
        ) : firm === undefined ? null : (
          <FirmScreen firm={firm} from={from} editField={editField} onBack={() => setView(from)} onEdit={edit} />
        )}
      </main>

      <Dialog open={dialog === 'help'} title="Keyboard shortcuts" onClose={() => setDialog(null)} data-testid="help">
        <ul className="flex flex-col">
          {SHORTCUTS.map(shortcut => (
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
        onClose={() => setDialog(null)}
        onPick={id => {
          setDialog(null);
          if (firmById(id) === undefined) {
            setView('pipeline');
            setPanel(id);
          } else if (queue.some(item => item.id === id)) {
            setView('today');
            select(id);
          } else {
            setFirmId(id);
            setView('firm');
          }
        }}
      />

      <Dialog
        open={dialog === 'log'}
        title="Log incoming call"
        onClose={() => setDialog(null)}
        data-testid="log-dialog"
        footer={
          <>
            <Button variant="ghost" className={dense.md} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button className={dense.md} onClick={() => setDialog(null)}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">A callback that reached your mobile. It goes on the firm’s timeline like any other call.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Firm
              <Select className="h-7 border-strong text-sm font-normal text-foreground" defaultValue="trinity-ridge">
                {FIRMS.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              When
              <Input className="h-7 border-strong text-sm font-normal" defaultValue="Today, 9:25 am" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            What happened
            <Textarea rows={3} className="resize-none border-strong text-sm font-normal" placeholder="Dana called back — wants to move the demo to Wednesday" />
          </label>
        </div>
      </Dialog>

      {start.clean ? null : <PrototypeSwitcher />}
    </div>
  );
}

function SearchDialog({ open, onClose, onPick }: { readonly open: boolean; onClose(): void; onPick(id: string): void }): JSX.Element | null {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => [...FIRMS.map(firm => ({ id: firm.id, name: firm.name, city: firm.city })), ...BOARD_ONLY.map(firm => ({ id: firm.id, name: firm.name, city: firm.city }))], []);
  const found = all.filter(item => item.name.toLowerCase().includes(text.trim().toLowerCase())).slice(0, 8);
  return (
    <Dialog open={open} title="Search firms" onClose={onClose} data-testid="search">
      <Input
        ref={input}
        aria-label="Search firms"
        placeholder="Firm name"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && found[0] !== undefined) onPick(found[0].id);
        }}
        className="h-8 border-strong text-sm"
      />
      <ul className="mt-2 flex flex-col">
        {found.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onPick(item.id)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', index === 0 && text !== '' && 'bg-muted')}
            >
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-xs text-faint">{item.city ?? 'No location'}</span>
              {index === 0 && text !== '' ? <CornerDownLeft className="size-3 text-faint" /> : null}
            </button>
          </li>
        ))}
        {found.length === 0 ? (
          <li className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Search className="size-3.5" /> No firm matches.
          </li>
        ) : null}
      </ul>
    </Dialog>
  );
}

/** The prototype's own control for jumping between states. Not part of the design. */
function PrototypeSwitcher(): JSX.Element {
  return (
    <details className="fixed bottom-3 left-[60px] z-40 rounded-lg border border-border bg-background text-xs shadow-md min-[1600px]:left-[228px]">
      <summary className="cursor-pointer list-none rounded-lg px-2.5 py-1.5 text-muted-foreground hover:text-foreground">Prototype states</summary>
      <ul className="flex max-h-[60vh] flex-col overflow-y-auto border-t border-border p-1">
        {PRESETS.map(preset => (
          <li key={preset.label}>
            <a className="block rounded-md px-2 py-1 hover:bg-muted" href={`?${preset.query}`}>
              {preset.label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
