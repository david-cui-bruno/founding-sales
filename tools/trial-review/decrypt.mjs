#!/usr/bin/env node
// Decrypt a trial export (slice S3T-E) on David's Mac.
//
//   node tools/trial-review/decrypt.mjs <folder>/trial-export.jsonl <private-key.pem>
//
// The private key must be passphrase-protected (an ENCRYPTED PEM). Asks for the passphrase (typed,
// never an argument), then writes <folder>/trial-calls.json with mode 0600 beside the export:
// to a temporary name first, renamed once complete. On any failure every plaintext it could have
// left (the temporary file, and a trial-calls.json from before) is removed, and only a fixed code
// is printed. The export file must be named trial-export*, so cleanup.sh can find and remove it.

import { randomBytes, createPrivateKey } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError, callsOf, codeOf, decryptExport, isProtectedPem, readExportParts } from './lib.mjs';

const [exportArg, keyArg] = process.argv.slice(2);
const folder = exportArg === undefined ? null : dirname(exportArg);
const target = folder === null ? null : join(folder, 'trial-calls.json');
const temporary = folder === null ? null : join(folder, `.trial-calls.${randomBytes(6).toString('hex')}.tmp`);

/** Remove every plaintext this run could have left. */
function removePlaintext() {
  for (const file of [temporary, target]) if (file !== null) rmSync(file, { force: true });
}

/** Fail with a code: the plaintext goes, and nothing about the error is printed but the code. */
function fail(code, exitCode = 1) {
  removePlaintext();
  process.stderr.write(`decrypt failed: ${code}\n`);
  process.exit(exitCode);
}

process.on('uncaughtException', () => fail('E_INTERNAL'));
process.on('unhandledRejection', () => fail('E_INTERNAL'));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => fail('E_INTERRUPTED', 130));

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
    const done = value => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return done(typed);
        if (character === '\u0003') {
          process.stdin.setRawMode(false);
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

async function main() {
  if (exportArg === undefined || keyArg === undefined || process.argv.length !== 4) throw new ToolError('E_ARGS');
  if (!basename(exportArg).startsWith('trial-export')) throw new ToolError('E_ARGS');
  let text;
  let pem;
  try {
    text = readFileSync(exportArg, 'utf8');
    pem = readFileSync(keyArg, 'utf8');
  } catch {
    throw new ToolError('E_INPUT_PARSE');
  }
  if (!isProtectedPem(pem)) throw new ToolError('E_KEY_UNPROTECTED');
  const parts = readExportParts(text);
  const passphrase = await askPassphrase();
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: pem, passphrase });
  } catch {
    throw new ToolError('E_KEY');
  }
  const exported = decryptExport(parts, privateKey);
  const calls = callsOf(exported);
  try {
    writeFileSync(temporary, JSON.stringify(exported), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch {
    throw new ToolError('E_WRITE');
  }
  process.stdout.write(`${JSON.stringify({ decrypted: calls.length, file: target })}\n`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  error => fail(codeOf(error), codeOf(error) === 'E_ARGS' ? 2 : 1),
);
