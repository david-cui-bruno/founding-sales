import { useEffect, useRef, useState } from 'react';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
import type { LeadFieldUpdateRequest } from '../../../shared/contracts/leadsContract';
import { mutationReceiptSchema, type MutationReceipt } from '../../../shared/contracts/commonContract';

export type LeadSaveResult = { status: 'saved' } | { status: 'failed'; message: string };
export type EditStatus = 'editing' | 'pending' | 'failed';
export type InlineEdit = {
  personId: string;
  field: LeadFieldUpdateRequest['field'];
  personLabel: string;
  draft: string;
  status: EditStatus;
  error: string | null;
};
export type BulkEdit = { draft: string; status: EditStatus; error: string | null };
export type InlineEditor = {
  session: InlineEdit | null;
  pending: boolean;
  start(input: Omit<InlineEdit, 'status' | 'error'>): void;
  change(value: string): void;
  cancel(): void;
  bindInput(node: HTMLInputElement | null, allowInitialFocus: boolean): void;
  focusInput(): void;
};
const UNKNOWN = 'The change could not be confirmed. Your input is kept. Review the records before retrying.';

/** Route-owned drafts and a synchronous single-write fence, independent of list rendering. */
export function useLeadMutations(
  api: LeadsApi,
  checked: ReadonlySet<string>,
  removeChecked: (ids: readonly string[]) => void,
  refresh: () => Promise<boolean | null>,
) {
  const apiRef = useRef(api);
  apiRef.current = api;
  const mounted = useRef(true);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const noticeOwner = useRef<object | null>(null);
  const lock = useRef<object | null>(null);
  const [inline, setInline] = useState<InlineEdit | null>(null);
  const inputFocus = useRef<{ owner: object; node: HTMLInputElement | null; initial: boolean } | null>(null);
  const [bulk, setBulk] = useState<BulkEdit | null>(null);
  const inlineRef = useRef(inline); inlineRef.current = inline;
  const bulkRef = useRef(bulk); bulkRef.current = bulk;
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    lock.current = null; inputFocus.current = null;
    setInline(null); setBulk(null); setNotice(null);
    return () => { mounted.current = false; lock.current = null; inputFocus.current = null; };
  }, [api]);

  const run = async (
    kind: 'inline' | 'bulk', ids: string[], invoke: () => Promise<MutationReceipt>,
  ): Promise<LeadSaveResult> => {
    if (lock.current !== null) return { status: 'failed', message: 'A change is already pending.' };
    const session = kind === 'inline' ? inlineRef.current : bulkRef.current;
    if (session === null) return { status: 'failed', message: 'Open an editor first.' };
    const fail = (message: string): LeadSaveResult => {
      if (kind === 'inline') setInline(current => current && { ...current, status: 'failed', error: message });
      else setBulk(current => current && { ...current, status: 'failed', error: message });
      return { status: 'failed', message };
    };
    if (ids.length === 0) return fail('Select at least one person. No records submitted.');
    if (ids.length > 200) return fail('Select 200 or fewer people for one update. No records submitted.');
    const token = {}; lock.current = token; noticeOwner.current = token;
    setNotice(null);
    if (kind === 'inline') setInline(current => current && { ...current, status: 'pending', error: null });
    else setBulk(current => current && { ...current, status: 'pending', error: null });
    const owns = () => mounted.current && apiRef.current === api && lock.current === token;
    try {
      const receipt = mutationReceiptSchema.parse(await invoke());
      if (!owns()) return { status: 'failed', message: UNKNOWN };
      const affected = new Set(receipt.affectedPersonIds);
      if (affected.size !== ids.length || ids.some(id => !affected.has(id))) throw new Error('Receipt scope mismatch');
      if (kind === 'inline') { inlineRef.current = null; inputFocus.current = null; setInline(null); }
      else { bulkRef.current = null; setBulk(null); removeChecked(ids); }
      lock.current = null;
      setNotice('Saved');
      // A read failure after an acknowledged write must never invite a duplicate write.
      const readSucceeded = await refreshRef.current();
      if (readSucceeded !== null && mounted.current && apiRef.current === api && noticeOwner.current === token) setNotice(readSucceeded ? 'Saved' : 'Saved; list refresh failed');
      return { status: 'saved' };
    } catch {
      if (!owns()) return { status: 'failed', message: UNKNOWN };
      lock.current = null;
      return fail(UNKNOWN);
    }
  };
  const updateField = (input: LeadFieldUpdateRequest): Promise<LeadSaveResult> => {
    const session = inlineRef.current;
    if (!session || session.personId !== input.personId || session.field !== input.field) return Promise.resolve({ status: 'failed', message: UNKNOWN });
    if (input.field === 'person_name' && !input.value.trim()) return Promise.resolve({ status: 'failed', message: 'Enter a name.' });
    const captured = { ...input };
    return run('inline', [input.personId], () => api.updateField(captured));
  };
  const bulkSetOrganization = (value: string | null): Promise<LeadSaveResult> => {
    const ids = [...checked].sort();
    return run('bulk', ids, () => api.bulkUpdate({ personIds: ids, field: 'organization_label', value }));
  };
  const pending = inline?.status === 'pending' || bulk?.status === 'pending';
  const focusOwner = inputFocus.current?.owner;
  const editor: InlineEditor = {
    session: inline, pending,
    bindInput: (node, allowInitialFocus) => {
      const focus = inputFocus.current;
      if (!mounted.current || apiRef.current !== api || !focus || focus.owner !== focusOwner) return;
      focus.node = node;
      if (node && focus.initial) {
        focus.initial = false; // A newer overlay consumes, rather than defers, this intent.
        if (allowInitialFocus) node.focus();
      }
    },
    focusInput: () => {
      const focus = inputFocus.current;
      if (mounted.current && apiRef.current === api && !lock.current && focus?.owner === focusOwner && focus.node?.isConnected) focus.node.focus();
    },
    start: input => {
      if (lock.current || inlineRef.current || bulkRef.current) return;
      const next: InlineEdit = { ...input, status: 'editing', error: null };
      inputFocus.current = { owner: {}, node: null, initial: true };
      inlineRef.current = next; setInline(next); noticeOwner.current = null; setNotice(null);
    },
    change: draft => {
      if (lock.current) return;
      setInline(current => { const next = current && { ...current, draft }; inlineRef.current = next; return next; });
    },
    cancel: () => { if (!lock.current) { inlineRef.current = null; inputFocus.current = null; setInline(null); } },
  };
  return {
    editor, bulk, pending, notice, updateField, bulkSetOrganization,
    canChangeSelection: () => lock.current === null,
    startBulk: () => {
      if (lock.current || inlineRef.current || bulkRef.current) return;
      const next: BulkEdit = { draft: '', status: 'editing', error: null };
      bulkRef.current = next; setBulk(next); noticeOwner.current = null; setNotice(null);
    },
    changeBulk: (draft: string) => {
      if (lock.current) return;
      setBulk(current => { const next = current && { ...current, draft }; bulkRef.current = next; return next; });
    },
    cancelBulk: () => { if (!lock.current) { bulkRef.current = null; setBulk(null); } },
  };
}
