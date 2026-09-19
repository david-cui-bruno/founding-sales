import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanWithGitleaks } from '../scripts/verifySecrets.mjs';

it('excepts only the exact retired public preload inventory lines, file and LinkedIn client-ID rule; the current line trips nothing', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-preload-inventory-'));
  const exactPath = 'tests/integration/appleSpikePreload.test.ts';
  const candidate = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  const baseline = candidate.split('# Exact public preload API inventory')[0];
  const publicLine = readFileSync(new URL(`../${exactPath}`, import.meta.url), 'utf8').split('\n').find(line => line.includes("'localWorkspace'"));
  expect(createHash('sha256').update(publicLine).digest('hex')).toBe('97ff278ccc1b8bdf16e574b0476424466016fbb79c35f1f41555562ca78abc7e');
  // The inventories before the legacy routes were removed on 17 September 2026 and before the LinkedIn namespace was removed on
  // 18 September 2026; every full-history scan still meets both. Decoded from the pinned bytes rather than written here, so the
  // working tree never carries a second copy for the context scan to meet.
  const retiredLines = [...candidate.split('# Exact public preload API inventory')[1].matchAll(/'''\\A\\n\?((?:\\x[0-9a-f]{2})+)\\z'''/g)]
    .map(match => Buffer.from(match[1].match(/\\x([0-9a-f]{2})/g).map(byte => parseInt(byte.slice(2), 16))).toString());
  expect(retiredLines.map(line => createHash('sha256').update(line).digest('hex'))).toEqual(['88edd0efeb23ba4bff5c576c4deacc405d2e5452933eeb40d33467502e8ad14e', '34f77d763883e912c8f55ad22b3601b5443fa83292859fd6aa6ff2c52dda3282']);
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
    // The current line carries no LinkedIn keyword, so the detector is silent on it with or without the exception.
    for (const config of [baseline, candidate]) for (const padding of ['', '// context\n'.repeat(22)]) expect(scan(config, exactPath, padding + publicLine + '\n').findings).toBe(0);
    for (const line of retiredLines) for (const padding of ['', '// context\n'.repeat(22)]) {
      expect(scan(baseline, exactPath, padding + line + '\n').rules).toContain(rule);
      expect(scan(candidate, exactPath, padding + line + '\n').findings).toBe(0);
    }
    for (const contents of [
      ...retiredLines.flatMap(line => [line.replace('localWorkspace', fabricated) + '\n', line + ' // changed\n', line + '\r\n']),
      retiredLines[0] + `\nlinkedin_client_id="${fabricated}"\n`,
      `linkedin_client_id="${fabricated}"\n` + retiredLines[0] + '\n',
      retiredLines[0] + `; linkedin_client_id="${fabricated}"\n`,
      publicLine + `\nlinkedin_client_id="${fabricated}"\n`,
    ]) expect(scan(candidate, exactPath, contents).rules).toContain(rule);
    for (const file of ['other.ts', `nested/${exactPath}`, exactPath + '.bak']) for (const line of retiredLines) expect(scan(candidate, file, line + '\n').rules).toContain(rule);
    const otherRule = '\n[[rules]]\nid="synthetic-preload-control"\ndescription="Independent public-name control"\nregex="localWorkspace"\n';
    expect(scan(candidate + otherRule, exactPath, retiredLines[0] + '\n').rules).toContain('synthetic-preload-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
