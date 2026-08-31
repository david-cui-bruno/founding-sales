'use strict';

const Database = require('better-sqlite3-multiple-ciphers');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const bindingPath = process.argv[2];
if (typeof bindingPath !== 'string' || bindingPath.length === 0) {
  throw new Error('Native binding path is required.');
}

const directory = mkdtempSync(join(tmpdir(), 'callie-native-probe-'));
let database;
try {
  database = new Database(join(directory, 'probe.sqlite3'), {
    nativeBinding: bindingPath,
  });
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${'2a'.repeat(32)}'"`);
  database.prepare('SELECT count(*) FROM sqlite_master').get();
  const version = database.prepare('SELECT sqlite3mc_version() AS version').get();
  if (typeof version?.version !== 'string' || version.version.length === 0) {
    throw new Error('Encrypted SQLite native probe returned no cipher version.');
  }
  process.stdout.write(JSON.stringify({
    modules: process.versions.modules,
    cipherVersion: version.version,
  }));
} finally {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
}
