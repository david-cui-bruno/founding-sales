import { useCallback, useEffect, useReducer, useRef } from 'react';
import { reasonSentence } from '@fss/contracts';
import type { RecordingItem, RecordingsView } from '../../shared/recordings.ts';
import { useSessionEpoch } from '../app/drafts.tsx';

/**
 * What the recording controls keep beyond the view that drew them (lane M4; kept-state rules
 * K1–K7), on the pattern of `meetings/attendanceMemory.ts`: a module-level store keyed by the
 * drafts provider's epoch, which `App` replaces on every sign-out, workspace change and new
 * session, so the next person inherits no picker, no command and no note (K1).
 *
 *   * `view` — the last answer about the import, from a read or a command, whichever is newer.
 *   * `answers` — bumped by every command answer. A read that began under an older count is
 *     stale and dropped (K7); `reads` keeps only the latest read.
 *   * By item id (an opaque id, never a path): `picking` — the "Choose meeting" picker open on
 *     that item and the meeting picked so far; `pending` — the command on the wire for that
 *     item (K3: one per item, kept across a remount); `notes` — the sentence its last answer
 *     earned, shown beside that item and no other.
 *
 * A picker closes only on a success answer (K5, K6); a refusal keeps it open with its reason.
 * A late answer updates the view and its own item's note, and never reopens a picker David
 * closed (K3).
 */

export type RecordingCommand = 'choose' | 'ignore' | 'retry';

export interface PendingRecordingCommand {
  readonly kind: RecordingCommand;
  readonly meetingId: string | null;
}

export interface RecordingsMemory {
  view: RecordingsView | null;
  answers: number;
  reads: number;
  readonly picking: Map<string, { readonly meetingId: string | null }>;
  readonly pending: Map<string, PendingRecordingCommand>;
  readonly notes: Map<string, string>;
}

const fresh = (): RecordingsMemory => ({ view: null, answers: 0, reads: 0, picking: new Map(), pending: new Map(), notes: new Map() });

let current: { epoch: object | null; memory: RecordingsMemory } = { epoch: null, memory: fresh() };
const listeners = new Set<() => void>();

export function recordingsMemoryFor(epoch: object | null): RecordingsMemory {
  if (current.epoch !== epoch) current = { epoch, memory: fresh() };
  return current.memory;
}

export function announceRecordings(): void {
  for (const listener of [...listeners]) listener();
}

/** Tests: forget everything, as a sign-out does. */
export function resetRecordingsMemory(): void {
  current = { epoch: null, memory: fresh() };
}

export interface RecordingsPorts {
  state(): Promise<RecordingsView>;
  chooseMeeting(input: { readonly itemId: string; readonly meetingId: string }): Promise<RecordingsView>;
  ignore(input: { readonly itemId: string }): Promise<RecordingsView>;
  retry(input: { readonly itemId: string }): Promise<RecordingsView>;
  chooseFolder?(): Promise<RecordingsView>;
  importFolder?(): Promise<RecordingsView>;
}

export function registryRecordingPorts(): RecordingsPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  const importer = globalThis.callieImport;
  return {
    state: async () => await api.read('recordings.state', {}),
    chooseMeeting: async input => await api.command('recordings.chooseMeeting', input),
    ignore: async input => await api.command('recordings.ignore', input),
    retry: async input => await api.command('recordings.retry', input),
    ...(importer === undefined
      ? {}
      : { chooseFolder: async () => await importer.chooseRecordingsFolder(), importFolder: async () => await importer.importRecordingFolder() }),
  };
}

const UNREACHABLE = 'Callie could not reach this Mac’s import just now. Try again.';

/** How often an open view reads the import: often while something is moving, rarely otherwise. */
export const BUSY_POLL_MS = 4_000;
export const QUIET_POLL_MS = 30_000;

export interface Recordings {
  readonly memory: RecordingsMemory;
  readonly view: RecordingsView | null;
  /** Read the import now (a read that is overtaken by an answer is dropped). */
  read(): void;
  send(itemId: string, kind: RecordingCommand, meetingId?: string): void;
  openPicker(itemId: string): void;
  closePicker(itemId: string): void;
  pick(itemId: string, meetingId: string): void;
  setView(view: RecordingsView): void;
}

const moving = (items: readonly RecordingItem[]): boolean => items.some(item => item.state === 'waiting' || item.state === 'uploading');

/**
 * The import as a view reads it: the session's memory, a read on mount and then on a timer,
 * and the three commands. `ports` null is a page without the preload: nothing is read.
 */
export function useRecordings(ports: RecordingsPorts | null): Recordings {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = (): void => {
      bump();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const memory = recordingsMemoryFor(useSessionEpoch());
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const memoryRef = useRef(memory);
  memoryRef.current = memory;

  const touch = useCallback((): void => {
    announceRecordings();
  }, []);

  const read = useCallback((): void => {
    const target = portsRef.current;
    if (target === null) return;
    const kept = memoryRef.current;
    kept.reads += 1;
    const mine = kept.reads;
    const answersAtStart = kept.answers;
    void target.state().then(
      answer => {
        // K7: only the latest read, and never one an answer has overtaken.
        if (mine !== kept.reads || answersAtStart !== kept.answers) return;
        kept.view = answer;
        touch();
      },
      () => undefined,
    );
  }, [touch]);

  useEffect(() => {
    read();
  }, [read, memory]);

  const busy = moving(memory.view?.items ?? []);
  useEffect(() => {
    const handle = setInterval(read, busy ? BUSY_POLL_MS : QUIET_POLL_MS);
    return () => {
      clearInterval(handle);
    };
  }, [read, busy]);

  const send = useCallback(
    (itemId: string, kind: RecordingCommand, meetingId?: string): void => {
      const target = portsRef.current;
      const kept = memoryRef.current;
      if (target === null || kept.pending.has(itemId)) return;
      if (kind === 'choose' && meetingId === undefined) return;
      const command: PendingRecordingCommand = { kind, meetingId: meetingId ?? null };
      kept.pending.set(itemId, command);
      kept.notes.delete(itemId);
      touch();
      const settle = (answer: RecordingsView | null): void => {
        // A newer command for this item replaced this one: its answer is the one that counts.
        if (kept.pending.get(itemId) !== command) return;
        kept.pending.delete(itemId);
        if (answer === null) {
          kept.notes.set(itemId, UNREACHABLE);
          touch();
          return;
        }
        kept.answers += 1;
        kept.view = answer;
        if (answer.notice !== null) {
          // K5: a refusal keeps the picker open, with its reason, on this item only.
          kept.notes.set(itemId, reasonSentence(answer.notice));
        } else if (kind === 'choose') {
          // K6: the success answer is what consumes the choice.
          kept.picking.delete(itemId);
        }
        touch();
      };
      const sent =
        kind === 'choose'
          ? target.chooseMeeting({ itemId, meetingId: meetingId ?? '' })
          : kind === 'ignore'
            ? target.ignore({ itemId })
            : target.retry({ itemId });
      void sent.then(settle, () => {
        settle(null);
      });
    },
    [touch],
  );

  return {
    memory,
    view: memory.view,
    read,
    send,
    openPicker: itemId => {
      memory.picking.set(itemId, memory.picking.get(itemId) ?? { meetingId: null });
      memory.notes.delete(itemId);
      touch();
    },
    closePicker: itemId => {
      memory.picking.delete(itemId);
      touch();
    },
    pick: (itemId, meetingId) => {
      memory.picking.set(itemId, { meetingId });
      touch();
    },
    setView: next => {
      memory.answers += 1;
      memory.view = next;
      touch();
    },
  };
}

/** The words for an item's state, as the firm page row and the Recordings list say them. */
export function recordingStateWords(item: Pick<RecordingItem, 'state' | 'uploaded' | 'total'>): string {
  switch (item.state) {
    case 'waiting':
      return 'Waiting for conversion';
    case 'uploading':
      return item.total > 0 ? `Uploading ${String(item.uploaded)}/${String(item.total)}` : 'Uploading';
    case 'uploaded':
      return 'Uploaded — waiting for transcription';
    case 'needs_matching':
      return 'Needs matching';
    case 'failed':
      return 'Failed';
  }
}

/** The folder's topic without Zoom's date, time and meeting number, or the whole name. */
export function recordingTitle(folderName: string): string {
  const match = /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} ?(.*?)(?:\s*\d{9,11})?$/u.exec(folderName);
  const topic = (match?.[1] ?? folderName).trim();
  return topic === '' ? 'Zoom recording' : topic;
}
