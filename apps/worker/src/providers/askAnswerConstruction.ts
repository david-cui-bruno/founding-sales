import { z } from 'zod';
import type { AskInputWindow } from '@fss/domain/crm/askAnswerPorts.ts';

// Provider grammar stays free of Bedrock-unsupported length keywords. The host
// validates bounds and evidence against its current authorized snapshot below.
// Ordinary union emits supported anyOf; discriminatedUnion emits oneOf.
// Literal mode values keep the branches disjoint without weakening validation.
export const askClaimConstructionSchema = z.union([
  z.strictObject({ mode: z.literal('source_quote'), windowId: z.string(), quote: z.string() }),
  z.strictObject({ mode: z.literal('exact_count'), toolCallId: z.string() }),
  z.strictObject({ mode: z.literal('opportunity_record'), toolCallId: z.string(), opportunityId: z.string() }),
  z.strictObject({ mode: z.literal('interpretation'), premises: z.enum(['source', 'exact', 'mixed']) }),
]);

export function constructAskClaim(input: {
  construction: z.infer<typeof askClaimConstructionSchema>;
  windows: readonly AskInputWindow[];
  exactResults: readonly { toolCallId: string; operation: string; value: unknown }[];
  claim: { text: string; citationWindowIds: readonly string[]; exactResultToolCallIds?: readonly string[] | undefined };
}) {
  const selection = input.construction;
  if (selection.mode === 'interpretation') {
    const originals = input.claim.citationWindowIds;
    const exacts = input.claim.exactResultToolCallIds ?? [];
    if (selection.premises === 'source' && (originals.length === 0 || exacts.length !== 0)
      || selection.premises === 'exact' && (exacts.length === 0 || originals.length !== 0)
      || selection.premises === 'mixed' && (originals.length === 0 || exacts.length === 0)) return null;
    // This validates declared dependencies, never relevance or entailment.
    return { text: input.claim.text, kind: 'inference' as const, citationWindowIds: [...originals], exactResultToolCallIds: [...exacts] };
  }
  if (selection.mode === 'opportunity_record') {
    const exact = input.exactResults.find(item => item.toolCallId === selection.toolCallId);
    if (!exact || exact.operation !== 'opportunities') return null;
    const value = z.object({ records: z.array(z.object({ opportunityId: z.uuid(), name: z.string().nullable(), stageKey: z.string(), status: z.enum(['open', 'won', 'lost']) })) }).safeParse(exact.value);
    const record = value.success ? value.data.records.find(item => item.opportunityId === selection.opportunityId) : undefined;
    if (!record) return null;
    const text = `CRM currently records opportunity ${JSON.stringify(record.name ?? record.opportunityId)} with stage ${JSON.stringify(record.stageKey)} and status ${JSON.stringify(record.status)}.`;
    if (text.length > 1000) return null;
    return { text, kind: 'fact' as const, citationWindowIds: [], exactResultToolCallIds: [exact.toolCallId] };
  }
  if (selection.mode === 'exact_count') {
    const exact = input.exactResults.find(item => item.toolCallId === selection.toolCallId);
    if (!exact || !['opportunities', 'tasks'].includes(exact.operation)) return null;
    const value = z.object({ operation: z.enum(['opportunities', 'tasks']), count: z.string().regex(/^(0|[1-9]\d*)$/u) }).safeParse(exact.value);
    if (!value.success || value.data.operation !== exact.operation) return null;
    return { text: `CRM records ${value.data.count} ${exact.operation} in this query scope.`, kind: 'fact' as const, citationWindowIds: [], exactResultToolCallIds: [exact.toolCallId] };
  }
  const window = input.windows.find(item => item.id === selection.windowId);
  if (!window || selection.quote.length === 0 || selection.quote.length > 700 || !window.text.includes(selection.quote)) return null;
  const sourceLabel = window.source.kind === 'selected_note' ? 'The note' : window.source.kind === 'mail' ? 'The retained message' : 'The transcript';
  const speaker = window.source.speaker;
  const text = speaker === null
    ? `${sourceLabel} records an unidentified speaker: ${JSON.stringify(selection.quote)}`
    : `${sourceLabel} records speaker label ${JSON.stringify(speaker)}: ${JSON.stringify(selection.quote)}`;
  if (text.length > 1000) return null;
  return { text, kind: 'fact' as const, citationWindowIds: [window.id], exactResultToolCallIds: [] };
}
