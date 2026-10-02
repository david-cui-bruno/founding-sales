#!/usr/bin/env node
// Review the decrypted trial calls with Claude Sonnet 4.6 on Amazon Bedrock (slice S3T-E), on
// David's Mac, with his `default` AWS profile, in us-east-1, on AWS credits.
//
//   node tools/trial-review/review.mjs <folder> [--cap-usd 3] [--keep]
//
// Reads <folder>/trial-calls.json; one InvokeModel per call; stops before the bounded total could
// pass the cap; stops on any error, with no retry and no other provider. Writes
// <folder>/verdicts.json (0600) and prints a table of ids, kinds, verdicts, categories and reasons
// only, after checking that no run of any transcript appears in them.
//
// Cleanup runs on EVERY exit unless --keep: success, any failure (argument errors included), an
// uncaught error, and SIGINT/SIGTERM/SIGHUP (then exit 130). A failure prints only a fixed code
// (lib.mjs ERROR_CODES), never an error's message.

import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_DEFAULT_CAP_USD, REVIEW_MODEL, ToolError, callsOf, codeOf, quotedRunCount, reviewCalls, transcriptRuns, verdictTable } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// Known before anything can fail, so every exit can clean up: the folder is the first word that
// is not a flag or a flag's value, and --keep is its own word.
const keep = argv.includes('--keep');
const folder = argv.find((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--cap-usd') ?? null;

let cleaned = false;
/** cleanup.sh on the folder, once, unless --keep. True when nothing is left to remove. */
function cleanup() {
  if (cleaned || keep || folder === null) return true;
  cleaned = true;
  const result = spawnSync('bash', [join(here, 'cleanup.sh'), folder], { stdio: ['ignore', 'inherit', 'inherit'] });
  return result.status === 0;
}

function exitWith(code, exitCode) {
  if (code !== null) process.stderr.write(`review stopped: ${code}\n`);
  if (!cleanup()) {
    process.stderr.write('review stopped: E_CLEANUP\n');
    if (exitCode === 0) exitCode = 5;
  }
  process.exit(exitCode);
}

process.on('uncaughtException', () => exitWith('E_INTERNAL', 1));
process.on('unhandledRejection', () => exitWith('E_INTERNAL', 1));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => exitWith('E_INTERRUPTED', 130));

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
    try {
      return JSON.parse(new TextDecoder().decode(answer.body));
    } catch {
      throw new ToolError('E_RESPONSE');
    }
  };
}

function parseArgs() {
  let capUsd = REVIEW_DEFAULT_CAP_USD;
  let seenFolder = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') continue;
    if (arg === '--cap-usd') {
      capUsd = Number(argv[index + 1]);
      index += 1;
      if (!(capUsd > 0) || capUsd > 50) throw new ToolError('E_ARGS');
    } else if (!seenFolder && !arg.startsWith('--')) seenFolder = true;
    else throw new ToolError('E_ARGS');
  }
  if (folder === null) throw new ToolError('E_ARGS');
  return { capUsd };
}

async function run() {
  const { capUsd } = parseArgs();
  const verdictFile = join(folder, 'verdicts.json');
  let calls;
  try {
    calls = callsOf(JSON.parse(readFileSync(join(folder, 'trial-calls.json'), 'utf8')));
  } catch {
    throw new ToolError('E_INPUT_PARSE');
  }
  process.stdout.write(`${String(calls.length)} call(s); ${REVIEW_MODEL.inferenceProfileId} in ${REVIEW_MODEL.region}, profile ${REVIEW_MODEL.profile}; cap $${capUsd.toFixed(2)}\n`);
  let invoke;
  try {
    invoke = await bedrockInvoke();
  } catch {
    throw new ToolError('E_BEDROCK');
  }
  const result = await reviewCalls({ calls, invoke, capUsd, log: line => process.stdout.write(`${line}\n`) });

  const output = JSON.stringify(
    { model: REVIEW_MODEL.inferenceProfileId, reviewed: result.reviewed, of: calls.length, stoppedAtCap: result.stoppedAtCap, estimatedUsd: Number(result.spentUsd.toFixed(4)), verdicts: result.verdicts },
    null,
    2,
  );
  const table = verdictTable(result.verdicts);
  // The final check, before anything is written or printed: no run of any transcript.
  const runs = transcriptRuns(calls);
  if (quotedRunCount(output, runs) + quotedRunCount(table, runs) > 0) {
    rmSync(verdictFile, { force: true });
    throw new ToolError('E_QUOTE');
  }
  rmSync(verdictFile, { force: true });
  writeFileSync(verdictFile, `${output}\n`, { mode: 0o600 });
  chmodSync(verdictFile, 0o600);
  process.stdout.write(`${table}\n`);
  process.stdout.write(`reviewed ${String(result.reviewed)} of ${String(calls.length)}; estimated $${result.spentUsd.toFixed(4)}; verdicts in ${verdictFile}\n`);
  // Stopped at the cap: what was reviewed is written, and the exit code says it is not all.
  return result.stoppedAtCap ? 4 : 0;
}

let exitCode;
let code = null;
try {
  exitCode = await run();
} catch (error) {
  code = codeOf(error);
  exitCode = code === 'E_ARGS' ? 2 : code === 'E_QUOTE' || code === 'E_OUTPUT_CHARS' ? 3 : 1;
} finally {
  exitWith(code, exitCode ?? 1);
}
