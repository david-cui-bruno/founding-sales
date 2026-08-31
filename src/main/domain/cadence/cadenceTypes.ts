import { createHash } from 'node:crypto';

import { z } from 'zod';

export const cadenceFamilySchema = z.enum([
  'cadence_a', 'cadence_b', 'cadence_c', 'post_interview', 'post_offer', 'onboarding',
]);
export type CadenceFamily = z.infer<typeof cadenceFamilySchema>;

export const cadenceActionTypeSchema = z.enum(['call', 'voicemail', 'text', 'email']);
export type CadenceActionType = z.infer<typeof cadenceActionTypeSchema>;
export type CadenceChannel = 'phone' | 'voicemail' | 'text' | 'email';
export type CallWindow = 'morning' | 'afternoon' | 'evening';

export const cadenceOutcomeSchema = z.enum([
  'answered', 'no_answer', 'voicemail_left', 'accepted', 'failed', 'replied',
  'opted_out', 'channel_unavailable', 'marked_impossible',
]);
export type CadenceOutcome = z.infer<typeof cadenceOutcomeSchema>;
export type ResolverOutcome = 'resolved' | 'marked_impossible';

const idSchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/);
const textSchema = z.string().trim().min(1);
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const transitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('next_component'), componentId: idSchema }).strict(),
  z.object({ kind: z.literal('complete_step') }).strict(),
  z.object({ kind: z.literal('retry_component'), componentId: idSchema }).strict(),
  z.object({ kind: z.literal('resolve_contact_method'), componentId: idSchema }).strict(),
  z.object({ kind: z.literal('stop'), reason: z.enum(['replied', 'opted_out']) }).strict(),
]);
export type CadenceOutcomeTransition = z.infer<typeof transitionSchema>;

const templateSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  body: textSchema,
}).strict();
export type CadenceTemplate = z.infer<typeof templateSchema>;

const timingSchema = z.object({
  kind: z.enum(['immediate', 'policy_window']),
  differentCallWindow: z.boolean(),
  finalSlaDayOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type CadenceTimingRule = z.infer<typeof timingSchema>;

const componentSchema = z.object({
  id: idSchema,
  sequence: z.number().int().nonnegative(),
  actionType: cadenceActionTypeSchema,
  channel: z.enum(['phone', 'voicemail', 'text', 'email']),
  condition: z.string().trim().min(1).nullable(),
  allowedOutcomes: z.array(cadenceOutcomeSchema.exclude(['marked_impossible'])).min(1),
  outcomes: z.partialRecord(cadenceOutcomeSchema, transitionSchema),
  template: templateSchema,
}).strict();
export type CadenceActionComponent = z.infer<typeof componentSchema>;

const stepSchema = z.object({
  id: idSchema,
  sequence: z.number().int().nonnegative(),
  dayOffset: z.number().int().nonnegative(),
  label: textSchema,
  breakup: z.boolean(),
  timing: timingSchema,
  components: z.array(componentSchema).min(1),
}).strict();
export type CadenceStep = z.infer<typeof stepSchema>;

const aggregateSchema = z.object({
  id: idSchema,
  family: cadenceFamilySchema,
  version: z.number().int().positive(),
  name: textSchema,
  category: z.enum(['prospecting', 'post_stage', 'onboarding']),
  attemptCap: z.number().int().positive(),
  policyIds: z.object({
    call: idSchema,
    text: idSchema,
    email: idSchema,
  }).strict(),
  steps: z.array(stepSchema).min(1),
  contentHash: contentHashSchema,
}).strict();
export type CadenceAggregate = z.infer<typeof aggregateSchema>;
export type CadenceAggregateDraft = Omit<CadenceAggregate, 'contentHash'>;

export const ACTION_OUTCOMES = {
  call: ['answered', 'no_answer', 'failed', 'opted_out', 'channel_unavailable'],
  voicemail: ['voicemail_left', 'failed', 'channel_unavailable'],
  text: ['accepted', 'failed', 'replied', 'opted_out', 'channel_unavailable'],
  email: ['accepted', 'failed', 'replied', 'opted_out', 'channel_unavailable'],
} as const satisfies Record<CadenceActionType, readonly CadenceOutcome[]>;

const ACTION_CHANNELS = {
  call: 'phone',
  voicemail: 'voicemail',
  text: 'text',
  email: 'email',
} as const satisfies Record<CadenceActionType, CadenceChannel>;

export function defineCadence(draft: CadenceAggregateDraft): CadenceAggregate {
  const candidate = { ...draft, contentHash: '0'.repeat(64) };
  const parsed = parseCadenceStructure(candidate);
  const aggregate = { ...parsed, contentHash: computeCadenceContentHash(parsed) };
  return parseCadenceAggregate(aggregate);
}

export function parseCadenceAggregate(input: unknown): CadenceAggregate {
  const parsed = parseCadenceStructure(input);
  if (computeCadenceContentHash(parsed) !== parsed.contentHash) {
    throw new Error('Cadence content hash does not match the canonical aggregate.');
  }
  return parsed;
}

export function computeCadenceContentHash(
  input: CadenceAggregate | (CadenceAggregateDraft & { contentHash?: string }),
): string {
  const body: Record<string, unknown> & { contentHash?: string } = { ...input };
  delete body.contentHash;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function canonicalJson(input: unknown): string {
  return JSON.stringify(canonicalize(input));
}

function parseCadenceStructure(input: unknown): CadenceAggregate {
  const parsed = aggregateSchema.parse(input);
  const stepIds = new Set<string>();
  const componentPositions = new Map<string, readonly [number, number]>();
  const templateIds = new Set<string>();
  let previousDayOffset = -1;

  parsed.steps.forEach((step, stepIndex) => {
    if (step.sequence !== stepIndex) throw new Error('Cadence step sequences must be contiguous.');
    if (step.dayOffset < previousDayOffset) throw new Error('Cadence day offsets must be ordered.');
    previousDayOffset = step.dayOffset;
    if (stepIds.has(step.id)) throw new Error('Cadence step IDs must be unique.');
    stepIds.add(step.id);
    step.components.forEach((component, componentIndex) => {
      if (component.sequence !== componentIndex) {
        throw new Error('Cadence component sequences must be contiguous.');
      }
      if (componentPositions.has(component.id)) throw new Error('Cadence component IDs must be unique.');
      componentPositions.set(component.id, [step.sequence, component.sequence]);
      if (templateIds.has(component.template.id)) throw new Error('Cadence template IDs must be unique.');
      templateIds.add(component.template.id);
      if (component.channel !== ACTION_CHANNELS[component.actionType]) {
        throw new Error(`Cadence component ${component.id} has an invalid action channel.`);
      }
    });
  });

  for (const step of parsed.steps) {
    for (const component of step.components) {
      const expected = [...ACTION_OUTCOMES[component.actionType], 'marked_impossible'].sort();
      const actual = Object.keys(component.outcomes).sort();
      if (new Set(component.allowedOutcomes).size !== component.allowedOutcomes.length
        || [...component.allowedOutcomes].sort().join('|')
          !== [...ACTION_OUTCOMES[component.actionType]].sort().join('|')
        || actual.join('|') !== expected.join('|')) {
        throw new Error(`Cadence component ${component.id} has an invalid outcome graph.`);
      }
      const failed = component.outcomes.failed;
      if (failed?.kind !== 'retry_component' || failed.componentId !== component.id) {
        throw new Error(`Cadence component ${component.id} must retry explicitly after failure.`);
      }
      const unavailable = component.outcomes.channel_unavailable;
      if (unavailable?.kind !== 'resolve_contact_method'
        || unavailable.componentId !== component.id) {
        throw new Error(`Cadence component ${component.id} must resolve an unavailable channel.`);
      }
      for (const transition of Object.values(component.outcomes)) {
        if (transition === undefined) continue;
        if (transition.kind === 'retry_component' || transition.kind === 'resolve_contact_method') {
          if (transition.componentId !== component.id) {
            throw new Error('Retry and resolver transitions must target their own component.');
          }
        }
        if (transition.kind === 'next_component') {
          const target = componentPositions.get(transition.componentId);
          if (target === undefined || target[0] !== step.sequence
            || comparePosition(target, [step.sequence, component.sequence]) <= 0) {
            throw new Error('Cadence component transitions must stay in-step and move forward.');
          }
        }
      }
    }
  }

  const breakups = parsed.steps.filter(({ breakup }) => breakup);
  if (parsed.family === 'cadence_a' || parsed.family === 'cadence_b'
    || parsed.family === 'cadence_c' || parsed.family === 'post_offer') {
    if (breakups.length !== 1 || breakups[0]?.id !== parsed.steps.at(-1)?.id) {
      throw new Error('This cadence requires one final breakup step.');
    }
  } else if (breakups.length !== 0) {
    throw new Error('This cadence does not permit a breakup step.');
  }
  return parsed;
}

function comparePosition(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function canonicalize(input: unknown): unknown {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
    return input;
  }
  if (Array.isArray(input)) return input.map(canonicalize);
  if (typeof input !== 'object') throw new TypeError('Canonical JSON rejects unsupported values.');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON accepts only plain objects.');
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input as Record<string, unknown>).sort()) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) throw new TypeError('Canonical JSON rejects undefined.');
    output[key] = canonicalize(value);
  }
  return output;
}
