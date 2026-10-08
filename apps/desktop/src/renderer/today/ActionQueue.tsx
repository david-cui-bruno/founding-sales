import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { todayActionsResponseSchema, reasonSentence, type TodayActionsResponse, type TodayAction } from '@fss/contracts';
import { navigate,routeForAction } from '../routes.ts';
import { Button } from '../ui/button.tsx';

/** Current metadata in mounted React state only; no cache or message content. */
export function ActionQueue({ refreshKey, enabled }: { readonly refreshKey: string | null; readonly enabled: boolean }): JSX.Element {
  const [read, setRead] = useState<TodayActionsResponse | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const issued = useRef(0);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    const number = ++issued.current;
    const pending = enabled ? globalThis.callieApi?.read('today.actions', {}) : undefined;
    if (pending === undefined) { setRead(null); return; }
    void pending.then(value => { if (alive.current && number === issued.current) { const parsed = todayActionsResponseSchema.safeParse(value); setRead(parsed.success ? parsed.data : null); } }, () => { if (alive.current && number === issued.current) setRead(null); });
  }, [enabled]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh, refreshKey]);
  const open = async (action: TodayAction): Promise<void> => {
    setBusy(action.actionId);
    setNotice(null);
    try {
      const answer = await globalThis.callieApi?.read('today.openAction', { actionId: action.actionId, target: action.target });
      if (!alive.current) return;
      const target = answer?.target;
      if (target == null) { setNotice(answer === null || answer === undefined ? 'Actions are unavailable. Try again.' : 'This action changed. Today has been refreshed.'); refresh(); return; }
      navigate(routeForAction(target));
    } catch {
      if (alive.current) setNotice('Actions are unavailable. Try again.');
    } finally { if (alive.current) setBusy(null); }
  };
  return <section aria-label="Actions" className="shrink-0 border-b border-border px-5 py-3" data-testid="today-actions">
    {read === undefined ? <p className="text-sm text-muted-foreground">Loading actions…</p> : read === null ? <p className="text-sm text-muted-foreground">Actions are unavailable. <Button variant="quiet" size="sm" onClick={refresh}>Retry actions</Button></p> : read.actions.length === 0 ? <p className="text-sm text-muted-foreground">No actions need you.</p> : <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">{read.actions.map(action => <li key={action.actionId} className="flex items-center gap-3">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{action.subject}</p><p className="text-xs text-muted-foreground">{action.kind === 'reply' ? action.reason === 'reply_review' ? action.state === 'overdue' ? 'Overdue reply review' : 'Reply needs review' : action.state === 'overdue' ? 'Overdue reply' : 'Substantive reply' : action.kind === 'call' ? `Upcoming call · ${new Date(action.dueAt).toLocaleString(undefined, { timeZone: read.businessTimeZone })}` : reasonSentence(action.reason)}</p></div>
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { void open(action); }}>{action.kind === 'reply' ? 'Open reply' : action.kind === 'call' ? 'Open call' : 'Open settings'}</Button>
    </li>)}</ul>}
    {notice === null ? null : <p role="status" className="mt-2 text-sm text-muted-foreground">{notice}</p>}
  </section>;
}
