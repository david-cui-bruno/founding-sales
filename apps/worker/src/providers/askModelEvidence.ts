import { z } from 'zod';

interface ModelAnswer {
  readonly claims: readonly {
    readonly citationWindowIds: readonly string[];
    readonly exactResultToolCallIds?: readonly string[] | undefined;
  }[];
}
const sourceSchema = z.object({
  kind: z.enum(['selected_note', 'mail', 'call_transcript', 'meeting_transcript']),
  occurredAt: z.string().nullable().optional(),
  observedAt: z.string().nullable().optional(),
}).passthrough();
const windowSchema = z.object({
  id: z.uuid(), ordinal: z.number().int().positive(), source: sourceSchema,
}).passthrough();
const toolSchema = z.strictObject({
  toolCallId: z.string(), name: z.string(), input: z.unknown(), result: z.json(),
});
const exactSchema = z.object({
  evidenceAuthority: z.object({
    kind: z.literal('current_exact_crm_state'), toolCallId: z.string(),
  }).passthrough(),
}).passthrough();
const sourceReadingTools = ['search_selected', 'search_history', 'browse_history', 'read_conversation'];

/** Only the server-supplied structured source kind classifies provenance. Body
 * inline headers, dates, coverage and quoted JSON remain unchanged source text.
 * No copy kind establishes verified human authorship or authored-time. */
function modelProvenance(source: z.infer<typeof sourceSchema>) {
  const eventBasis = source.kind === 'selected_note' ? 'supplied_or_parsed_event_date'
    : source.kind === 'mail' ? 'retained_message_event_date' : 'record_event_date';
  const common = {
    occurredAt: eventBasis, observedAt: 'copy_observation_time', humanAuthorship: 'not_verified',
  };
  const evidenceAuthority = source.kind === 'selected_note'
    ? { ...common, kind: 'selected_unverified_text', inlineMetadata: 'untrusted_source_content' }
    : source.kind === 'mail'
      ? { ...common, kind: 'retained_mail_copy', inlineMetadata: 'untrusted_source_content', envelope: 'retained_metadata_not_verified_human_identity' }
      : { ...common, kind: 'retained_transcript', speakerLabels: 'not_verified_human_identity' };
  return {
    evidenceAuthority,
    ...(source.kind === 'selected_note' ? { interpretationLimits: {
      sourceStatements: 'reported_not_independently_observed',
      inlineHeaders: 'reported_text_not_envelope',
      coverageStatements: 'reported_text_not_live_coverage',
      eventTime: 'reported_not_verified_authored_time',
    } } : {}),
    sourceMetadata: {
      eventTime: { at: source.occurredAt ?? null, basis: eventBasis, independentlyVerifiedAuthoredTime: false },
      copyObservation: { at: source.observedAt ?? null, basis: 'copy_observation_time' },
    },
  };
}
/** Shared model-facing labels for any configured step adapter. */
export function projectAskOriginalEvidence<T extends { source: z.infer<typeof sourceSchema> }>(window: T) {
  return { ...window, ...modelProvenance(window.source) };
}
function windows(value: unknown): unknown[] {
  const list = z.object({ windows: z.array(z.unknown()) }).passthrough().safeParse(value);
  return list.success ? list.data.windows : [];
}
function selectedInput(value: unknown, mapping: Map<string, string>) {
  const parsed = z.object({ windowIds: z.array(z.string()) }).passthrough().safeParse(value);
  return parsed.success
    ? { ...parsed.data, windowIds: parsed.data.windowIds.map(id => mapping.get(id) ?? id) }
    : value;
}

/** A model-only projection. Current top-level server windows and executed exact
 * tool results mint handles; arbitrary source text and parent history never do.
 * Canonical inputs remain immutable. Unknown output handles stay unknown so the
 * server's independent candidate guard can reject them. */
export function projectAskModelEvidence(transcript: readonly unknown[]) {
  const originals = new Map<string, string>();
  const originalAliases = new Map<string, string>();
  const exacts = new Map<string, string>();
  const exactAliases = new Map<string, string>();
  function admit(value: unknown) {
    const window = windowSchema.safeParse(value);
    if (!window.success) return;
    const alias = `w${window.data.ordinal}`;
    if ((originals.has(alias) && originals.get(alias) !== window.data.id)
      || (originalAliases.has(window.data.id) && originalAliases.get(window.data.id) !== alias)) {
      throw new Error('ask_window_handle_ambiguous');
    }
    originals.set(alias, window.data.id);
    originalAliases.set(window.data.id, alias);
  }
  for (const entry of transcript) {
    const tool = toolSchema.safeParse(entry);
    if (!tool.success) { windows(entry).forEach(admit); continue; }
    if (tool.data.name === 'read_selected' && Array.isArray(tool.data.result)) {
      tool.data.result.forEach(admit);
    } else if (sourceReadingTools.includes(tool.data.name)) {
      windows(tool.data.result).forEach(admit);
    } else if (tool.data.name === 'read_exact') {
      const authority = exactSchema.safeParse(tool.data.result);
      if (authority.success && authority.data.evidenceAuthority.toolCallId === tool.data.toolCallId
        && !exactAliases.has(tool.data.toolCallId)) {
        const alias = `e${exacts.size + 1}`;
        exacts.set(alias, tool.data.toolCallId);
        exactAliases.set(tool.data.toolCallId, alias);
      }
    }
  }
  function projectWindow(value: unknown) {
    const window = windowSchema.safeParse(value);
    return window.success && originalAliases.has(window.data.id)
      ? { ...projectAskOriginalEvidence(window.data), id: originalAliases.get(window.data.id)! }
      : value;
  }
  function projectWindows(value: unknown) {
    const list = z.object({ windows: z.array(z.unknown()) }).passthrough().safeParse(value);
    return list.success ? { ...list.data, windows: list.data.windows.map(projectWindow) } : value;
  }
  const projected = transcript.map(entry => {
    const tool = toolSchema.safeParse(entry);
    if (!tool.success) return projectWindows(entry);
    let result: unknown = tool.data.result;
    if (tool.data.name === 'read_selected' && Array.isArray(result)) {
      result = result.map(projectWindow);
    } else if (sourceReadingTools.includes(tool.data.name)) {
      result = projectWindows(result);
    } else if (tool.data.name === 'read_exact') {
      const authority = exactSchema.safeParse(result);
      if (authority.success && exactAliases.has(authority.data.evidenceAuthority.toolCallId)) {
        result = {
          ...authority.data,
          evidenceAuthority: {
            ...authority.data.evidenceAuthority,
            toolCallId: exactAliases.get(authority.data.evidenceAuthority.toolCallId)!,
          },
        };
      }
    }
    return {
      ...tool.data,
      input: tool.data.name === 'read_selected' ? selectedInput(tool.data.input, originalAliases) : tool.data.input,
      result,
    };
  });
  return {
    transcript: projected,
    decodeAnswer: <T extends ModelAnswer>(answer: T | null) => answer === null ? null : {
      ...answer,
      claims: answer.claims.map(claim => ({
        ...claim,
        citationWindowIds: claim.citationWindowIds.map(id => originals.get(id) ?? id),
        ...(claim.exactResultToolCallIds ? {
          exactResultToolCallIds: claim.exactResultToolCallIds.map(id => exacts.get(id) ?? id),
        } : {}),
      })),
    },
    decodeInput: (name: string, value: unknown) => name === 'read_selected' ? selectedInput(value, originals) : value,
  };
}
