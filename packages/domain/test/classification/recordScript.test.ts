import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODELS } from '@fss/contracts';

/**
 * `scripts/recordReplyCorpus.mjs` spends money, so CI never records with it, and nothing
 * imports it: a module it loads could move and no other check would notice. Its dry run
 * loads everything a recording loads, prints the first request and sends nothing, so it
 * is what runs here. The child gets no classifier key.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/recordReplyCorpus.mjs', import.meta.url));

describe('the reply corpus recorder', () => {
  it('loads and prints the first request on a dry run, sending nothing', () => {
    const environment = { ...process.env };
    delete environment['FSS_LLM_CLASSIFIER_API_KEY'];
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', SCRIPT, '--model', CLASSIFIER_MODELS[0], '--dry-run'],
      { env: environment, encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.stderr).toContain('cases would be sent. Nothing was.');
    expect(result.status).toBe(0);
  });
});
