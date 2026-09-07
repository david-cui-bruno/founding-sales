import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryBriefSchema, discoverySnapshotSchema,
  type BeginDiscoveryReceipt, type BeginDiscoveryRequest, type DiscoveryApi, type DiscoveryBrief, type DiscoverySnapshot,
} from '../../../shared/contracts/discoveryContract';

export const staleDiscoveryError = (error: unknown): boolean => error instanceof Error
  && /\bDISCOVERY_STALE_ASSESSMENT\b/.test(error.message);
const UNCONFIRMED = 'Preparation response unavailable. Your request is retained. Retry contact options explicitly to check the same request.';

/** Only mounted, bounded reads. Commands are never retried by a timer or refresh. */
export function useDiscovery(api: DiscoveryApi) {
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | null>(null);
  const [commandError, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyPersonId, setBusyPersonId] = useState<string | null>(null);
  const epoch = useRef(0);
  const active = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;
  const reads = useRef<{ api: DiscoveryApi; promise: Promise<DiscoverySnapshot> } | null>(null);
  const requests = useRef(new Map<string, BeginDiscoveryRequest>());
  const successes = useRef(new Map<string, BeginDiscoveryReceipt>());
  const inFlight = useRef(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const bounded = useCallback(<T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timers.current.delete(timer); reject(new Error('Discovery timeout')); }, 15000);
    timers.current.add(timer);
    operation.then(resolve, reject).finally(() => { clearTimeout(timer); timers.current.delete(timer); });
  }), []);

  const refresh = useCallback(async (): Promise<void> => {
    const current = epoch.current;
    if (reads.current?.api !== api) {
      // Retain the actual transport promise after a UI timeout. Later reads
      // join it rather than starting overlapping IPC requests.
      const promise = Promise.resolve().then(() => api.get()).then(raw => {
        const value = discoverySnapshotSchema.parse(raw);
        const ids = [...value.prepared, ...value.judgment].map(brief => brief.personId);
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate Person');
        return value;
      });
      reads.current = { api, promise };
      const settled = () => { if (reads.current?.promise === promise) reads.current = null; };
      void promise.then(settled, settled);
    }
    try {
      const value = await bounded(reads.current.promise);
      if (active.current && current === epoch.current && apiRef.current === api) { setSnapshot(value); setReadError(null); }
    } catch {
      if (active.current && current === epoch.current && apiRef.current === api) setReadError('Shortlist could not refresh. Preparation commands are not retried.');
    }
  }, [api, bounded]);

  useEffect(() => {
    const current = ++epoch.current;
    active.current = true;
    setSnapshot(null);
    setError(null);
    let polls = 0;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (epoch.current === current && polls++ < 12) poll = setTimeout(() => { void tick(); }, 5000);
    };
    void tick();
    const ownedTimers = timers.current;
    return () => {
      epoch.current++;
      active.current = false;
      clearTimeout(poll);
      ownedTimers.forEach(clearTimeout);
      ownedTimers.clear();
    };
  }, [refresh]);

  const begin = useCallback(async (brief: DiscoveryBrief): Promise<BeginDiscoveryReceipt> => {
    if (inFlight.current) throw new Error('Preparation already pending');
    const parsed = discoveryBriefSchema.parse(brief);
    const previous = requests.current.get(parsed.personId);
    const assessment = parsed.assessment;
    if (previous === undefined && (assessment === null || parsed.stale || assessment.disposition !== 'candidate')) {
      setError('Evidence changed. Refresh and review the current evidence before choosing contact options.');
      throw new Error('DISCOVERY_STALE_ASSESSMENT');
    }
    // Retain the ENTIRE request, including the old cycle/fingerprint, on uncertainty.
    const request = previous ?? beginDiscoveryRequestSchema.parse({ commandId: crypto.randomUUID(),
      personId: parsed.personId, salesCycleId: parsed.salesCycleId,
      assessmentId: assessment!.id, expectedFingerprint: assessment!.fingerprint });
    const successful = successes.current.get(request.personId);
    if (successful?.assessmentId === request.assessmentId) return successful;
    requests.current.set(request.personId, request);
    inFlight.current = true;
    const current = epoch.current;
    setBusyPersonId(request.personId);
    setError(null);
    try {
      const receipt = beginDiscoveryReceiptSchema.parse(await bounded(api.begin({ ...request })));
      if (receipt.personId !== request.personId || receipt.salesCycleId !== request.salesCycleId
        || receipt.assessmentId !== request.assessmentId) throw new Error('Invalid preparation receipt');
      successes.current.set(request.personId, receipt);
      requests.current.delete(request.personId);
      return receipt;
    } catch (failure) {
      if (current === epoch.current) {
        if (staleDiscoveryError(failure)) {
          requests.current.delete(request.personId);
          setError('Evidence changed. Review the refreshed evidence before choosing contact options again.');
          void refresh();
        } else setError(UNCONFIRMED);
      }
      throw failure;
    } finally {
      inFlight.current = false;
      if (current === epoch.current) setBusyPersonId(null);
    }
  }, [api, bounded, refresh]);

  return { snapshot, error: commandError ?? readError, busyPersonId, refresh, begin };
}
