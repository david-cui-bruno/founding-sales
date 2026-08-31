import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { readInstalledCadenceAggregate } from '../cadence/cadenceRepository';
import type { NextAction } from './lifecycleTypes';
import { validateEffectiveCadencePlan } from './cadenceEffectivePlan';
import { qualifiesFounderInterviewed, qualifiesFounderOffered } from './founderConfirmationEvidence';
import { parseCanonicalJson, serializeCanonical } from './lifecycleValidation';

export type SettlementValidationAction = Pick<NextAction,
  | 'id' | 'salesCycleId' | 'actionType' | 'channel' | 'status'
  | 'workIntent' | 'inboundSla' | 'cadence' | 'completionActivityId' | 'settlement'
>;

const allowedStepIdsSchema = z.array(z.string().trim().min(1)).min(1);
const NULL_EVIDENCE_OUTCOMES = new Set([
  'resolved', 'reviewed_ready', 'lost_nurture', 'upgraded', 'won_confirmed',
  'onboarding_waived', 'phase_completed',
]);
const CADENCE_LIFECYCLE_CONTROL_OUTCOMES = new Set([
  'opted_out', 'lost_nurture', 'upgraded', 'interviewed_confirmed',
  'offered_confirmed', 'won_confirmed', 'onboarding_waived', 'phase_completed',
]);

type ActivityEvidenceRow = {
  person_id: string;
  prospect_id: string | null;
  sales_cycle_id: string | null;
  cadence_enrollment_id: string | null;
  cadence_step_id: string | null;
  cadence_component_id: string | null;
  kind: string;
  channel: string;
  observed_outcome: string | null;
};

export function collectActionSettlementViolations(
  database: AppDatabase,
  action: SettlementValidationAction,
): readonly string[] {
  const violations: string[] = [];
  const settlement = action.settlement;
  if (action.status === 'pending') {
    if (settlement !== null || action.completionActivityId !== null) {
      violations.push('Pending actions cannot carry settlement evidence.');
    }
    return Object.freeze(violations);
  }
  if (settlement === null) {
    return Object.freeze(['Settled actions require a canonical settlement.']);
  }

  const expectedStatus = settlement.outcome === 'marked_impossible' ? 'impossible'
    : settlement.outcome === 'opted_out' || settlement.outcome === 'lost_nurture'
      || settlement.outcome === 'upgraded' ? 'cancelled' : 'completed';
  if (action.status !== expectedStatus) {
    violations.push('Settlement outcome does not match action status.');
  }
  if (settlement.workIntent !== action.workIntent
    || serializeCanonical(settlement.inboundSla) !== serializeCanonical(action.inboundSla)
    || serializeCanonical(settlement.cadence) !== serializeCanonical(action.cadence)) {
    violations.push('Settlement does not preserve the immutable action intent, SLA, and cadence.');
  }
  const planner = settlement.plannerTransition;
  if (planner.definitionId !== action.cadence.cadenceDefinitionId
    || planner.stepId !== action.cadence.cadenceStepId
    || planner.componentId !== action.cadence.cadenceComponentId
    || planner.outcome !== settlement.outcome) {
    violations.push('Planner settlement identity does not match the action.');
  }
  collectCadenceViolations(database, action, violations);
  collectActivityViolations(database, action, violations);
  return Object.freeze(violations);
}

function collectCadenceViolations(
  database: AppDatabase,
  action: SettlementValidationAction,
  violations: string[],
): void {
  const settlement = action.settlement!;
  const cadence = action.cadence;
  if (cadence.cadenceEnrollmentId === null) {
    if (settlement.plannerTransition.attempt !== null) {
      violations.push('Non-cadence settlement cannot carry a scheduled-step attempt.');
    }
    if (action.actionType === 'resolve_contact_method'
      || settlement.outcome === 'resolved' || settlement.outcome === 'marked_impossible') {
      violations.push('Resolver settlements require one installed cadence component branch.');
    }
    return;
  }
  const enrollment = database.raw.prepare<
    [string],
    {
      sales_cycle_id: string;
      cadence_definition_id: string;
      current_step_id: string;
      scheduled_step_count: number;
      mode: 'standard' | 'inbound_over_cap_response';
      allowed_step_ids_json: string | null;
    }
  >(`
    SELECT sales_cycle_id, cadence_definition_id, current_step_id,
      scheduled_step_count, mode, allowed_step_ids_json
    FROM cadence_enrollments WHERE id = ?
  `).get(cadence.cadenceEnrollmentId);
  if (enrollment === undefined
    || enrollment.sales_cycle_id !== action.salesCycleId
    || enrollment.cadence_definition_id !== cadence.cadenceDefinitionId) {
    violations.push('Cadence enrollment is missing or not owned by the action cycle/definition.');
    return;
  }
  let definition;
  let allowedStepIds: readonly string[] | null = null;
  if (enrollment.allowed_step_ids_json !== null) {
    try {
      allowedStepIds = parseCanonicalJson(
        enrollment.allowed_step_ids_json,
        allowedStepIdsSchema,
      );
    } catch {
      violations.push('Cadence enrollment effective plan is not canonical.');
      return;
    }
  }
  let effectiveSteps: readonly string[];
  try {
    definition = readInstalledCadenceAggregate(database.raw, cadence.cadenceDefinitionId);
    if (definition === null) throw new Error('Definition is absent.');
    effectiveSteps = validateEffectiveCadencePlan({
      definition, mode: enrollment.mode, allowedStepIds,
      currentStepId: enrollment.current_step_id,
      scheduledStepCount: enrollment.scheduled_step_count,
    });
  } catch {
    violations.push('Cadence enrollment effective plan or installed definition is invalid.');
    return;
  }
  const expectedAttempt = effectiveSteps.indexOf(cadence.cadenceStepId) + 1;
  if (expectedAttempt <= 0
    || settlement.plannerTransition.attempt !== expectedAttempt
    || enrollment.scheduled_step_count < expectedAttempt) {
    violations.push('Settlement attempt does not match the effective cadence plan.');
  }
  const step = definition.steps.find(({ id }) => id === cadence.cadenceStepId);
  const component = step?.components.find(({ id }) => id === cadence.cadenceComponentId);
  if (component === undefined
    || (action.actionType === 'resolve_contact_method'
      ? action.channel !== null
      : component.channel !== action.channel || component.actionType !== action.actionType)) {
    violations.push('Settlement component does not match the action owner graph/channel.');
    return;
  }
  if (action.actionType === 'resolve_contact_method') {
    const unavailable = component.outcomes.channel_unavailable;
    const operationalOutcomeIsLegal = settlement.outcome === 'resolved'
      || settlement.outcome === 'marked_impossible'
      || CADENCE_LIFECYCLE_CONTROL_OUTCOMES.has(settlement.outcome);
    if (!operationalOutcomeIsLegal || unavailable?.kind !== 'resolve_contact_method'
      || unavailable.componentId !== component.id) {
      violations.push('Resolver settlement does not match the component resolver branch.');
    }
    return;
  }
  const componentOutcomeAllowed = component.allowedOutcomes.some(
    (outcome) => outcome === settlement.outcome,
  ) && Object.prototype.hasOwnProperty.call(component.outcomes, settlement.outcome);
  if (!componentOutcomeAllowed
    && !CADENCE_LIFECYCLE_CONTROL_OUTCOMES.has(settlement.outcome)) {
    violations.push('Settlement outcome is not legal for the installed action component.');
  }
}

function collectActivityViolations(
  database: AppDatabase,
  action: SettlementValidationAction,
  violations: string[],
): void {
  const settlement = action.settlement!;
  if (settlement.evidenceActivityId === null) {
    if (!NULL_EVIDENCE_OUTCOMES.has(settlement.outcome)
      || action.completionActivityId !== null) {
      violations.push('Settlement outcome does not permit null Activity evidence.');
    }
    return;
  }
  const activity = database.raw.prepare<[string], ActivityEvidenceRow>(`
    SELECT person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
      cadence_step_id, cadence_component_id, kind, channel, observed_outcome
    FROM activities WHERE id = ?
  `).get(settlement.evidenceActivityId);
  const owner = database.raw.prepare<
    [string], { person_id: string; prospect_id: string }
  >('SELECT person_id, prospect_id FROM sales_cycles WHERE id = ?').get(action.salesCycleId);
  if (activity === undefined || owner === undefined
    || activity.person_id !== owner.person_id || activity.prospect_id !== owner.prospect_id) {
    violations.push('Settlement Activity is missing or not owned by the action Person/Prospect.');
    return;
  }
  if (settlement.outcome === 'opted_out') {
    if (activity.observed_outcome !== 'opted_out'
      || (activity.sales_cycle_id === action.salesCycleId
        ? action.completionActivityId !== settlement.evidenceActivityId
        : action.completionActivityId !== null)) {
      violations.push('Person-wide opt-out settlement has invalid Activity evidence.');
    }
    return;
  }
  if (settlement.outcome === 'interviewed_confirmed'
    || settlement.outcome === 'offered_confirmed') {
    const confirmationEvidence = {
      kind: activity.kind,
      observedOutcome: activity.observed_outcome,
    } as const;
    const qualifies = settlement.outcome === 'interviewed_confirmed'
      ? qualifiesFounderInterviewed(confirmationEvidence)
      : qualifiesFounderOffered(confirmationEvidence);
    if (!qualifies || activity.sales_cycle_id !== action.salesCycleId
      || action.completionActivityId !== settlement.evidenceActivityId) {
      violations.push('Founder confirmation Activity does not satisfy its exact predicate.');
    }
    return;
  }
  if (action.completionActivityId !== settlement.evidenceActivityId
    || activity.sales_cycle_id !== action.salesCycleId
    || activity.cadence_enrollment_id !== action.cadence.cadenceEnrollmentId
    || activity.cadence_step_id !== action.cadence.cadenceStepId
    || activity.cadence_component_id !== action.cadence.cadenceComponentId
    || (action.channel !== null && activity.channel !== action.channel)
    || activity.observed_outcome !== settlement.outcome) {
    violations.push('Settlement Activity graph/channel/outcome does not match the action.');
  }
}
