import { useCallback, useEffect, useRef, useState } from 'react';
import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, type LocalWorkspaceApi, type LocalWorkspaceSnapshot, type LocalCommitmentsSnapshot } from '../../../shared/contracts/localWorkspaceContract';
export type LocalRead<T> = { value: T | null; pending: boolean; error: boolean };
export type LocalDeskRead = { overview: LocalRead<LocalWorkspaceSnapshot>; retained: LocalRead<LocalCommitmentsSnapshot> };
const empty = (pending: boolean): LocalDeskRead => ({ overview: { value: null, pending, error: !pending }, retained: { value: null, pending, error: !pending } });
/** Independent local evidence reads. API replacement invalidates all cached evidence. */
export function useLocalWorkspaceRead(api?: LocalWorkspaceApi) {
  const [state, setState] = useState<{ api?: LocalWorkspaceApi; read: LocalDeskRead }>(() => ({ api, read: empty(!!api) }));
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const request = ++sequence.current;
    if (!api) { setState({ api, read: empty(false) }); return; }
    setState(previous => ({ api, read: previous.api === api ? { overview: { ...previous.read.overview, pending: true }, retained: { ...previous.read.retained, pending: true } } : empty(true) }));
    void Promise.resolve().then(() => api.get()).then(raw => {
      const value = localWorkspaceSnapshotSchema.parse(raw);
      if (request === sequence.current) setState(previous => ({ api, read: { ...previous.read, overview: { value, pending: false, error: false } } }));
    }).catch(() => {
      if (request === sequence.current) setState(previous => ({ api, read: { ...previous.read, overview: { ...previous.read.overview, pending: false, error: true } } }));
    });
    void Promise.resolve().then(() => api.getCommitments()).then(raw => {
      const value = localCommitmentsSnapshotSchema.parse(raw);
      if (request === sequence.current) setState(previous => ({ api, read: { ...previous.read, retained: { value, pending: false, error: false } } }));
    }).catch(() => {
      if (request === sequence.current) setState(previous => ({ api, read: { ...previous.read, retained: { ...previous.read.retained, pending: false, error: true } } }));
    });
  }, [api]);
  useEffect(() => {
    refresh();
    const events = ['focus', 'callie:outcome-logged', 'callie:email-sent', 'callie:workflow-changed'];
    for (const event of events) window.addEventListener(event, refresh);
    return () => { sequence.current++; for (const event of events) window.removeEventListener(event, refresh); };
  }, [refresh]);
  return { read: state.api === api ? state.read : empty(!!api), refresh };
}
