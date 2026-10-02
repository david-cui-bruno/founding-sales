#!/usr/bin/env node
// Review the ten-call trial with Claude Sonnet 4.6 on Amazon Bedrock (slice S3T-E, TE design
// reset), on David's Mac, with his `default` AWS profile, in us-east-1, on AWS credits.
//
//   node tools/trial-review/review.mjs --export <trial-export.jsonl> --key <private.pem> [--cap-usd 3] [--out <dir>]
//
// ONE process: it asks for the key's passphrase (typed, never an argument), decrypts the export IN
// MEMORY, reviews each call with one InvokeModel request, and writes only:
//
//   * <out>/verdicts.json (0600): ids, kinds and enums only (lib.mjs OUTPUT_SCHEMA), which the
//     coordinator may read;
//   * <out>/reasons-for-david.txt (0600): the model's free-text notes, for David alone. Its path is
//     printed, never its content.
//
// No plaintext file ever exists. Once the arguments parse, the export file is removed on EVERY exit:
// success, any failure (a wrong passphrase included: re-exporting is one command), an uncaught
// error, and SIGINT/SIGTERM/SIGHUP (exit 130). A failure prints only a fixed code.
// <out> defaults to the export's folder.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  OUTPUT_SCHEMA,
  REVIEW_DEFAULT_CAP_USD,
  REVIEW_MODEL,
  ToolError,
  callsOf,
  codeOf,
  decryptExport,
  emittedQuoteCount,
  loadPrivateKey,
  assertPassphraseRequired,
  readExportParts,
  reviewCalls,
  schemaViolations,
  transcriptRuns,
  verdictTable,
} from './lib.mjs';

const USAGE = 'usage: review.mjs --export <trial-export.jsonl> --key <private.pem> [--cap-usd 3] [--out <dir>]';

function parseArgs(argv) {
  const options = { exportFile: null, keyFile: null, capUsd: REVIEW_DEFAULT_CAP_USD, out: null };
  const take = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ToolError('E_ARGS', `${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--export') options.exportFile = take(index, flag);
    else if (flag === '--key') options.keyFile = take(index, flag);
    else if (flag === '--out') options.out = take(index, flag);
    else if (flag === '--cap-usd') {
      options.capUsd = Number(take(index, flag));
      if (!(options.capUsd > 0) || options.capUsd > 50) throw new ToolError('E_ARGS', 'the cap is above $0 and at most $50');
    } else throw new ToolError('E_ARGS', 'unknown argument');
  }
  if (options.exportFile === null || options.keyFile === null) throw new ToolError('E_ARGS', 'both --export and --key are required');
  options.out ??= dirname(options.exportFile);
  return options;
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`review stopped: ${codeOf(error)}\n${USAGE}\n`);
  process.exit(2);
}
const { exportFile, keyFile, capUsd, out } = parsed;

let removed = false;
/** The export goes on every exit from here on. */
function removeExport() {
  if (removed) return;
  removed = true;
  try {
    rmSync(exportFile, { force: true });
    process.stderr.write(`removed the export ${exportFile}\n`);
  } catch {
    process.stderr.write('review stopped: E_CLEANUP (remove the export by hand)\n');
  }
}

function exitWith(code, exitCode) {
  if (code !== null) process.stderr.write(`review stopped: ${code}\n`);
  removeExport();
  process.exit(exitCode);
}

process.on('uncaughtException', () => exitWith('E_INTERNAL', 1));
process.on('unhandledRejection', () => exitWith('E_INTERNAL', 1));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => exitWith('E_INTERRUPTED', 130));

/** The passphrase: hidden on a terminal; one line from stdin otherwise. */
async function askPassphrase() {
  if (!process.stdin.isTTY) {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return '';
  }
  process.stderr.write('Passphrase for the private key: ');
  return await new Promise((resolve, reject) => {
    let typed = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const stop = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          stop();
          return resolve(typed);
        }
        if (character === '\u0003') {
          stop();
          return reject(new ToolError('E_INTERRUPTED'));
        }
        if (character === '\u007f' || character === '\b') typed = typed.slice(0, -1);
        else typed += character;
      }
      return undefined;
    };
    process.stdin.on('data', onData);
  });
}

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

const writePrivate = (file, text) => {
  rmSync(file, { force: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
};

async function run() {
  let text;
  let pem;
  try {
    text = readFileSync(exportFile, 'utf8');
    pem = readFileSync(keyFile, 'utf8');
  } catch {
    throw new ToolError('E_INPUT_PARSE');
  }
  // Before the prompt: a key no passphrase protects is refused (R4).
  assertPassphraseRequired(pem);
  const parts = readExportParts(text);
  const privateKey = loadPrivateKey(pem, await askPassphrase());
  // In memory only (R1).
  const calls = callsOf(decryptExport(parts, privateKey));
  process.stdout.write(`${String(calls.length)} call(s); ${REVIEW_MODEL.inferenceProfileId} in ${REVIEW_MODEL.region}, profile ${REVIEW_MODEL.profile}; cap $${capUsd.toFixed(2)}\n`);
  let invoke;
  try {
    invoke = await bedrockInvoke();
  } catch {
    throw new ToolError('E_BEDROCK');
  }
  const result = await reviewCalls({ calls, invoke, capUsd, log: line => process.stdout.write(`${line}\n`) });

  const output = { model: REVIEW_MODEL.inferenceProfileId, reviewed: result.reviewed, of: calls.length, stoppedAtCap: result.stoppedAtCap, estimatedUsd: Number(result.spentUsd.toFixed(4)), verdicts: result.verdicts };
  if (schemaViolations(output, OUTPUT_SCHEMA).length > 0) throw new ToolError('E_SCHEMA');
  const table = verdictTable(result.verdicts);
  const verdictFile = join(out, 'verdicts.json');
  const reasonsFile = join(out, 'reasons-for-david.txt');
  const closing = `reviewed ${String(result.reviewed)} of ${String(calls.length)}; estimated $${result.spentUsd.toFixed(4)}; verdicts in ${verdictFile}; David's notes in ${reasonsFile} (not printed)`;
  // Defence in depth: no run of any transcript in everything the coordinator can see, as one text.
  if (emittedQuoteCount(transcriptRuns(calls), output, table, closing) > 0) throw new ToolError('E_QUOTE');
  try {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writePrivate(verdictFile, `${JSON.stringify(output, null, 2)}\n`);
    writePrivate(reasonsFile, result.notes.map(entry => `${entry.callSessionId} ${entry.key}: ${entry.note}`).join('\n') + (result.notes.length > 0 ? '\n' : ''));
  } catch {
    throw new ToolError('E_WRITE');
  }
  process.stdout.write(`${table}\n${closing}\n`);
  // Stopped at the cap: what was reviewed is written, and the exit code says it is not all.
  return result.stoppedAtCap ? 4 : 0;
}

let exitCode = 1;
let code = null;
try {
  exitCode = await run();
} catch (error) {
  code = codeOf(error);
  exitCode = code === 'E_QUOTE' ? 3 : 1;
} finally {
  exitWith(code, exitCode);
}
