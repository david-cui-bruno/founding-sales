import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanWithGitleaks } from '../scripts/verifySecrets.mjs';

it('excepts only the exact public preload inventory line, file and LinkedIn client-ID rule', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-preload-inventory-'));
  const exactPath = 'tests/integration/appleSpikePreload.test.ts';
  const candidate = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  const baseline = candidate.split('# Exact public preload API inventory')[0];
  const publicLine = readFileSync(new URL(`../${exactPath}`, import.meta.url), 'utf8').split('\n').find(line => line.includes("'localWorkspace'"));
  expect(createHash('sha256').update(publicLine).digest('hex')).toBe('88edd0efeb23ba4bff5c576c4deacc405d2e5452933eeb40d33467502e8ad14e');
  const rule = 'linkedin-client-id';
  const fabricated = createHash('sha256').update('unissued preload inventory calibration').digest('hex').slice(0, 14);
  let invocation = 0;
  const scan = (config, file, contents) => {
    const target = join(root, `case-${invocation++}`), temporary = join(root, `report-${invocation}`);
    mkdirSync(join(target, file, '..'), { recursive: true, mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(target, file), contents, { mode: 0o600 });
    writeFileSync(join(root, '.gitleaks.toml'), config, { mode: 0o600 });
    let rules = [];
    const run = (command, args, options) => {
      const result = spawnSync(command, args, options);
      rules = JSON.parse(readFileSync(args[args.indexOf('--report-path') + 1], 'utf8')).map(item => item.RuleID);
      return result;
    };
    return { ...scanWithGitleaks({ root, target, kind: 'context', temporary, run }), rules };
  };
  try {
    for (const padding of ['', '// context\n'.repeat(22)]) {
      expect(scan(baseline, exactPath, padding + publicLine + '\n').rules).toContain(rule);
      expect(scan(candidate, exactPath, padding + publicLine + '\n').findings).toBe(0);
    }
    for (const contents of [
      publicLine.replace('localWorkspace', fabricated) + '\n',
      publicLine + ' // changed\n',
      publicLine + '\r\n',
      publicLine + `\nlinkedin_client_id="${fabricated}"\n`,
      `linkedin_client_id="${fabricated}"\n` + publicLine + '\n',
      publicLine + `; linkedin_client_id="${fabricated}"\n`,
    ]) expect(scan(candidate, exactPath, contents).rules).toContain(rule);
    for (const file of ['other.ts', `nested/${exactPath}`, exactPath + '.bak']) {
      expect(scan(candidate, file, publicLine + '\n').rules).toContain(rule);
    }
    const otherRule = '\n[[rules]]\nid="synthetic-preload-control"\ndescription="Independent public-name control"\nregex="localWorkspace"\n';
    expect(scan(candidate + otherRule, exactPath, publicLine + '\n').rules).toContain('synthetic-preload-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
