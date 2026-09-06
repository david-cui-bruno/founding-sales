import { describe, expect, it } from 'vitest';

import { selectDailyBackupsForDeletion } from '../../../src/main/backup/backupRetention';
import type { BackupReceipt } from '../../../src/main/domain/operations/operationalSafetyRepository';

function receipt(date: string, kind: BackupReceipt['kind'] = 'daily'): BackupReceipt {
  return {
    id: `${kind}-${date}`, kind,
    backupBasename: `${kind}-${date.replace(/-/g, '')}T120000000Z.sqlite3`,
    schemaVersion: 15, sha256: 'a'.repeat(64), sizeBytes: 4096,
    createdAt: `${date}T12:00:00.000Z`, verifiedAt: `${date}T12:00:00.000Z`,
  };
}

describe('daily backup retention', () => {
  it('keeps the newest 14 daily copies plus newest representatives of eight ISO weeks, across ISO year boundaries', () => {
    const receipts = Array.from({ length: 70 }, (_, age) => receipt(
      new Date(Date.UTC(2027, 0, 10 - age)).toISOString().slice(0, 10),
    )).reverse();
    const removed = selectDailyBackupsForDeletion(receipts);
    const removedIds = new Set(removed.map((entry) => entry.id));
    const kept = receipts.filter((entry) => !removedIds.has(entry.id));
    expect(kept.map((entry) => entry.createdAt.slice(0, 10))).toEqual([
      '2026-11-22', '2026-11-29', '2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27',
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02',
      '2027-01-03', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08',
      '2027-01-09', '2027-01-10',
    ]);
    expect(removed).toHaveLength(50);
  });

  it('never selects migration, manual, pre-release or malformed/path-traversal names even when mislabelled daily', () => {
    const daily = Array.from({ length: 20 }, (_, day) => receipt(`2026-09-${String(day + 1).padStart(2, '0')}`));
    const protectedReceipts = [
      receipt('2020-01-01', 'manual'), receipt('2020-01-01', 'pre_release'),
      { ...receipt('2020-01-01'), backupBasename: 'pre-migration-schema-1-20200101T120000000Z.sqlite3' },
      { ...receipt('2020-01-02'), backupBasename: '../daily-20200102T120000000Z.sqlite3' },
      { ...receipt('2020-01-03'), createdAt: 'invalid' },
      { ...receipt('2020-01-04'), backupBasename: 'unknown.sqlite3' },
    ];
    const removed = selectDailyBackupsForDeletion([...protectedReceipts, ...daily]);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((entry) => daily.includes(entry))).toBe(true);
  });

  it('keeps small sets and does not mutate repository ordering', () => {
    const entries = [receipt('2026-01-01'), receipt('2026-01-03'), receipt('2026-01-02')];
    const original = [...entries];
    expect(selectDailyBackupsForDeletion(entries)).toEqual([]);
    expect(entries).toEqual(original);
  });
});
