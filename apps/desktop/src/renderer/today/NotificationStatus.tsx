import { actionableNotificationsResponseSchema, notificationRuntimeStatusSchema, type ActionableNotificationsResponse, type NotificationRuntimeStatus } from '@fss/contracts';
import type { ApiOutcome } from '../../main/apiClient.ts';
import { useEffect, useState } from 'react';

export interface NotificationStatusPort {
  read(): Promise<ApiOutcome<ActionableNotificationsResponse>>;
  runtime(): Promise<NotificationRuntimeStatus>;
}
interface Snapshot { port: NotificationStatusPort; state: NotificationRuntimeStatus['state']; items: ActionableNotificationsResponse['items'] }
const receiptLabel = {
  attempting: 'Native alert attempted; no show observed',
  native_shown: 'Native show observed; awaiting acknowledgement',
  acknowledged: 'Acknowledged', failed: 'Native alert failed', unknown: 'Native outcome unknown',
};
export function NotificationStatus({ port }: { port: NotificationStatusPort }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    let mounted = true, request = 0;
    async function refresh() {
      const generation = ++request;
      try {
        const [result, rawRuntime] = await Promise.all([port.read(), port.runtime()]);
        if (!mounted || request !== generation) return;
        const runtime = notificationRuntimeStatusSchema.parse(rawRuntime);
        setSnapshot({ port, state: result.ok ? runtime.state : result.offline ? 'offline' : 'unavailable', items: result.ok ? actionableNotificationsResponseSchema.parse(result.value).items : [] });
      } catch { if (mounted && request === generation) setSnapshot({ port, state: 'unavailable', items: [] }); }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { mounted = false; request++; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [port]);
  if (snapshot?.port !== port || snapshot.state === 'ready' && snapshot.items.length === 0) return null;
  return <section aria-label="Desktop alert status" className="rounded-lg border border-border p-3 text-sm">
    <p className="font-medium">Desktop alerts</p>
    <p className="text-muted-foreground">{snapshot.state === 'offline' ? 'Alerts are unavailable while offline.' : snapshot.state === 'unavailable' ? 'Alert status is unavailable.' : snapshot.state === 'unsupported' ? 'Native alerts are unavailable on this device.' : snapshot.state === 'stopped' ? 'Alerts pause while Callie is closed or asleep.' : 'Alerts are checked while Callie is open and awake.'}</p>
    {snapshot.items.map(item => <div key={item.eventKey} className="mt-2"><span>{item.subject}</span><p>{item.receipt === null ? 'Alert pending' : receiptLabel[item.receipt.status]}</p></div>)}
    <p className="mt-2 text-muted-foreground">Today work stays open until it is resolved.</p>
  </section>;
}
