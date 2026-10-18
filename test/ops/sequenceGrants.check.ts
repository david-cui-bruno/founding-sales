import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { declaredGrants } from '../../tools/upgrade/grants.ts';
import { declaredSequenceGrantDifferences } from '../../tools/upgrade/sequenceGrants.ts';

const sequence = 'linkedin_manual_entries_sequence_seq';
const rights = ['app_runtime', 'migration'].flatMap(role => ['SELECT', 'USAGE'].map(right => `${role} | ${sequence} | ${right}`));
function fixture(sql: string, check: (directory: string) => void) {
  const directory = mkdtempSync(join(process.env['JCODE_SCRATCH_DIR'] ?? tmpdir(), 'sequence-grants-'));
  try {
    writeFileSync(join(directory, '0117_manual.sql'), sql);
    check(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const grant = `GRANT SELECT,USAGE ON SEQUENCE ${sequence} TO app_runtime,migration;`;

describe('explicit sequence privilege declarations', () => {
  it('does not invent a table target, and requires exact SELECT/USAGE for both roles', () => {
    fixture(`CREATE TABLE manual_entries(id uuid); GRANT SELECT ON manual_entries TO app_runtime; ${grant}`, directory => {
      expect([...declaredGrants(directory, 117).get('app_runtime')!.keys()]).toEqual(['manual_entries']);
      expect(declaredSequenceGrantDifferences(directory, 116, 117, [], rights)).toEqual([]);
      expect(declaredSequenceGrantDifferences(directory, 116, 117, [], [])).toEqual([
        { role: 'app_runtime', object: `sequence ${sequence}`, detail: 'missing SELECT, USAGE' },
        { role: 'migration', object: `sequence ${sequence}`, detail: 'missing SELECT, USAGE' },
      ]);
    });
  });
  it.each(rights)('refuses an actual missing required privilege: %s', missing => {
    fixture(grant, directory => {
      expect(declaredSequenceGrantDifferences(directory, 116, 117, [], rights.filter(right => right !== missing))).toEqual([
        { role: missing.split(' | ')[0], object: `sequence ${sequence}`, detail: `missing ${missing.split(' | ')[2]}` },
      ]);
    });
  });
  it('refuses undeclared UPDATE and retains both role boundaries', () => {
    fixture(grant, directory => {
      expect(declaredSequenceGrantDifferences(directory, 116, 117, [], [...rights, `app_runtime | ${sequence} | UPDATE`])).toEqual([
        { role: 'app_runtime', object: `sequence ${sequence}`, detail: 'unexpected UPDATE' },
      ]);
    });
  });
  it('replays exact public sequence lists and revokes in migration order', () => {
    fixture('GRANT ALL PRIVILEGES ON SEQUENCE public."first_seq",second_seq TO app_runtime,migration; REVOKE UPDATE ON SEQUENCE first_seq,second_seq FROM app_runtime,migration;', directory => {
      const live = ['first_seq', 'second_seq'].flatMap(name => ['app_runtime', 'migration'].flatMap(role => ['SELECT', 'USAGE'].map(right => `${role} | ${name} | ${right}`)));
      expect(declaredSequenceGrantDifferences(directory, 116, 117, [], live)).toEqual([]);
      expect(declaredSequenceGrantDifferences(directory, 117, 117, [], [])).toEqual([]);
    });
  });
});
