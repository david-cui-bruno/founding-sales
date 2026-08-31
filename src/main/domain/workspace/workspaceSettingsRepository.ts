import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';

const utcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

const storedSettingsSchema = z.object({
  singleton: z.literal(1),
  timezone: z.string().trim().min(1).refine((timezone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, 'Workspace timezone must be a valid IANA zone.'),
  daily_dial_capacity: z.number().int().nonnegative(),
  daily_conversation_target: z.number().int().nonnegative(),
  exploration_slots: z.number().int().nonnegative(),
  resurface_suppression_days: z.number().int().nonnegative(),
  active_prioritization_rule_version_id: z.string().trim().min(1).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
}).strict();

export type WorkspaceSettings = Readonly<{
  timezone: string;
  dailyDialCapacity: number;
  dailyConversationTarget: number;
  explorationSlots: number;
  resurfaceSuppressionDays: number;
  activePrioritizationRuleVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export class WorkspaceSettingsCorruptionError extends Error {
  constructor(message = 'The workspace settings singleton row is missing or malformed.') {
    super(message);
    this.name = 'WorkspaceSettingsCorruptionError';
  }
}

/**
 * Strict reads plus scoped CAS only for the singleton settings row. Missing,
 * duplicate, or malformed settings are fatal startup corruption.
 */
export class WorkspaceSettingsRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  read(): WorkspaceSettings {
    const rows = this.database.raw.prepare(`
      SELECT singleton, timezone, daily_dial_capacity, daily_conversation_target,
             exploration_slots, resurface_suppression_days,
             active_prioritization_rule_version_id, created_at, updated_at
      FROM workspace_settings
    `).all();
    if (rows.length !== 1) {
      throw new WorkspaceSettingsCorruptionError(
        `Expected exactly one workspace settings row, found ${rows.length}.`,
      );
    }
    const parsed = storedSettingsSchema.safeParse(rows[0]);
    if (!parsed.success) {
      throw new WorkspaceSettingsCorruptionError();
    }
    const row = parsed.data;
    return Object.freeze({
      timezone: row.timezone,
      dailyDialCapacity: row.daily_dial_capacity,
      dailyConversationTarget: row.daily_conversation_target,
      explorationSlots: row.exploration_slots,
      resurfaceSuppressionDays: row.resurface_suppression_days,
      activePrioritizationRuleVersionId: row.active_prioritization_rule_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  activateRulePointerCas(input: {
    expectedActiveRuleVersionId: string | null;
    nextActiveRuleVersionId: string;
    updatedAt: string;
  }): void {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      expectedActiveRuleVersionId: z.string().trim().min(1).nullable(),
      nextActiveRuleVersionId: z.string().trim().min(1),
      updatedAt: utcTimestampSchema,
    }).strict().parse(input);
    const result = this.database.raw.prepare(`
      UPDATE workspace_settings
      SET active_prioritization_rule_version_id = ?, updated_at = ?
      WHERE singleton = 1 AND active_prioritization_rule_version_id IS ?
    `).run(
      parsed.nextActiveRuleVersionId,
      parsed.updatedAt,
      parsed.expectedActiveRuleVersionId,
    );
    if (result.changes === 0) {
      throw new WorkspaceSettingsCorruptionError(
        'The active rule pointer changed before this activation.',
      );
    }
  }
}
