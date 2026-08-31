import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  ImportCommitReceipt,
  ImportCommitRequest,
  ImportMapping,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import type { ImportApi } from './importApi';

export type ImportSourceChannel = ImportCommitRequest['source']['channel'];

export type ImportSourceDraft = {
  sourceKind: 'csv' | 'spreadsheet_paste';
  sourceName: string;
  content: string;
};

export type ImportWorkflowState =
  | { step: 'source'; sourceKind: 'csv' | 'spreadsheet_paste'; content: string; sourceName: string }
  | { step: 'previewing'; requestId: number }
  | { step: 'mapping'; preview: ImportPreview; mapping: ImportMapping }
  | { step: 'validating'; requestId: number; preview: ImportPreview }
  | { step: 'ready'; preview: ImportPreview; mapping: ImportMapping }
  | { step: 'committing'; preview: ImportPreview }
  | { step: 'complete'; receipt: ImportCommitReceipt }
  | { step: 'failed'; safeCode: string; message: string };

export type DuplicateDecisionDraft = {
  decision: 'merge' | 'create' | 'skip';
  personId: string | null;
};

export type ImportCommitBlocker =
  | 'mapping_invalid'
  | 'blocking_errors'
  | 'no_valid_rows'
  | 'duplicates_unresolved'
  | 'referrer_required';

export const MAPPING_ERROR_MESSAGE =
  'Exactly one column must be mapped to Person name.';

/** Maps an unknown failure to a safe code and human message, never a stack. */
export const toSafeImportError = (
  error: unknown,
): { safeCode: string; message: string } => {
  const candidate = (error as { code?: unknown } | null | undefined)?.code;
  const safeCode = typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : 'IMPORT_FAILED';
  const message = error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'The import failed. Start over and try again.';
  return { safeCode, message };
};

/**
 * Sole call site of `api.commit` in this feature. Both the dialog's final
 * commit handler and ManualQuickAdd's explicit submit handler go through
 * this function; nothing commits during preview, remap, or from effects.
 */
export const commitPreparedImport = (
  api: ImportApi,
  request: ImportCommitRequest,
): Promise<ImportCommitReceipt> => api.commit(request);

const hasExactlyOnePersonName = (mapping: ImportMapping): boolean =>
  Object.values(mapping).filter((field) => field === 'person_name').length === 1;

const previewOf = (state: ImportWorkflowState): ImportPreview | null =>
  state.step === 'mapping'
    || state.step === 'validating'
    || state.step === 'ready'
    || state.step === 'committing'
    ? state.preview
    : null;

const INITIAL_SOURCE: ImportSourceDraft = {
  sourceKind: 'spreadsheet_paste',
  sourceName: '',
  content: '',
};

/**
 * Explicit import workflow state machine. Request IDs make every preview and
 * remap response verifiable: responses that arrive after a restart or after a
 * newer request are dropped instead of resurrecting stale state.
 */
export function useImportWorkflow(api: ImportApi) {
  const [state, setState] = useState<ImportWorkflowState>({
    step: 'source',
    ...INITIAL_SOURCE,
  });
  const [draftMapping, setDraftMapping] = useState<ImportMapping | null>(null);
  const [duplicateDecisions, setDuplicateDecisions] = useState<
    Record<number, DuplicateDecisionDraft>
  >({});
  const [sourceChannel, setSourceChannel] = useState<ImportSourceChannel>('custom');
  const [referredByPersonId, setReferredByPersonId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const sourceRef = useRef<ImportSourceDraft>(INITIAL_SOURCE);

  const setSource = useCallback((draft: ImportSourceDraft) => {
    sourceRef.current = draft;
    setState({ step: 'source', ...draft });
  }, []);

  const requestPreview = useCallback(() => {
    const source = sourceRef.current;
    if (source.content.trim() === '') return;
    requestSeq.current += 1;
    const requestId = requestSeq.current;
    setDraftMapping(null);
    setDuplicateDecisions({});
    setState({ step: 'previewing', requestId });
    api
      .preview({
        kind: source.sourceKind,
        sourceName: source.sourceName,
        content: source.content,
      })
      .then(
        (preview) => {
          if (requestSeq.current !== requestId) return;
          setDraftMapping(preview.suggestedMapping);
          setState({ step: 'ready', preview, mapping: preview.suggestedMapping });
        },
        (error: unknown) => {
          if (requestSeq.current !== requestId) return;
          setState({ step: 'failed', ...toSafeImportError(error) });
        },
      );
  }, [api]);

  const setMapping = useCallback(
    (mapping: ImportMapping) => {
      const preview = previewOf(state);
      if (preview === null || state.step === 'committing') return;
      setDraftMapping(mapping);
      if (!hasExactlyOnePersonName(mapping)) {
        setState({ step: 'mapping', preview, mapping });
        return;
      }
      requestSeq.current += 1;
      const requestId = requestSeq.current;
      setState({ step: 'validating', requestId, preview });
      api
        .remap({
          previewId: preview.previewId,
          contentHash: preview.contentHash,
          mapping,
        })
        .then(
          (next) => {
            if (requestSeq.current !== requestId) return;
            setState({ step: 'ready', preview: next, mapping });
          },
          (error: unknown) => {
            if (requestSeq.current !== requestId) return;
            setState({ step: 'failed', ...toSafeImportError(error) });
          },
        );
    },
    [api, state],
  );

  const setDuplicateDecision = useCallback(
    (rowNumber: number, decision: DuplicateDecisionDraft | null) => {
      setDuplicateDecisions((current) => {
        const next = { ...current };
        if (decision === null) {
          delete next[rowNumber];
        } else {
          next[rowNumber] = decision;
        }
        return next;
      });
    },
    [],
  );

  const preview = previewOf(state);
  const mappingValid = draftMapping === null || hasExactlyOnePersonName(draftMapping);
  const mappingError = mappingValid ? null : MAPPING_ERROR_MESSAGE;

  const commitBlockers = useMemo<ImportCommitBlocker[]>(() => {
    if (preview === null) return [];
    const blockers: ImportCommitBlocker[] = [];
    if (!mappingValid) blockers.push('mapping_invalid');
    if (preview.errors.length > 0) blockers.push('blocking_errors');
    if (preview.validCount === 0) blockers.push('no_valid_rows');
    const unresolved = preview.duplicateCandidates.some((candidate) => {
      const decision = duplicateDecisions[candidate.rowNumber];
      if (decision === undefined) return true;
      return decision.decision === 'merge' && decision.personId === null;
    });
    if (unresolved) blockers.push('duplicates_unresolved');
    if (
      sourceChannel === 'referral'
      && (referredByPersonId === null || referredByPersonId.trim() === '')
    ) {
      blockers.push('referrer_required');
    }
    return blockers;
  }, [preview, mappingValid, duplicateDecisions, sourceChannel, referredByPersonId]);

  /**
   * Final explicit commit handler: the only path in the workflow that writes.
   * Returns the receipt on success and null when blocked or failed.
   */
  const commit = useCallback(async (): Promise<ImportCommitReceipt | null> => {
    if (state.step !== 'ready' || commitBlockers.length > 0) return null;
    const request: ImportCommitRequest = {
      previewId: state.preview.previewId,
      contentHash: state.preview.contentHash,
      mapping: state.mapping,
      source: {
        channel: sourceChannel,
        referredByPersonId: sourceChannel === 'referral' ? referredByPersonId : null,
      },
      duplicateDecisions: state.preview.duplicateCandidates.map((candidate) => {
        const decision = duplicateDecisions[candidate.rowNumber];
        return {
          rowNumber: candidate.rowNumber,
          decision: decision.decision,
          personId: decision.decision === 'merge' ? decision.personId : null,
        };
      }),
    };
    setState({ step: 'committing', preview: state.preview });
    try {
      const receipt = await commitPreparedImport(api, request);
      setState({ step: 'complete', receipt });
      return receipt;
    } catch (error) {
      setState({ step: 'failed', ...toSafeImportError(error) });
      return null;
    }
  }, [api, state, commitBlockers, sourceChannel, referredByPersonId, duplicateDecisions]);

  const restart = useCallback(() => {
    requestSeq.current += 1;
    setDraftMapping(null);
    setDuplicateDecisions({});
    setState({ step: 'source', ...sourceRef.current });
  }, []);

  return {
    state,
    preview,
    draftMapping,
    mappingError,
    duplicateDecisions,
    sourceChannel,
    referredByPersonId,
    commitBlockers,
    setSource,
    requestPreview,
    setMapping,
    setDuplicateDecision,
    setSourceChannel,
    setReferredByPersonId,
    commit,
    restart,
  };
}
