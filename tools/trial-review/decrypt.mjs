#!/usr/bin/env node
// Decrypt a trial export (slice S3T-E) on David's Mac.
//
//   node tools/trial-review/decrypt.mjs <folder>/trial-export.jsonl <private-key.pem>
//
// Asks for the private key's passphrase (typed, never an argument), then writes
// <folder>/trial-calls.json with mode 0600 beside the export. Prints only how many calls it wrote.
// The export file must be named trial-export*, so cleanup.sh can find and remove it.

import { createPrivateKey } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { callsOf, decryptExport, readExportParts } from './lib.mjs';

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
          return reject(new Error('cancelled'));
        }
        if (character === '\u007f' || character === '\b') typed = typed.slice(0, -1);
        else typed += character;
      }
      return undefined;
    };
    process.stdin.on('data', onData);
  });
}

async function main(argv) {
  const [exportFile, keyFile, ...rest] = argv;
  if (exportFile === undefined || keyFile === undefined || rest.length > 0) {
    process.stderr.write('usage: decrypt.mjs <folder>/trial-export*.jsonl <private-key.pem>\n');
    return 2;
  }
  if (!basename(exportFile).startsWith('trial-export')) {
    process.stderr.write('the export file must be named trial-export* (cleanup.sh removes it by that name)\n');
    return 2;
  }
  const parts = readExportParts(readFileSync(exportFile, 'utf8'));
  const passphrase = await askPassphrase();
  const privateKey = createPrivateKey({ key: readFileSync(keyFile, 'utf8'), passphrase });
  const exported = decryptExport(parts, privateKey);
  const calls = callsOf(exported);
  const out = join(dirname(exportFile), 'trial-calls.json');
  writeFileSync(out, JSON.stringify(exported), { mode: 0o600 });
  chmodSync(out, 0o600);
  process.stdout.write(`${JSON.stringify({ decrypted: calls.length, file: out })}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    // The message only: never the plaintext, which is in no error this file raises.
    process.stderr.write(`decrypt failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
