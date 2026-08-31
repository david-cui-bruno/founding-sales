import { BUILTIN_CADENCES } from '../cadence/builtinCadences';
import type { CadenceAggregate } from '../cadence/cadenceTypes';
import { LifecycleEvidenceError } from '../support/domainErrors';

const WARM_C_V1 = BUILTIN_CADENCES.find(({ id }) => id === 'cadence-c-v1')!;

export type CadenceEnrollmentMode = 'standard' | 'inbound_over_cap_response';

export function validateEffectiveCadencePlan(input: {
  definition: CadenceAggregate;
  mode: CadenceEnrollmentMode;
  allowedStepIds: readonly string[] | null;
  currentStepId: string;
  scheduledStepCount: number;
}): readonly string[] {
  const definitionStepIds = input.definition.steps.map(({ id }) => id);
  let effective = definitionStepIds;
  if (input.allowedStepIds !== null) {
    if (input.allowedStepIds.length === 0
      || new Set(input.allowedStepIds).size !== input.allowedStepIds.length) {
      throw new LifecycleEvidenceError('Allowed cadence steps must be nonempty and unique.');
    }
    const positions = input.allowedStepIds.map((id) => definitionStepIds.indexOf(id));
    if (positions.some((position) => position < 0)
      || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
      throw new LifecycleEvidenceError('Allowed cadence steps must be an ordered definition subsequence.');
    }
    effective = [...input.allowedStepIds];
  }

  if (input.mode === 'inbound_over_cap_response') {
    const expectedFirstStepId = WARM_C_V1.steps[0]?.id;
    if (input.definition.id !== WARM_C_V1.id
      || input.definition.family !== WARM_C_V1.family
      || input.definition.version !== WARM_C_V1.version
      || input.definition.category !== WARM_C_V1.category
      || input.definition.contentHash !== WARM_C_V1.contentHash
      || input.allowedStepIds === null
      || effective.length !== 1
      || effective[0] !== expectedFirstStepId
      || input.currentStepId !== expectedFirstStepId
      || input.scheduledStepCount !== 1) {
      throw new LifecycleEvidenceError('Over-cap response mode is restricted to Warm C v1 first step.');
    }
    return Object.freeze([...effective]);
  }

  if (input.definition.category === 'prospecting') {
    if (input.allowedStepIds !== null
      && input.definition.steps.find(({ id }) => id === effective.at(-1))?.breakup !== true) {
      throw new LifecycleEvidenceError('A standard prospecting plan must end with breakup.');
    }
  } else if (input.allowedStepIds !== null
    && (effective.length !== definitionStepIds.length
      || effective.some((id, index) => id !== definitionStepIds[index]))) {
    throw new LifecycleEvidenceError('A fixed non-prospecting cadence requires its full definition plan.');
  }

  const position = effective.indexOf(input.currentStepId);
  if (position < 0 || input.scheduledStepCount !== position + 1) {
    throw new LifecycleEvidenceError('Cadence step count must equal the effective-plan position plus one.');
  }
  return Object.freeze([...effective]);
}
