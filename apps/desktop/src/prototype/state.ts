/**
 * The prototype's starting state, read from the query string so every screenshot is one
 * URL: `?view=today&firm=trinity-ridge&call=connected`. Interactive use starts from the
 * defaults and moves through the states by pressing the real controls.
 */

export type View = 'today' | 'pipeline' | 'firm';
export type CallPhase = 'idle' | 'dialling' | 'connected' | 'ended';
export type Analysis = 'running' | 'pending' | 'done' | 'failed';
export type LoadState = 'ready' | 'loading' | 'error' | 'empty';

export interface Start {
  readonly view: View;
  readonly firm: string;
  readonly call: CallPhase;
  readonly analysis: Analysis;
  readonly queue: LoadState;
  readonly brief: 'ready' | 'loading';
  readonly panel: string | null;
  readonly lost: boolean;
  readonly edit: string | null;
  readonly dialog: 'help' | 'search' | 'log' | null;
  readonly research: boolean;
  /** Hide the prototype's own state switcher (screenshots). */
  readonly clean: boolean;
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function readStart(search: string): Start {
  const q = new URLSearchParams(search);
  return {
    view: pick(q.get('view'), ['today', 'pipeline', 'firm'], 'today'),
    firm: q.get('firm') ?? 'trinity-ridge',
    call: pick(q.get('call'), ['idle', 'dialling', 'connected', 'ended'], 'idle'),
    analysis: pick(q.get('analysis'), ['running', 'pending', 'done', 'failed'], 'running'),
    queue: pick(q.get('queue'), ['ready', 'loading', 'error', 'empty'], 'ready'),
    brief: pick(q.get('brief'), ['ready', 'loading'], 'ready'),
    panel: q.get('panel'),
    lost: q.get('lost') === '1',
    edit: q.get('edit'),
    dialog: q.get('dialog') === null ? null : pick<'help' | 'search' | 'log'>(q.get('dialog'), ['help', 'search', 'log'], 'help'),
    research: q.get('research') === '1',
    clean: q.get('clean') === '1',
  };
}
