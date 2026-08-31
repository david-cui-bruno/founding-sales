import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { BUILTIN_CADENCES } from './builtinCadences';
import {
  cadenceActionTypeSchema,
  cadenceFamilySchema,
  canonicalJson,
  parseCadenceAggregate,
  type CadenceAggregate,
} from './cadenceTypes';

const idSchema = z.string().trim().min(1);
const textSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true }).refine((value) => (
  new Date(value).toISOString() === value
), 'Timestamp must use canonical UTC ISO format.');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const definitionRowSchema = z.object({
  id: idSchema,
  family: cadenceFamilySchema,
  version: z.number().int().positive(),
  name: textSchema,
  content_hash: hashSchema,
  attempt_cap: z.number().int().positive(),
  definition_json: z.string(),
  created_at: timestampSchema,
}).strict();
const stepRowSchema = z.object({
  id: idSchema,
  cadence_definition_id: idSchema,
  sequence: z.number().int().nonnegative(),
  day_offset: z.number().int().nonnegative(),
  label: textSchema,
  breakup: z.union([z.literal(0), z.literal(1)]),
  step_json: z.string(),
  created_at: timestampSchema,
}).strict();
const componentRowSchema = z.object({
  id: idSchema,
  cadence_step_id: idSchema,
  sequence: z.number().int().nonnegative(),
  action_type: cadenceActionTypeSchema,
  channel: z.enum(['phone', 'voicemail', 'text', 'email']),
  condition_json: z.string().nullable(),
  outcome_graph_json: z.string(),
  template_json: z.string(),
  created_at: timestampSchema,
}).strict();
const definitionEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  category: z.enum(['prospecting', 'post_stage', 'onboarding']),
  policyIds: z.object({ call: idSchema, text: idSchema, email: idSchema }).strict(),
}).strict();
const stepEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  timing: z.object({
    kind: z.enum(['immediate', 'policy_window']),
    differentCallWindow: z.boolean(),
    finalSlaDayOffset: z.number().int().nonnegative().nullable(),
  }).strict(),
}).strict();
const conditionEnvelopeSchema = z.object({
  formatVersion: z.literal(1), condition: textSchema,
}).strict();
const outcomeEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  allowedOutcomes: z.array(z.string()),
  outcomes: z.record(z.string(), z.unknown()),
}).strict();
const templateEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  template: z.object({ id: idSchema, version: z.number().int().positive(), body: textSchema }).strict(),
}).strict();

const definitionColumns = `
  id, family, version, name, content_hash, attempt_cap, definition_json, created_at
`;
const stepColumns = `
  id, cadence_definition_id, sequence, day_offset, label, breakup, step_json, created_at
`;
const componentColumns = `
  id, cadence_step_id, sequence, action_type, channel, condition_json,
  outcome_graph_json, template_json, created_at
`;

export class CadenceVersionConflictError extends Error {
  readonly family: string;
  readonly version: number;

  constructor(family: string, version: number) {
    super('The cadence family/version already exists with different mechanics or copy.');
    this.name = 'CadenceVersionConflictError';
    this.family = family;
    this.version = version;
  }
}

export class CadenceCatalogCorruptionError extends Error {
  readonly cadenceDefinitionId: string;

  constructor(cadenceDefinitionId: string, cause?: unknown) {
    super('Stored cadence catalog data failed canonical integrity validation.', { cause });
    this.name = 'CadenceCatalogCorruptionError';
    this.cadenceDefinitionId = cadenceDefinitionId;
  }
}

export class CadenceRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; clock: Clock }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  installBuiltins(): CadenceAggregate[] {
    this.unitOfWork.assertWriteScope();
    return BUILTIN_CADENCES.map((definition) => this.install(definition));
  }

  install(input: CadenceAggregate): CadenceAggregate {
    this.unitOfWork.assertWriteScope();
    const definition = parseCadenceAggregate(input);
    const existing = this.getByFamilyVersion(definition.family, definition.version);
    if (existing !== null) {
      if (canonicalJson(existing) !== canonicalJson(definition)) {
        throw new CadenceVersionConflictError(definition.family, definition.version);
      }
      return existing;
    }
    const createdAt = timestampSchema.parse(this.clock.now());
    const definitionJson = canonicalJson({
      formatVersion: 1,
      category: definition.category,
      policyIds: definition.policyIds,
    });
    this.database.raw.prepare(`
      INSERT INTO cadence_definitions (
        id, family, version, name, content_hash, attempt_cap,
        definition_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      definition.id, definition.family, definition.version, definition.name,
      definition.contentHash, definition.attemptCap, definitionJson, createdAt,
    );
    for (const step of definition.steps) {
      this.database.raw.prepare(`
        INSERT INTO cadence_steps (
          id, cadence_definition_id, sequence, day_offset, label,
          breakup, step_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        step.id, definition.id, step.sequence, step.dayOffset, step.label,
        step.breakup ? 1 : 0,
        canonicalJson({ formatVersion: 1, timing: step.timing }),
        createdAt,
      );
      for (const component of step.components) {
        this.database.raw.prepare(`
          INSERT INTO cadence_action_components (
            id, cadence_step_id, sequence, action_type, channel,
            condition_json, outcome_graph_json, template_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          component.id, step.id, component.sequence, component.actionType,
          component.channel,
          component.condition === null
            ? null
            : canonicalJson({ formatVersion: 1, condition: component.condition }),
          canonicalJson({
            formatVersion: 1,
            allowedOutcomes: component.allowedOutcomes,
            outcomes: component.outcomes,
          }),
          canonicalJson({ formatVersion: 1, template: component.template }),
          createdAt,
        );
      }
    }
    return this.getById(definition.id)!;
  }

  getById(id: string): CadenceAggregate | null {
    const parsedId = idSchema.parse(id);
    const row = this.database.raw.prepare(`
      SELECT ${definitionColumns} FROM cadence_definitions WHERE id = ?
    `).get(parsedId);
    return row === undefined ? null : this.parseAggregate(row);
  }

  getByFamilyVersion(family: CadenceAggregate['family'], version: number): CadenceAggregate | null {
    const parsedFamily = cadenceFamilySchema.parse(family);
    const parsedVersion = z.number().int().positive().parse(version);
    const row = this.database.raw.prepare(`
      SELECT ${definitionColumns}
      FROM cadence_definitions WHERE family = ? AND version = ?
    `).get(parsedFamily, parsedVersion);
    return row === undefined ? null : this.parseAggregate(row);
  }

  list(): CadenceAggregate[] {
    const rows = this.database.raw.prepare(`
      SELECT ${definitionColumns}
      FROM cadence_definitions
      ORDER BY CASE family
        WHEN 'cadence_a' THEN 1 WHEN 'cadence_b' THEN 2 WHEN 'cadence_c' THEN 3
        WHEN 'post_interview' THEN 4 WHEN 'post_offer' THEN 5 WHEN 'onboarding' THEN 6
        ELSE 99 END, version ASC, id ASC
    `).all();
    return rows.map((row) => this.parseAggregate(row));
  }

  private parseAggregate(value: unknown): CadenceAggregate {
    let id = 'unknown';
    try {
      const definitionRow = definitionRowSchema.parse(value);
      id = definitionRow.id;
      const definition = parseCanonicalEnvelope(
        definitionRow.definition_json,
        definitionEnvelopeSchema,
      );
      const stepRows = this.database.raw.prepare(`
        SELECT ${stepColumns} FROM cadence_steps
        WHERE cadence_definition_id = ? ORDER BY sequence ASC, id ASC
      `).all(definitionRow.id).map((row) => stepRowSchema.parse(row));
      if (stepRows.length === 0) throw new Error('Cadence definition has no steps.');
      const steps = stepRows.map((stepRow) => {
        const stepEnvelope = parseCanonicalEnvelope(stepRow.step_json, stepEnvelopeSchema);
        const componentRows = this.database.raw.prepare(`
          SELECT ${componentColumns} FROM cadence_action_components
          WHERE cadence_step_id = ? ORDER BY sequence ASC, id ASC
        `).all(stepRow.id).map((row) => componentRowSchema.parse(row));
        if (componentRows.length === 0) throw new Error('Cadence step has no components.');
        return {
          id: stepRow.id,
          sequence: stepRow.sequence,
          dayOffset: stepRow.day_offset,
          label: stepRow.label,
          breakup: stepRow.breakup === 1,
          timing: stepEnvelope.timing,
          components: componentRows.map((componentRow) => {
            const condition = componentRow.condition_json === null
              ? null
              : parseCanonicalEnvelope(componentRow.condition_json, conditionEnvelopeSchema).condition;
            const graph = parseCanonicalEnvelope(componentRow.outcome_graph_json, outcomeEnvelopeSchema);
            const template = parseCanonicalEnvelope(componentRow.template_json, templateEnvelopeSchema).template;
            return {
              id: componentRow.id,
              sequence: componentRow.sequence,
              actionType: componentRow.action_type,
              channel: componentRow.channel,
              condition,
              allowedOutcomes: graph.allowedOutcomes,
              outcomes: graph.outcomes,
              template,
            };
          }),
        };
      });
      return parseCadenceAggregate({
        id: definitionRow.id,
        family: definitionRow.family,
        version: definitionRow.version,
        name: definitionRow.name,
        category: definition.category,
        attemptCap: definitionRow.attempt_cap,
        policyIds: definition.policyIds,
        steps,
        contentHash: definitionRow.content_hash,
      });
    } catch (error) {
      throw new CadenceCatalogCorruptionError(id, error);
    }
  }
}

function parseCanonicalEnvelope<Output>(
  value: string,
  schema: z.ZodType<Output>,
): Output {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CadenceCatalogCorruptionError('unknown', error);
  }
  const parsed = schema.parse(parsedJson);
  if (canonicalJson(parsed) !== value) {
    throw new CadenceCatalogCorruptionError('unknown');
  }
  return parsed;
}
