import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  createTestDatabase,
  type TestDatabase,
} from '@fss/domain/db/testing/testDatabase.ts';
import { MIGRATION_IDENTITY_COMMANDS, main } from '../src/tools/fss.ts';
import { parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * `fss admin schema-preflight 0020` on a real schema-19 database (lane W3-F).
 *
 * The coordinator runs this through `infra/scripts/preflight.sh <root> <prefix> 0020`
 * before the release stops anything. 0020 destroys nothing, so the report is about what
 * the *release* changes: the settings rows by key, the unsent fences whose footer the
 * claim lock will recompose, the templates whose legacy block composition will dedupe,
 * and the only thing it refuses on — a body that would pass 4,000 characters composed.
 *
 * ## The vacuous-pass traps, named
 *
 * **A count over an empty database.** The fixture stores a settings row, two unsent
 * fences (one already composed, one not), a legacy template, a footerless one, and one
 * long enough to refuse; every number below is non-zero because something is there.
 *
 * **A refusal that never fires.** The oversize template makes `refuses` true and names
 * the id; removing it makes the same command answer false, so the refusal is the row.
 */

let database: TestDatabase;
let workspaceId = '';
let userId = '';
let oversizeTemplateId = '';
let staleFenceId = '';

const SIGN_OFF = 'Sam Example';
const LEGACY = `Hello.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`;

async function databaseUrl(): Promise<string> {
  const { rows } = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  url.pathname = `/${rows[0]?.name ?? ''}`;
  return url.toString();
}

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const url = await databaseUrl();
  const printed: string[] = [];
  const logged: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    logged.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv, { DATABASE_URL: url, FSS_MIGRATION_DATABASE_URL: url });
    return { code, stdout: printed.join(''), stderr: logged.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function one(sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  return rows[0]?.id ?? '';
}

/** A template version with a body of the caller's choosing. */
async function template(name: string, body: string): Promise<string> {
  return await one(
    `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                    footer_sign_off, approved_at, approved_by_user_id)
     VALUES ($1, gen_random_uuid(), 1, $2, 'A short note', $3, md5($3) || md5($2), $4, now(), $5)
     RETURNING id`,
    [workspaceId, name, body, SIGN_OFF, userId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase({ throughVersion: 19 });
  workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('preflight20', 'Preflight') RETURNING id", []);
  userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('preflight20-sub', 'preflight20@example.test', 'Preflight') RETURNING id",
    [],
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);
  await database.session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'business_time_zone', 1, '{"timeZone": "America/New_York"}'::jsonb, 'set', $2)`,
    [workspaceId, userId],
  );

  const legacyTemplate = await template('Legacy shape', LEGACY);
  await template('Footerless shape', 'Hello, with no footer at all.');
  // Exactly 4,000 characters stored — the longest the table admits — and longer than
  // that once the footer is composed, which is the one thing 0020 refuses on.
  oversizeTemplateId = await template(
    'Too long once composed',
    `${'x'.repeat(4000 - 1 - SENDING_STOP_LINE.length)}\n${SENDING_STOP_LINE}`,
  );

  // Two unsent fences: one carrying exactly what the new code composes, one carrying a
  // footer from before the address existed.
  const mailboxId = await one(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status)
     VALUES ($1, $2, 'sender@example.test', 'connected') RETURNING id`,
    [workspaceId, userId],
  );
  const firmId = await one(
    'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'Preflight Firm', userId],
  );
  const fence = async (body: string, state: 'prepared' | 'held'): Promise<string> =>
    await one(
      `INSERT INTO outbound_messages
         (workspace_id, mailbox_id, origin_kind, draft_id, firm_id, recipient_address, subject, body,
          template_version_id, rendered_hash, provider_message_id_header, send_at, source_zone,
          placement_rule_version, state, held_at, held_reason)
       VALUES ($1, $2, 'draft', gen_random_uuid(), $3, 'prospect@example.test', 'A short note', $4, $5,
               repeat('a', 64), '<fss.' || gen_random_uuid() || '@example.test>', now(), 'UTC', 'email-window.1', $6,
               CASE WHEN $6 = 'held' THEN now() END, CASE WHEN $6 = 'held' THEN 'daily_cap' END)
       RETURNING id`,
      [workspaceId, mailboxId, firmId, body, legacyTemplate, state],
    );
  staleFenceId = await fence(`Hello.\n\nAn older footer\n${SENDING_STOP_LINE}`, 'prepared');
  await fence(LEGACY, 'held');
});

afterAll(async () => {
  await database.drop();
});

describe('fss and migration 0020', () => {
  it('parses the preflight, which runs on the runtime identity', () => {
    expect(parseFssCommand(['admin', 'schema-preflight', '0020', '--report', '/tmp/x.json'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'schema-preflight', '0021'])).toMatchObject({ ok: false, reason: 'command_unknown' });
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin schema-preflight 0020');
  });

  it('counts the settings, the fences and the templates on schema 19, and refuses on the long body', async () => {
    const { code, stdout } = await run(['admin', 'schema-preflight', '0020']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      applicable: true,
      schemaVersion: 19,
      migration: 20,
      refuses: true,
      counts: {
        blocking: { oversizeFences: 0, oversizeTemplates: 1 },
        settings: [{ settingKey: 'business_time_zone', versions: 1, current: 1 }],
        fences: { prepared: 1, held: 1, alreadyComposed: 1, recomposed: 1, withoutTemplateVersion: 0 },
        templates: { versions: 3, approved: 3, legacyFooterBlock: 1, footerless: 1, stopLineElsewhere: 0 },
        postalAddress: { configured: false },
        oversize: { fenceIds: [], templateVersionIds: [oversizeTemplateId] },
      },
    });
    // The fence whose footer is stale is the one that would be recomposed; the read
    // writes nothing, whatever it found.
    const { rows } = await database.session.query<{ body: string }>(
      'SELECT body FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId, staleFenceId],
    );
    expect(rows[0]?.body).toBe(`Hello.\n\nAn older footer\n${SENDING_STOP_LINE}`);
  });

  it('stops refusing once the long body is shortened, and answers only on schema 19', async () => {
    await database.session.query('UPDATE template_versions SET body = $2 WHERE id = $1', [oversizeTemplateId, LEGACY]);
    const after = JSON.parse((await run(['admin', 'schema-preflight', '0020'])).stdout) as Record<string, unknown>;
    expect(after['refuses']).toBe(false);

    const { code } = await run(['migrate']);
    expect(code).toBe(0);
    expect(CURRENT_SCHEMA_VERSION).toBe(20);
    const applied = await run(['admin', 'schema-preflight', '0020']);
    expect(applied.code).toBe(20);
    expect(applied.stderr).toContain('schema_not_19');
  });
});
