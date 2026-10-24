import { z } from 'zod';
import { instant, qualificationRequestCommandSchema, qualificationAdmissionCommandSchema,
  qualificationQueuedSchema, qualificationAdmittedSchema, type QualificationView } from '@fss/contracts';
import {commandIdSchema,retainedIdentityDecisionInputSchema,retainedInterpretationInputSchema,retainedIdentityDecisionResultSchema,retainedInterpretationResultSchema,type RetainedIdentityDecisionInput,type RetainedInterpretationInput} from '@fss/contracts';

export const QUALIFICATION_PENDING_KEY = 'callie.browser.pending-qualification.v1';
export const qualificationCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), payload: qualificationRequestCommandSchema.omit({ clientVersion: true }) }),
  z.strictObject({ kind: z.literal('admit'), payload: qualificationAdmissionCommandSchema.omit({ clientVersion: true }) }),
  z.strictObject({kind:z.literal('identity'),payload:retainedIdentityDecisionInputSchema.safeExtend({commandId:commandIdSchema})}),
  z.strictObject({kind:z.literal('interpret'),payload:retainedInterpretationInputSchema.safeExtend({commandId:commandIdSchema})}),
]);
export const qualificationPendingSchema = z.strictObject({
  identity: z.string(), expiresAt: instant, command: qualificationCommandSchema,
  receipt: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('refused') }),
    z.strictObject({ kind: z.literal('request'), result: qualificationQueuedSchema }),
    z.strictObject({ kind: z.literal('admit'), result: qualificationAdmittedSchema }),
    z.strictObject({kind:z.literal('identity'),result:retainedIdentityDecisionResultSchema}),
    z.strictObject({kind:z.literal('interpret'),result:retainedInterpretationResultSchema}),
  ]).optional(),
});
export type PendingQualification = z.infer<typeof qualificationPendingSchema>;
export type QualificationCommand = z.infer<typeof qualificationCommandSchema>;
const reviewable = new Set(['maintenance_need_unconfirmed', 'help_date_unknown', 'help_needs_revalidation',
  'need_evidence_conflicts', 'job_date_unknown', 'growth_date_unknown', 'event_needs_revalidation']);
/** Same reviewed-admission policy as the native panel. Unknown geography/phone never becomes reviewable. */
export function canReviewQualification(view: (Pick<QualificationView, 'candidateId' | 'candidateRevision' | 'status' | 'admission' | 'verdict'> & {recovery?:QualificationView['recovery']|undefined}) | null, candidateId: string, revision: number): boolean {
  return view !== null && view.candidateId === candidateId && view.candidateRevision === revision
    && ['review', 'eligible'].includes(view.status) && view.admission === null && view.verdict !== null
    && (view.recovery===undefined||view.verdict.decision==='eligible')
    && view.verdict.unknowns.every(code => reviewable.has(code));
}

/** IDs-only custody. Storage failure is an error, never permission to mint a replacement UUID. */
export class QualificationCustody {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly binding: () => { identity: string; expiresAt: string } | null,
    private readonly randomUUID: () => string, private readonly changed: () => void = () => {}) {}
  clear(): void { try { this.storage.removeItem(QUALIFICATION_PENDING_KEY); } catch { /* Current authority still fences retained bytes. */ } }
  read(): PendingQualification | null {
    const binding = this.binding();
    if (binding === null) return null;
    const raw = this.storage.getItem(QUALIFICATION_PENDING_KEY);
    if (raw === null) return null;
    const held = qualificationPendingSchema.parse(JSON.parse(raw));
    if (held.identity !== binding.identity || Date.parse(held.expiresAt) <= Date.now()
      || Date.parse(held.expiresAt) > Date.parse(binding.expiresAt)) { this.clear(); return null; }
    return held;
  }
  retain(value: PendingQualification): void {
    const held = qualificationPendingSchema.parse(value), binding = this.binding();
    if (binding === null || held.identity !== binding.identity || Date.parse(held.expiresAt) <= Date.now()
      || Date.parse(held.expiresAt) > Date.parse(binding.expiresAt)) throw new Error('Qualification authority changed');
    const previous = this.read();
    if (previous?.receipt === undefined && previous !== null
      && JSON.stringify(previous.command) !== JSON.stringify(held.command)) throw new Error('Unresolved qualification command');
    this.storage.setItem(QUALIFICATION_PENDING_KEY, JSON.stringify(held));
    if (this.storage.getItem(QUALIFICATION_PENDING_KEY) !== JSON.stringify(held)) throw new Error('Qualification custody unavailable');
    this.changed();
  }
  prepare(input: { kind: 'request'; candidateId: string; expectedRevision: number }
    | { kind: 'admit'; candidateId: string; expectedRevision: number; qualificationRunId: string }
    | ({kind:'identity'}&RetainedIdentityDecisionInput) | ({kind:'interpret'}&RetainedInterpretationInput)): PendingQualification {
    const binding = this.binding();
    if (binding === null) throw new Error('Qualification authority unavailable');
    const previous = this.read();
    if (previous !== null && previous.receipt === undefined) throw new Error('Reconcile the existing command explicitly');
    const { kind, ...payload } = input;
    const command = qualificationCommandSchema.parse({ kind, payload: { ...payload, commandId: this.randomUUID(), ...(kind === 'admit' ? { mode: 'reviewed' } : {}) } });
    const held = qualificationPendingSchema.parse({ ...binding, command });
    this.retain(held);
    return held;
  }
}
