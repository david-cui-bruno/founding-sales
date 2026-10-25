import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAssets } from '../../src/server/hostContract.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
import { startReplyBriefApp, type ReplyBriefApp } from './replyBriefApp.ts';
import { scriptedReply, syntheticBrowserCase } from './syntheticBrowserCase.ts';
import { snapshotExitListeners, removeExitListenersAddedSince } from '@fss/domain/db/testing/embeddedPostgres.ts';
import { createOwnedTeardown } from '@fss/domain/db/testing/globalSetup.ts';

export const demoLabel = 'SYNTHETIC · fictional case A · NO SEND · scripted, not live model inference';
export function requireLocalDemo(env: NodeJS.ProcessEnv): void {
  if (env['FSS_SYNTHETIC_LOCAL_DEMO'] !== '1') throw Error('Explicit FSS_SYNTHETIC_LOCAL_DEMO=1 required');
  if (['FSS_TEST_POSTGRES_URL', 'FSS_TEST_CLUSTER_URL', 'FSS_TEST_TEMPLATE_DATABASE'].some(key => env[key] !== undefined)) throw Error('Inherited PostgreSQL configuration refused');
  if (Object.keys(env).some(key => /^(?:DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|AWS_|GOOGLE_|VERTEX_|FSS_BROWSER_|FSS_PRODUCTION_)/u.test(key) && env[key])) throw Error('Production/provider configuration refused. Use a clean local environment.');
}

/** CLI-only import boundary. Reclaim only listeners introduced by this dependency
 * before any initialization/resource awaits. Ordinary fixture callers do not use it. */
export async function prepareSyntheticCliDependency(): Promise<void> {
  requireLocalDemo(process.env);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const known = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  const exits = snapshotExitListeners();
  try { await import('embedded-postgres'); }
  finally {
    removeExitListenersAddedSince(exits);
    for (const signal of signals) for (const listener of process.listeners(signal)) {
      if (!known.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
  }
}

export function syntheticAssets(assets: BrowserAssets): BrowserAssets {
  const decorated = new Map(assets);
  const html = assets.get('/'), css = assets.get('/styles.css');
  if (!html || !css) throw Error('Current product assets required');
  const document = new TextDecoder().decode(html.body);
  if (document.split('<div id="root">').length !== 2) throw Error('Current product root required for synthetic labeling');
  const banner = `<aside id="synthetic-demo-label" aria-label="Synthetic demo notice"><strong>${demoLabel}</strong><details><summary>Local demo instructions and limits</summary><p>All people, messages, source facts and the meeting are invented. No actual booking, model call, mailbox capture or contact. Reply suggestions are a fixed fixture script. Edit and preview in Replies, nothing is sent.</p><p>Next: Refresh replies, select Fablewick, refresh context, generate once, adopt, edit and preview. Then Open firm → Load existing meetings → Open preparation. Notes: copy the displayed fictional meeting ID into Meeting ID, Read meeting notes, write private rehearsal notes and Save. Reload and Read again to reopen. Notes persist only for this disposable demo lifetime.</p><p>The agreed time and recap promise exist only inside this fictional conversation. No calendar event, task assignment, reminder, promise fulfillment or sending is supplied by this demo. Reply drafts themselves are memory-only and lost on reload.</p></details></aside>`;
  decorated.set('/', { ...html, body: new TextEncoder().encode(document.replace('<div id="root">', `${banner}<div id="root">`)) });
  decorated.set('/styles.css', { ...css, body: new TextEncoder().encode(`${new TextDecoder().decode(css.body)}\n#synthetic-demo-label{position:sticky;top:0;z-index:999;background:#fff4c2;color:#241800;border:3px solid #805600;padding:10px;font:15px/1.4 system-ui}#synthetic-demo-label p{margin:4px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}`) });
  return decorated;
}

export async function startSyntheticBrowser() {
  requireLocalDemo(process.env);
  const release = await reserveLocalBrowserDatabase();
  let app: ReplyBriefApp | undefined;
  try {
    app = await startReplyBriefApp({ conversation: syntheticBrowserCase, decorateAssets: syntheticAssets, requestDatabaseRole: 'app_runtime' });
    app.setAnswer(scriptedReply);
    // Replace the generic fixture's brief material with literal case A observations.
    const firstInbound = syntheticBrowserCase.messages[0]!;
    await app.fixture.db.query('UPDATE firm_prepared_briefs SET brief=$2,prepared_by=$3,observed_on=$4 WHERE firm_id=$1', [app.firmId, 'SYNTHETIC case A: 84 rental doors. Fictional screen walkthrough agreed for 2026-10-26 14:00-14:20 America/New_York, Mara attends alone. Focus on request ownership when vendors have not replied. SYN-A-04 promises a one-page recap by 2026-10-27 12:00 America/New_York. Fulfillment unobserved. No actual booking, task or send.', 'Scripted synthetic fixture, not live model inference', '2026-10-23']);
    await app.fixture.db.query('UPDATE firm_facts SET quote=$2,retrieved_at=$3 WHERE firm_id=$1', [app.firmId, firstInbound.body, firstInbound.sentAt]);
    await app.fixture.db.query('UPDATE evidence_items SET source_reference=$2 WHERE firm_id=$1', [app.firmId, 'https://fictional.example.test/SYN-A-01']);
    await app.fixture.db.query('UPDATE meetings SET attendee_name=$2,event_title=$3,booking_notes=$4,starts_at=$5,ends_at=$6 WHERE id=$1', [app.meetingId, 'Mara Fenwick (invented)', 'SYNTHETIC screen walkthrough, not a real booking', 'Fictional source agreement only. No calendar invitation or actual booking operation.', '2026-10-26T14:00:00-04:00', '2026-10-26T14:20:00-04:00']);
    const owned = app;
    return { app: owned, stop: createOwnedTeardown([
      () => owned.stop(),
      release,
      async () => {
        await access(owned.storagePath).then(() => { throw Error('Owned PG directory remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        assert.throws(() => process.kill(owned.postgresPid, 0), { code: 'ESRCH' });
        console.log('SYNTHETIC_BROWSER_CLUSTER_PID_DIRECTORY_ABSENT');
      },
    ]) };
  } catch (error) {
    try { await createOwnedTeardown([async () => { await app?.stop(); }, release])(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Synthetic startup and teardown failed'); }
    throw error;
  }
}

/** Only local navigation is controlled. Product assets, APIs and session are real. */
export async function containSyntheticBrowser(context: BrowserContext, app: ReplyBriefApp): Promise<void> {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    if (response.status() !== 200 || !body.authorizationUrl) return await route.fulfill({ response });
    const authorization = new URL(body.authorizationUrl);
    assert.equal(authorization.origin, app.fixture.google.issuer);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
}
export async function signInSyntheticBrowser(page: Page, app: ReplyBriefApp): Promise<void> {
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
}
export async function assertSyntheticNoSend(app: ReplyBriefApp): Promise<void> {
  for (const table of ['outbound_messages', 'human_reply_send_intents', 'outbound_message_events']) {
    assert.equal((await app.fixture.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]?.count, '0', table);
  }
  assert.equal((await app.fixture.db.query("SELECT 1 FROM jobs WHERE kind='reply.human_send'")).rowCount, 0);
  // These two outgoing originals are copied fictional history, not transport writes.
  assert.equal((await app.fixture.db.query("SELECT 1 FROM mail_messages WHERE direction='outgoing'")).rowCount, 2);
}
