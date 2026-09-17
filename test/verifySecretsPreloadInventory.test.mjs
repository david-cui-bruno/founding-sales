import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanWithGitleaks } from '../scripts/verifySecrets.mjs';

it('excepts only the exact current and retired public preload inventory lines, file and LinkedIn client-ID rule', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-preload-inventory-'));
  const exactPath = 'tests/integration/appleSpikePreload.test.ts';
  const candidate = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  const baseline = candidate.split('# Exact public preload API inventory')[0];
  const publicLine = readFileSync(new URL(`../${exactPath}`, import.meta.url), 'utf8').split('\n').find(line => line.includes("'localWorkspace'"));
  expect(createHash('sha256').update(publicLine).digest('hex')).toBe('88edd0efeb23ba4bff5c576c4deacc405d2e5452933eeb40d33467502e8ad14e');
  // The inventory before the legacy routes were removed on 17 September 2026; every full-history scan still meets it. Decoded from
  // the pinned bytes rather than written here, so the working tree never carries a second copy for the context scan to meet.
  const pinned = candidate.split('# Exact public preload API inventory')[1].match(/regexes = \['''[^']*''', '''\\A\\n\?((?:\\x[0-9a-f]{2})+)\\z'''\]/)[1];
  const retiredLine = Buffer.from(pinned.match(/\\x([0-9a-f]{2})/g).map(byte => parseInt(byte.slice(2), 16))).toString();
  expect(createHash('sha256').update(retiredLine).digest('hex')).toBe('34f77d763883e912c8f55ad22b3601b5443fa83292859fd6aa6ff2c52dda3282');
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
    for (const line of [publicLine, retiredLine]) for (const padding of ['', '// context\n'.repeat(22)]) {
      expect(scan(baseline, exactPath, padding + line + '\n').rules).toContain(rule);
      expect(scan(candidate, exactPath, padding + line + '\n').findings).toBe(0);
    }
    for (const contents of [
      publicLine.replace('localWorkspace', fabricated) + '\n',
      publicLine + ' // changed\n',
      publicLine + '\r\n',
      publicLine + `\nlinkedin_client_id="${fabricated}"\n`,
      `linkedin_client_id="${fabricated}"\n` + publicLine + '\n',
      publicLine + `; linkedin_client_id="${fabricated}"\n`,
      retiredLine.replace('localWorkspace', fabricated) + '\n',
      retiredLine + ' // changed\n',
    ]) expect(scan(candidate, exactPath, contents).rules).toContain(rule);
    for (const file of ['other.ts', `nested/${exactPath}`, exactPath + '.bak']) {
      expect(scan(candidate, file, publicLine + '\n').rules).toContain(rule);
      expect(scan(candidate, file, retiredLine + '\n').rules).toContain(rule);
    }
    const otherRule = '\n[[rules]]\nid="synthetic-preload-control"\ndescription="Independent public-name control"\nregex="localWorkspace"\n';
    expect(scan(candidate + otherRule, exactPath, publicLine + '\n').rules).toContain('synthetic-preload-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
