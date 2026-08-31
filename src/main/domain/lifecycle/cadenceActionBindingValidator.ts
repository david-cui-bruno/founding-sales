import type { AppDatabase } from '../../db/database';
import {
  readInstalledCadenceAggregate,
} from '../cadence/cadenceRepository';
import type {
  CadenceActionComponent,
  CadenceAggregate,
  CadenceStep,
} from '../cadence/cadenceTypes';
import { LifecycleEvidenceError } from '../support/domainErrors';
import type { CadenceActionBinding } from './lifecycleTypes';

export type InstalledCadenceActionBindingInput = Readonly<{
  salesCycleId: string;
  actionType: string;
  channel: string | null;
  cadence: CadenceActionBinding;
}>;

export type ResolvedInstalledCadenceActionBinding = Readonly<{
  definition: CadenceAggregate;
  step: CadenceStep;
  component: CadenceActionComponent;
  kind: 'standard' | 'resolver';
}>;

export function resolveInstalledCadenceActionBinding(
  database: AppDatabase,
  input: InstalledCadenceActionBindingInput,
): ResolvedInstalledCadenceActionBinding | null {
  if (input.cadence.cadenceEnrollmentId === null) {
    if (input.actionType === 'resolve_contact_method') {
      throw new LifecycleEvidenceError('Contact-method resolution requires an installed cadence component.');
    }
    return null;
  }
  const enrollment = database.raw.prepare<
    [string], { sales_cycle_id: string; cadence_definition_id: string }
  >(`
    SELECT sales_cycle_id, cadence_definition_id
    FROM cadence_enrollments WHERE id = ?
  `).get(input.cadence.cadenceEnrollmentId);
  if (enrollment === undefined
    || enrollment.sales_cycle_id !== input.salesCycleId
    || enrollment.cadence_definition_id !== input.cadence.cadenceDefinitionId) {
    throw new LifecycleEvidenceError('Cadence action enrollment is missing or unowned.');
  }
  let definition: CadenceAggregate | null;
  try {
    definition = readInstalledCadenceAggregate(
      database.raw, input.cadence.cadenceDefinitionId,
    );
  } catch {
    throw new LifecycleEvidenceError('Installed cadence definition is corrupt.');
  }
  const step = definition?.steps.find(({ id }) => id === input.cadence.cadenceStepId);
  const component = step?.components.find(({ id }) => id === input.cadence.cadenceComponentId);
  if (definition === null || step === undefined || component === undefined) {
    throw new LifecycleEvidenceError('Cadence action step/component identity is not installed.');
  }
  if (input.actionType === 'resolve_contact_method') {
    const unavailable = component.outcomes.channel_unavailable;
    if (input.channel !== null
      || unavailable?.kind !== 'resolve_contact_method'
      || unavailable.componentId !== component.id) {
      throw new LifecycleEvidenceError('Resolver action does not match the component resolver branch.');
    }
    return Object.freeze({ definition, step, component, kind: 'resolver' });
  }
  if (input.actionType !== component.actionType || input.channel !== component.channel) {
    throw new LifecycleEvidenceError('Action type/channel does not match its installed component.');
  }
  return Object.freeze({ definition, step, component, kind: 'standard' });
}

export function collectInstalledCadenceActionBindingViolations(
  database: AppDatabase,
  input: InstalledCadenceActionBindingInput,
): readonly string[] {
  try {
    resolveInstalledCadenceActionBinding(database, input);
    return Object.freeze([]);
  } catch (error) {
    return Object.freeze([
      error instanceof Error ? error.message : 'Installed cadence action binding is invalid.',
    ]);
  }
}
