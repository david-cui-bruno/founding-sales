const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const applyProfile = (database, keyHex) => {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${keyHex}'"`);
};

const removeProbeFiles = (path) => {
  rmSync(path, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-wal`, { force: true });
};

const probePassed = (report) =>
  report !== null &&
  typeof report === 'object' &&
  report.packageVersion === '12.11.1' &&
  report.electronVersion === '44.0.0' &&
  report.platform === 'darwin' &&
  report.architecture === 'arm64' &&
  report.cipher === 'sqlcipher' &&
  report.legacy === '4' &&
  report.synchronousRow?.value === 'encrypted' &&
  report.reopenedRow?.value === 'encrypted' &&
  report.journalMode === 'wal' &&
  report.ftsRow?.content === 'searchable encrypted content' &&
  report.integrity === 'ok' &&
  report.encryptedHeader === true &&
  report.wrongKeyRejected === true;

const runProbe = () => {
  const { app } = require('electron');
  const Database = require('better-sqlite3-multiple-ciphers');
  const { version: packageVersion } = require('better-sqlite3-multiple-ciphers/package.json');
  const { Kysely, SqliteDialect, sql } = require('kysely');

  let path;
  app.whenReady().then(async () => {
    path = join(
      app.getPath('temp'),
      `callie-cipher-probe-${process.pid}.sqlite3`,
    );
    const key = Buffer.alloc(32, 0x4a).toString('hex');
    const wrongKey = Buffer.alloc(32, 0x7b).toString('hex');
    removeProbeFiles(path);

    const database = new Database(path);
    applyProfile(database, key);
    const cipher = database.pragma('cipher', { simple: true });
    const legacy = database.pragma('legacy', { simple: true });
    const journalMode = database.pragma('journal_mode=WAL', { simple: true });
    database.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(content)');
    database
      .prepare('INSERT INTO probe_fts (content) VALUES (?)')
      .run('searchable encrypted content');

    const kysely = new Kysely({
      dialect: new SqliteDialect({ database }),
    });
    await sql`INSERT INTO probe (id, value) VALUES ('one', 'encrypted')`.execute(
      kysely,
    );
    const synchronousResult = await sql`SELECT value FROM probe WHERE id = 'one'`.execute(
      kysely,
    );
    const ftsResult = database
      .prepare("SELECT content FROM probe_fts WHERE probe_fts MATCH 'searchable'")
      .get();
    const integrity = database.pragma('integrity_check', { simple: true });
    await kysely.destroy();

    const header = readFileSync(path).subarray(0, 16).toString('utf8');

    const reopened = new Database(path, { readonly: true });
    applyProfile(reopened, key);
    const reopenedKysely = new Kysely({
      dialect: new SqliteDialect({ database: reopened }),
    });
    const reopenedResult = await sql`SELECT value FROM probe WHERE id = 'one'`.execute(
      reopenedKysely,
    );
    await reopenedKysely.destroy();

    let wrongKeyRejected = false;
    const wrong = new Database(path, { readonly: true });
    try {
      applyProfile(wrong, wrongKey);
      wrong.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch {
      wrongKeyRejected = true;
    } finally {
      wrong.close();
    }

    const report = {
      packageVersion,
      electronVersion: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
      cipher,
      legacy,
      synchronousRow: synchronousResult.rows[0],
      reopenedRow: reopenedResult.rows[0],
      journalMode,
      ftsRow: ftsResult,
      integrity,
      encryptedHeader: header !== 'SQLite format 3\u0000',
      wrongKeyRejected,
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);
    removeProbeFiles(path);
    app.exit(probePassed(report) ? 0 : 1);
  }).catch((error) => {
    if (path !== undefined) {
      removeProbeFiles(path);
    }
    process.stderr.write(`${error.stack ?? error.message}\n`);
    app.exit(1);
  });
};

module.exports = { probePassed };

if (process.versions.electron !== undefined) {
  runProbe();
}
