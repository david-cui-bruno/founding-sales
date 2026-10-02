#!/usr/bin/env node
// Review the decrypted trial calls with Claude Sonnet 4.6 on Amazon Bedrock (slice S3T-E), on
// David's Mac, with his `default` AWS profile, in us-east-1, on AWS credits.
//
//   node tools/trial-review/review.mjs <folder> [--cap-usd 3] [--keep]
//
// Reads <folder>/trial-calls.json; one InvokeModel per call; stops before the estimated total
// could pass the cap; stops on any error, with no retry and no other provider. Writes
// <folder>/verdicts.json and prints a table of ids, kinds, verdicts, categories and reasons only,
// after checking that no 8-word run of any transcript appears in them. Then runs cleanup.sh on the
// folder (the decrypted calls and the export are removed) unless --keep, success or failure.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_DEFAULT_CAP_USD, REVIEW_MODEL, callsOf, quotedRunCount, reviewCalls, transcriptRuns, verdictTable } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The real client: the only place Bedrock is reached. Overridable for the tests (FSS_TRIAL_REVIEW_STUB). */
async function bedrockInvoke() {
  const stub = process.env.FSS_TRIAL_REVIEW_STUB;
  if (stub !== undefined && stub !== '') return (await import(stub)).invoke;
  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  const client = new sdk.BedrockRuntimeClient({ region: REVIEW_MODEL.region, profile: REVIEW_MODEL.profile, maxAttempts: 1 });
  return async (modelId, body) => {
    const answer = await client.send(
      new sdk.InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: new TextEncoder().encode(body) }),
    );
    return JSON.parse(new TextDecoder().decode(answer.body));
  };
}

function parseArgs(argv) {
  const options = { folder: undefined, capUsd: REVIEW_DEFAULT_CAP_USD, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--cap-usd') {
      options.capUsd = Number(argv[index + 1]);
      index += 1;
      if (!(options.capUsd > 0) || options.capUsd > 50) throw new Error('--cap-usd is a number of dollars above 0 and at most 50');
    } else if (options.folder === undefined && !arg.startsWith('--')) options.folder = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.folder === undefined) throw new Error('usage: review.mjs <folder> [--cap-usd 3] [--keep]');
  return options;
}

function cleanup(folder) {
  const result = spawnSync('bash', [join(here, 'cleanup.sh'), folder], { stdio: 'inherit' });
  return result.status === 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const { folder, capUsd, keep } = options;
  const verdictFile = join(folder, 'verdicts.json');
  let code;
  try {
    code = await run(folder, capUsd, verdictFile);
  } catch (error) {
    // The message only. The library's errors name no transcript text, and a JSON parse error of
    // the model's answer is replaced before it gets here.
    process.stderr.write(`review stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    code = 1;
  }
  // Success or failure: the decrypted calls and the export go, unless --keep.
  if (!keep && !cleanup(folder)) {
    process.stderr.write('cleanup failed: remove trial-calls.json and the export by hand\n');
    if (code === 0) code = 5;
  }
  return code;
}

async function run(folder, capUsd, verdictFile) {
  const calls = callsOf(JSON.parse(readFileSync(join(folder, 'trial-calls.json'), 'utf8')));
  process.stdout.write(`${String(calls.length)} call(s); ${REVIEW_MODEL.inferenceProfileId} in ${REVIEW_MODEL.region}, profile ${REVIEW_MODEL.profile}; cap $${capUsd.toFixed(2)}\n`);
  const invoke = await bedrockInvoke();
  const result = await reviewCalls({ calls, invoke, capUsd, log: line => process.stdout.write(`${line}\n`) });

  const output = JSON.stringify(
    { model: REVIEW_MODEL.inferenceProfileId, reviewed: result.reviewed, of: calls.length, stoppedAtCap: result.stoppedAtCap, estimatedUsd: Number(result.spentUsd.toFixed(4)), verdicts: result.verdicts },
    null,
    2,
  );
  const table = verdictTable(result.verdicts);
  // The final check, before anything is written or printed: no 8-word run of any transcript.
  const runs = transcriptRuns(calls);
  const quoted = quotedRunCount(output, runs) + quotedRunCount(table, runs);
  if (quoted > 0) {
    rmSync(verdictFile, { force: true });
    process.stderr.write(`FAIL: the review output repeats transcript wording (${String(quoted)} run(s) of 8 words). Nothing was written or printed.\n`);
    return 3;
  }
  writeFileSync(verdictFile, `${output}\n`, { mode: 0o600 });
  process.stdout.write(`${table}\n`);
  process.stdout.write(`reviewed ${String(result.reviewed)} of ${String(calls.length)}; estimated $${result.spentUsd.toFixed(4)}; verdicts in ${verdictFile}\n`);
  // Stopped at the cap: what was reviewed is written, and the exit code says it is not all.
  return result.stoppedAtCap ? 4 : 0;
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
});
