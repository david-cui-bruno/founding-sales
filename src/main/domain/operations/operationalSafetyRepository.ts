import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';

const idSchema = z.string().trim().min(1);
const sha256Schema = z.string().length(64);
const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
);
const stringListSchema = z.array(idSchema);

const backupInputSchema = z.object({
  id: idSchema,
  backupBasename: z.string().trim().min(1),
  kind: z.enum(['daily', 'manual', 'pre_release']),
  schemaVersion: z.number().int().positive(),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive(),
  createdAt: timestampSchema,
  verifiedAt: timestampSchema,
}).strict();
const backupRowSchema = z.object({
  id: idSchema,
  backup_basename: z.string().trim().min(1),
  kind: z.enum(['daily', 'manual', 'pre_release']),
  schema_version: z.number().int().positive(),
  sha256: sha256Schema,
  size_bytes: z.number().int().positive(),
  created_at: timestampSchema,
  verified_at: timestampSchema,
}).strict();
const recoveryReadinessRowSchema = z.object({
  recovery_setup_completed_at: timestampSchema.nullable(),
  last_restore_drill_at: timestampSchema.nullable(),
  last_restore_backup_sha256: sha256Schema.nullable(),
  updated_at: timestampSchema,
}).strict();
const recoverySetupSchema = z.object({ completedAt: timestampSchema }).strict();
const restoreDrillSchema = z.object({
  performedAt: timestampSchema,
  backupSha256: sha256Schema,
}).strict();
const identityRepairEventSchema = z.object({
  id: idSchema,
  manifestSha256: sha256Schema,
  candidateId: idSchema,
  canonicalPersonId: idSchema,
  createdPersonIds: stringListSchema,
  reassignedSourceEventIds: stringListSchema,
  appliedAt: timestampSchema,
}).strict();

export type BackupReceipt = Readonly<{
  id: string;
  backupBasename: string;
  kind: 'daily' | 'manual' | 'pre_release';
  schemaVersion: number;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  verifiedAt: string;
}>;

export type RecoveryReadiness = Readonly<{
  recoverySetupCompletedAt: string | null;
  lastRestoreDrillAt: string | null;
  lastRestoreBackupSha256: string | null;
  updatedAt: string;
}>;

export type IdentityRepairEvent = Readonly<{
  id: string;
  manifestSha256: string;
  candidateId: string;
  canonicalPersonId: string;
  createdPersonIds: readonly string[];
  reassignedSourceEventIds: readonly string[];
  appliedAt: string;
}>;

export class OperationalSafetyRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
  }

  recordBackup(receipt: BackupReceipt): void {
    this.unitOfWork.assertWriteScope();
    const parsed = backupInputSchema.parse(receipt);
    this.database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes,
       created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.id,
      parsed.backupBasename,
      parsed.kind,
      parsed.schemaVersion,
      parsed.sha256,
      parsed.sizeBytes,
      parsed.createdAt,
      parsed.verifiedAt,
    );
  }

  listBackups(): BackupReceipt[] {
    return this.database.raw.prepare(`SELECT id, backup_basename, kind,
      schema_version, sha256, size_bytes, created_at, verified_at
      FROM backup_receipts ORDER BY created_at DESC, id DESC`).all()
      .map((row) => backupFromRow(backupRowSchema.parse(row)));
  }

  recordRecoverySetupCompleted(input: { completedAt: string }): void {
    this.unitOfWork.assertWriteScope();
    const parsed = recoverySetupSchema.parse(input);
    this.database.raw.prepare(`UPDATE recovery_readiness
      SET recovery_setup_completed_at = ?, updated_at = ?
      WHERE singleton = 1`).run(parsed.completedAt, parsed.completedAt);
  }

  recordRestoreDrill(input: { performedAt: string; backupSha256: string }): void {
    this.unitOfWork.assertWriteScope();
    const parsed = restoreDrillSchema.parse(input);
    this.database.raw.prepare(`UPDATE recovery_readiness
      SET last_restore_drill_at = ?, last_restore_backup_sha256 = ?, updated_at = ?
      WHERE singleton = 1`).run(
      parsed.performedAt,
      parsed.backupSha256,
      parsed.performedAt,
    );
  }

  getRecoveryReadiness(): RecoveryReadiness {
    const parsed = recoveryReadinessRowSchema.parse(
      this.database.raw.prepare(`SELECT recovery_setup_completed_at,
        last_restore_drill_at, last_restore_backup_sha256, updated_at
        FROM recovery_readiness WHERE singleton = 1`).get(),
    );
    return {
      recoverySetupCompletedAt: parsed.recovery_setup_completed_at,
      lastRestoreDrillAt: parsed.last_restore_drill_at,
      lastRestoreBackupSha256: parsed.last_restore_backup_sha256,
      updatedAt: parsed.updated_at,
    };
  }

  appendIdentityRepairEvent(event: IdentityRepairEvent): void {
    this.unitOfWork.assertWriteScope();
    const parsed = identityRepairEventSchema.parse(event);
    this.database.raw.prepare(`INSERT INTO identity_repair_events
      (id, manifest_sha256, candidate_id, canonical_person_id,
       created_person_ids_json, reassigned_source_event_ids_json, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.id,
      parsed.manifestSha256,
      parsed.candidateId,
      parsed.canonicalPersonId,
      JSON.stringify(parsed.createdPersonIds),
      JSON.stringify(parsed.reassignedSourceEventIds),
      parsed.appliedAt,
    );
  }
}

function backupFromRow(row: z.infer<typeof backupRowSchema>): BackupReceipt {
  return {
    id: row.id,
    backupBasename: row.backup_basename,
    kind: row.kind,
    schemaVersion: row.schema_version,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}
