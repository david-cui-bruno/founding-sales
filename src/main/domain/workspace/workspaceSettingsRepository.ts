import { isDeepStrictEqual } from 'node:util';
import { localKnownCompanyConfigurationSchema, updateCompanyResearchSettingsRequestSchema, type UpdateCompanyResearchSettingsRequest } from '../../../shared/contracts/localCompanyResearchSettingsContract';
import { validateKnownCompanyActivation } from '../../research/knownCompanyRequestProfile';
import { meetingFirstAccountCallSettingsSchema, type MeetingFirstAccountCallSettings } from '../../../shared/contracts/localWorkspaceContract';
export type { MeetingFirstAccountCallSettings } from '../../../shared/contracts/localWorkspaceContract';
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

/** D2 (17 Sep 2026): an unconfigured workspace lists this many new firms a morning. Settings can replace it with any number, including 0. */
export const DEFAULT_NEW_CALL_SLOTS = 30;

/** The allocation Today plans with: the typed number when Settings has one, otherwise the default, and which of the two it was. */
export type AccountCallAllocation = Readonly<{
  newCallSlots: number;
  totalCallCapacity: number | null;
  source: 'default' | 'configured';
  revision: number;
  updatedAt: string;
}>;

/** Pure: the stored record resolved to what Today plans with. */
export function resolveAccountCallAllocation(stored: MeetingFirstAccountCallSettings): AccountCallAllocation {
  return Object.freeze({
    newCallSlots: stored.newCallSlots ?? DEFAULT_NEW_CALL_SLOTS,
    totalCallCapacity: stored.totalCallCapacity,
    source: stored.newCallSlots === null ? 'default' : 'configured',
    revision: stored.revision,
    updatedAt: stored.updatedAt,
  });
}

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

  readMeetingFirstAccountCallSettings(): MeetingFirstAccountCallSettings {
    const row = this.database.raw.prepare(`
      SELECT new_call_slots AS newCallSlots,
             total_call_capacity AS totalCallCapacity,
             revision,
             updated_at AS updatedAt
      FROM meeting_first_call_settings WHERE singleton = 1
    `).get() as { newCallSlots: number | null; totalCallCapacity: number | null; revision: number; updatedAt: string } | undefined;
    const parsed = meetingFirstAccountCallSettingsSchema.safeParse(row);
    if (!parsed.success) throw new WorkspaceSettingsCorruptionError('Meeting-first account call settings are malformed.');
    return Object.freeze({
      newCallSlots: parsed.data.newCallSlots,
      totalCallCapacity: parsed.data.totalCallCapacity,
      revision: parsed.data.revision,
      updatedAt: parsed.data.updatedAt,
    });
  }

  /** Stored settings resolved to what Today plans with. The stored read above stays null when unconfigured so Settings shows the truth. */
  readAccountCallAllocation(): AccountCallAllocation {
    return resolveAccountCallAllocation(this.readMeetingFirstAccountCallSettings());
  }

  updateMeetingFirstAccountCallSettingsCas(input: {
    expectedRevision: number;
    newCallSlots: number | null;
    totalCallCapacity: number | null;
    updatedAt: string;
  }): MeetingFirstAccountCallSettings {
    this.unitOfWork.assertWriteScope();
    const parsed = z.strictObject({
      expectedRevision: z.number().int().nonnegative().safe(),
      newCallSlots: z.number().int().nonnegative().safe().nullable(),
      totalCallCapacity: z.number().int().nonnegative().safe().nullable(),
      updatedAt: z.iso.datetime({ precision: 3 }),
    }).parse(input);
    if (parsed.expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceSettingsCorruptionError('Call settings revision exhausted.');
    }
    const result = this.database.raw.prepare(`
      UPDATE meeting_first_call_settings
      SET new_call_slots = ?, total_call_capacity = ?, revision = revision + 1, updated_at = ?
      WHERE singleton = 1 AND revision = ?
    `).run(parsed.newCallSlots, parsed.totalCallCapacity, parsed.updatedAt, parsed.expectedRevision);
    if (result.changes !== 1) {
      throw new WorkspaceSettingsCorruptionError('Meeting-first account call settings changed before this update.');
    }
    return this.readMeetingFirstAccountCallSettings();
  }

  readCompanyResearchSettings() {
    const row = z.strictObject({ revision: z.number().int().nonnegative().safe(), configuration: z.string().nullable() }).parse(
      this.database.raw.prepare('SELECT known_company_research_revision AS revision, known_company_research_json AS configuration FROM workspace_settings WHERE singleton=1').get());
    return { revision: row.revision, configuration: row.configuration === null ? null : localKnownCompanyConfigurationSchema.parse(JSON.parse(row.configuration)) };
  }

  updateCompanyResearchSettingsCas(input: UpdateCompanyResearchSettingsRequest, updatedAt: string) {
    this.unitOfWork.assertWriteScope();
    const parsed = updateCompanyResearchSettingsRequestSchema.parse(input);
    z.iso.datetime({ precision: 3 }).parse(updatedAt);
    if (parsed.expectedRevision === Number.MAX_SAFE_INTEGER) throw new WorkspaceSettingsCorruptionError('Research settings revision exhausted');
    const current = this.readCompanyResearchSettings();
    if (parsed.configuration.state === 'paused') {
      if (!current.configuration || !isDeepStrictEqual(parsed.configuration, { ...current.configuration, state: 'paused' })) throw new Error('Pause must preserve reviewed configuration');
    } else {
      if (!parsed.reviewed) throw new Error('Research review required');
      validateKnownCompanyActivation(parsed.configuration);
    }
    const result = this.database.raw.prepare(`UPDATE workspace_settings SET known_company_research_json=?, known_company_research_revision=known_company_research_revision+1, updated_at=? WHERE singleton=1 AND known_company_research_revision=?`).run(JSON.stringify(parsed.configuration), updatedAt, parsed.expectedRevision);
    if (result.changes !== 1) throw new WorkspaceSettingsCorruptionError('Research settings changed before update');
    return this.readCompanyResearchSettings();
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
