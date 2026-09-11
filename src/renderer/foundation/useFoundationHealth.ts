import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { appHealthSchema, type AppHealth } from '../../shared/healthContract';

export type FoundationHealthState =
  | { status: 'loading' }
  | { status: 'ready'; health: AppHealth }
  | { status: 'failed' };

export type HealthObservation = {
  checkedAt: string | null;
  refreshing: boolean;
  refreshFailed: boolean;
};

export type FoundationHealth = FoundationHealthState & {
  retry(): void;
  observation?: HealthObservation;
};

type HealthApi = { get(): Promise<AppHealth> };
type HealthOwner = { api: HealthApi };
type ObservedState = FoundationHealthState & { owner: HealthOwner; observation: HealthObservation };
const emptyObservation = (): HealthObservation => ({ checkedAt: null, refreshing: false, refreshFailed: false });

/** Readonly observation. A logical deadline invalidates settlement, not the IPC. */
export function useFoundationHealth(api: HealthApi): FoundationHealth {
  const owner = useMemo(() => ({ api }), [api]);
  const [state, setState] = useState<ObservedState>(() => ({ owner, status: 'loading', observation: emptyObservation() }));
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const trigger = useRef<{ owner: HealthOwner; run(): void } | null>(null);
  const retry = useCallback(() => {
    if (currentOwner.current === owner && trigger.current?.owner === owner) trigger.current.run();
  }, [owner]);

  useEffect(() => {
    let active = true;
    let accepted: AppHealth | undefined;
    let observation = emptyObservation();
    let flight: { deadline: ReturnType<typeof setTimeout> } | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    const current = () => active && currentOwner.current === owner;
    const publish = (status: FoundationHealthState) => {
      if (current()) setState({ owner, ...status, observation });
    };
    const run = () => {
      if (!current() || flight !== null) return;
      observation = { ...observation, refreshing: true };
      publish(accepted ? { status: 'ready', health: accepted } : { status: 'loading' });
      const owns = () => current() && flight === request;
      const fail = () => {
        if (!owns()) return;
        clearTimeout(request.deadline);
        flight = null;
        observation = { ...observation, refreshing: false, refreshFailed: true };
        publish(accepted ? { status: 'ready', health: accepted } : { status: 'failed' });
      };
      const request = { deadline: setTimeout(fail, 15_000) };
      flight = request;
      try {
        void api.get().then(value => {
          if (!owns()) return;
          const parsed = appHealthSchema.safeParse(value);
          if (!parsed.success) { fail(); return; }
          clearTimeout(request.deadline);
          flight = null;
          accepted = parsed.data;
          observation = { checkedAt: new Date().toISOString(), refreshing: false, refreshFailed: false };
          publish({ status: 'ready', health: accepted });
        }, fail);
      } catch { fail(); }
    };
    const visible = () => document.visibilityState === 'visible';
    const schedule = () => {
      clearInterval(interval);
      interval = visible() ? setInterval(run, 60_000) : undefined;
    };
    const onFocus = () => { if (visible()) run(); };
    const onVisibility = () => {
      schedule();
      if (visible()) run();
    };
    const binding = { owner, run };
    trigger.current = binding;
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    run();
    schedule();
    return () => {
      active = false;
      if (trigger.current === binding) trigger.current = null;
      if (flight !== null) clearTimeout(flight.deadline);
      flight = null;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, owner]);

  // Passive cleanup alone would admit the prior API's health for one render.
  if (state.owner !== owner) return { status: 'loading', observation: emptyObservation(), retry };
  if (state.status === 'ready') return { status: 'ready', health: state.health, observation: state.observation, retry };
  return { status: state.status, observation: state.observation, retry };
}
