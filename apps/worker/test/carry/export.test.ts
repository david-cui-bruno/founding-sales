import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesGcmCipher } from '../../tools/carry/artifact.ts';
import { recordedFixtureReader } from '../../tools/carry/dynamoPort.ts';
import { runCarryExport } from '../../tools/carry/export.ts';
import { readOldRecord } from '../../tools/carry/oldShapes.ts';
import { readWatermark } from '../../tools/carry/watermark.ts';
import {
  AFTER_WATERMARK,
  FIXTURE_WATERMARK,
  goodOldTable,
  tableWithUnreadableRecord,
} from '../fixtures/carry/oldTable.ts';

/**
 * What the export refuses (lane G11; specification 2 "Data carry", 17, Appendix G 20).
 *
 * The export is the one place that can still say no cheaply: after it, an artifact
 * exists and somebody has to shred it. So every refusal is here rather than in the
 * importer, and there is no override flag for any of them — a carry that could be
 * forced past a missing watermark is a carry with no watermark.
 */

const NOW = new Date('2026-09-21T14:00:00.000Z');
const cipher = aesGcmCipher(randomBytes(32));

const flag = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'fss.carry.watermark.v1',
    disabledAt: FIXTURE_WATERMARK,
    scheduleRuleName: 'fss-old-worker-schedule',
    recordedBy: 'operator',
    ...overrides,
  });

describe('the watermark flag file', () => {
  it('names the instant the old worker schedule was disabled', () => {
    const read = readWatermark(flag(), NOW);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.disabledAt).toBe(FIXTURE_WATERMARK);
    expect(read.value.scheduleRuleName).toBe('fss-old-worker-schedule');
  });

  it.each([
    ['absent', null, 'watermark_absent'],
    ['not JSON', 'disabled at noon', 'watermark_unreadable'],
    ['another schema', JSON.stringify({ schema: 'something.else', disabledAt: FIXTURE_WATERMARK }), 'watermark_schema_unknown'],
    ['no instant', flag({ disabledAt: '' }), 'watermark_instant_invalid'],
    ['an unparsable instant', flag({ disabledAt: 'yesterday' }), 'watermark_instant_invalid'],
    ['no rule named', flag({ scheduleRuleName: '' }), 'watermark_schedule_unnamed'],
    ['an instant in the future', flag({ disabledAt: '2026-09-22T00:00:00.000Z' }), 'watermark_in_future'],
  ])('refuses %s', (_label, source, reason) => {
    const read = readWatermark(source as string | null, NOW);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe(reason);
  });
});

describe('the export', () => {
  it('refuses to run without a watermark', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag: null,
      cipher,
      now: NOW,
      artifactId: 'carry-no-watermark',
    });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.reason).toBe('watermark_absent');
  });

  it('queries exactly the prefixes the carry reads, and no others', async () => {
    const asked: string[] = [];
    const reader = recordedFixtureReader(goodOldTable());
    await runCarryExport({
      reader: {
        description: 'recording',
        listByPrefix: async prefix => {
          asked.push(prefix);
          return reader.listByPrefix(prefix);
        },
      },
      watermarkFlag: flag(),
      cipher,
      now: NOW,
      artifactId: 'carry-prefixes',
    });
    expect(asked).toEqual(['FIRM#', 'ACCOUNT#', 'EVIDENCE#', 'SUPPRESS#', 'TEMPLATE#']);
  });

  it('fails the run on a record it cannot read rather than skipping it', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(tableWithUnreadableRecord()),
      watermarkFlag: flag(),
      cipher,
      now: NOW,
      artifactId: 'carry-unreadable',
    });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.reason).toBe('record_unreadable');
    expect(exported.detail).toEqual({ firm: 1 });
  });

  it('never names a firm, a number or an address in a refusal', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(tableWithUnreadableRecord()),
      watermarkFlag: flag(),
      cipher,
      now: NOW,
      artifactId: 'carry-unreadable',
    });
    expect(JSON.stringify(exported)).not.toContain('account-echo');
    expect(JSON.stringify(exported)).not.toContain('5550');
  });

  it('carries a firm once when both an old and a new record exist for it', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag: flag(),
      cipher,
      now: NOW,
      artifactId: 'carry-both-shapes',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const firmIds = exported.value.manifest.items.filter(entry => entry.kind === 'firm').map(entry => entry.oldId);
    expect(firmIds).toEqual(['account-alpha', 'account-bravo', 'account-charlie', 'account-delta']);
  });

  it('gives the same item the same content hash on every run', async () => {
    const first = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag: flag(),
      cipher,
      now: NOW,
      artifactId: 'carry-stable-1',
    });
    const second = await runCarryExport({
      reader: recordedFixtureReader([...goodOldTable()].reverse()),
      watermarkFlag: flag(),
      cipher,
      now: new Date('2026-09-22T09:00:00.000Z'),
      artifactId: 'carry-stable-2',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.manifest.items).toEqual(second.value.manifest.items);
    expect(first.value.receipt.manifestDigest).not.toBe(second.value.receipt.manifestDigest);
  });
});

describe('the old item shapes', () => {
  it('reads the instant every kind records, so a post-watermark write is visible', () => {
    for (const item of goodOldTable()) {
      const read = readOldRecord(item);
      expect(read.ok, item.sk.split('#')[0]).toBe(true);
      if (!read.ok) continue;
      expect(Number.isNaN(Date.parse(read.value.recordedAt))).toBe(false);
      expect(Date.parse(read.value.recordedAt)).toBeLessThan(Date.parse(AFTER_WATERMARK));
    }
  });

  it('tells a firm-scoped suppression from a handle-scoped one by the sort key alone', () => {
    const table = goodOldTable();
    const firmScoped = table.find(entry => entry.sk.startsWith('SUPPRESS#FIRM#'));
    const handleScoped = table.find(entry => entry.sk.startsWith('SUPPRESS#') && !entry.sk.startsWith('SUPPRESS#FIRM#'));
    expect(firmScoped).toBeDefined();
    expect(handleScoped).toBeDefined();
    const first = readOldRecord(firmScoped!);
    const second = readOldRecord(handleScoped!);
    expect(first.ok && first.value.kind === 'suppression' && first.value.suppression.scope).toBe('firm');
    expect(second.ok && second.value.kind === 'suppression' && second.value.suppression.scope).toBe('handle');
  });

  it('refuses a record that is missing a field the carry needs', () => {
    const read = readOldRecord({ sk: 'FIRM#account-echo', workspaceId: 'legacy', data: { version: 1 } });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('record_unreadable');
  });

  it('refuses a sort key it does not recognise', () => {
    const read = readOldRecord({ sk: 'CAMPAIGN_EVIDENCE#x', workspaceId: 'legacy', data: {} });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('sk_unknown');
  });
});
