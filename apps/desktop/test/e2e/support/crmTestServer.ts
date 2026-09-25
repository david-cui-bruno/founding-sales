import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CrmState, ImportView, PipelineView } from '../../../src/renderer/firmWorkspaceContract.ts';

/**
 * The generated test server the CRM window specs run against.
 *
 * The same substitution G2 made for the Today window: the renderer under test is
 * the shipped file, transpiled with esbuild and served unmodified, and the only
 * thing replaced is the bridge — `window.callieCrm`, which in Electron comes from
 * the preload script and here comes from a small generated script that posts back
 * to this server.
 *
 * The bridge is scripted rather than backed by the API. What these specs are for is
 * what a person sees and can press, and driving them from a real database would
 * make them slow, flaky and about something else. The API's own behaviour — the read
 * matrix, the Lost reason, the merge conflicts — is proved against a real PostgreSQL
 * in `@fss/domain` and `@fss/api`.
 *
 * **Two roles, always.** Every fixture below exists twice: the assignee, who is
 * given the firm in detail, and the colleague, who is given identity only. A spec
 * that only ever ran as the assignee would pass with the redaction removed.
 *
 * No real name, address or number appears here. `example.test` is reserved by
 * RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export const FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_FIRM_ID = '44444444-4444-4444-8444-444444444444';
export const ASSIGNEE_ID = '22222222-2222-4222-8222-222222222222';
export const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';

export interface CrmTestServer {
  readonly url: string;
  /** Replace the state the bridge answers with, for the next page load or call. */
  setState(state: CrmState): void;
  /** Bridge method names in call order, and the arguments they were given. */
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  stop(): Promise<void>;
}

const IDENTITY = {
  id: FIRM_ID,
  name: 'Northwind Test Holdings',
  website: 'https://northwind.example.test',
  locality: 'Providence',
  regionCode: 'RI',
  status: 'active' as const,
  assignedUserId: ASSIGNEE_ID,
  stageKey: 'contacting',
  opportunityStatus: 'open' as const,
  controlMode: 'automated' as const,
  openedAt: '2026-09-01T12:00:00.000Z',
  timeZone: 'America/New_York',
  timeZoneUnresolvedReason: null,
};

/** A firm with no open opportunity, which the board holds in no column (lane g84). */
export function unplacedIdentity(id: string, name: string): NonNullable<PipelineView['unplacedFirms']>[number] {
  return { ...IDENTITY, id, name, stageKey: null, opportunityStatus: null, controlMode: null, openedAt: null };
}

/** The Firm page as the assigned salesperson is given it (Appendix F row 2). */
export function assigneeFirmPage(): NonNullable<CrmState['firm']> {
  return {
    visibility: 'assigned_or_admin',
    read: {
      visibility: 'assigned_or_admin',
      firm: {
        ...IDENTITY,
        addressLine: '9 Sample Street',
        postalCode: '02903',
        countryCode: 'US',
        timeZoneConfidence: 'medium',
        timeZoneSource: 'state_default',
        contacts: [
          { id: '66666666-6666-4666-8666-666666666666', fullName: 'Dana Example', title: 'Operations Lead', status: 'active', isPrimary: true },
          { id: '77777777-7777-4777-8777-777777777777', fullName: 'Robin Placeholder', title: null, status: 'active', isPrimary: false },
        ],
        phoneRoutes: [
          { id: '88888888-8888-4888-8888-888888888888', contactId: null, value: '+14015550187', eligibility: 'usable', version: 3 },
          { id: '99999999-9999-4999-8999-999999999999', contactId: null, value: '+14015550188', eligibility: 'candidate', version: 1 },
        ],
        emailRoutes: [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', contactId: null, value: 'reception@northwind.example.test', eligibility: 'usable', version: 2 },
        ],
        aliases: [{ aliasKind: 'name', aliasValue: 'Northwind Test Co' }],
      },
    },
    opportunity: {
      id: OPPORTUNITY_ID,
      status: 'open',
      stageKey: 'contacting',
      controlMode: 'automated',
      controlModeReason: null,
      openedAt: '2026-09-01T12:00:00.000Z',
      closedAt: null,
      closeReason: null,
    },
    stageHistory: [
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', occurredAt: '2026-09-01T12:00:00.000Z', fromStageKey: null, toStageKey: 'new', actorKind: 'system', reason: null },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', occurredAt: '2026-09-02T12:00:00.000Z', fromStageKey: 'new', toStageKey: 'contacting', actorKind: 'user', reason: null },
    ],
    holds: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        reasonCode: 'reassignment',
        blockedActionKinds: ['email_send', 'call_task'],
        startedAt: '2026-09-03T12:00:00.000Z',
        recoveryAction: 'resume_after_review',
      },
    ],
  };
}

/** The same firm as a colleague is given it (Appendix F row 1). */
export function colleagueFirmPage(): NonNullable<CrmState['firm']> {
  return { visibility: 'any_active_member', read: { visibility: 'any_active_member', firm: IDENTITY } };
}

export function pipelineView(): PipelineView {
  const stage = (key: string, displayName: string, position: number, terminalKind: 'won' | 'lost' | null, retired = false) => ({
    id: `eeeeeeee-eeee-4eee-8eee-${String(position).padStart(12, '0')}`,
    key,
    displayName,
    position,
    terminalKind,
    retired,
  });
  return {
    columns: [
      { stage: stage('new', 'New', 1, null), firms: [] },
      { stage: stage('contacting', 'Contacting', 2, null), firms: [IDENTITY] },
      { stage: stage('engaged', 'Engaged', 3, null), firms: [] },
      { stage: stage('won', 'Won', 4, 'won'), firms: [] },
      { stage: stage('lost', 'Lost', 5, 'lost'), firms: [] },
      // Retired and occupied: 8.1's "retired stages remain readable".
      { stage: stage('nurture', 'Nurture', 6, null, true), firms: [{ ...IDENTITY, id: OTHER_FIRM_ID, name: 'Larkspur Test Foundry', stageKey: 'nurture' }] },
      // Retired and empty: nothing to read, so nothing on screen.
      { stage: stage('cold', 'Cold', 7, null, true), firms: [] },
    ],
    opportunityIdByFirmId: { [FIRM_ID]: OPPORTUNITY_ID },
  };
}

export function mergeView(): NonNullable<CrmState['merge']> {
  return {
    sourceFirmId: FIRM_ID,
    sourceName: 'Northwind Test Holdings',
    targetFirmId: OTHER_FIRM_ID,
    targetName: 'Northwind Holdings Test',
    conflicts: [
      { field: 'website', source: 'https://northwind.example.test', target: 'https://northwind-holdings.example.test' },
      { field: 'locality', source: null, target: 'Providence' },
    ],
  };
}

const PREVIEW_FIRM = {
  name: 'Aspen Test Wealth',
  website: 'https://aspen.example.test',
  addressLine: null,
  locality: null,
  regionCode: null,
  postalCode: null,
  externalId: null,
  ownerUserId: null,
  timeZone: null,
};

/** The server's preview of a four-row file (lane g84): a new firm, a contact, a duplicate, a fault. */
export function importPreviewView(): ImportView {
  return {
    fileName: 'prospects.csv',
    fileRefusal: null,
    results: null,
    preview: {
      rows: [
        { rowNumber: 2, outcome: 'create', issues: [], firm: PREVIEW_FIRM, contact: { fullName: 'Kim Placeholder', title: 'Principal' }, routes: [{ kind: 'email', value: 'kim@aspen.example.test' }, { kind: 'phone', value: '+14015550121' }], match: null },
        { rowNumber: 3, outcome: 'attach', issues: [], firm: PREVIEW_FIRM, contact: { fullName: 'Lee Placeholder', title: null }, routes: [], match: { kind: 'in_file', rowNumber: 2, matchedOn: 'domain' } },
        { rowNumber: 4, outcome: 'duplicate', issues: [{ column: 'contact_email', code: 'duplicate_in_file' }], firm: PREVIEW_FIRM, contact: { fullName: 'Kim Again', title: null }, routes: [{ kind: 'email', value: 'kim@aspen.example.test' }], match: { kind: 'in_file', rowNumber: 2, matchedOn: 'domain' } },
        { rowNumber: 5, outcome: 'invalid', issues: [{ column: 'contact_phone', code: 'phone_invalid' }], firm: { ...PREVIEW_FIRM, name: 'Quince Test Co', website: null }, contact: { fullName: 'Pat Placeholder', title: null }, routes: [], match: null },
      ],
      counts: { create: 1, attach: 1, duplicate: 1, invalid: 1 },
    },
  };
}

/** What the commit of that preview answered: row 2 in, row 3 refused at commit. */
export function importResultsView(): ImportView {
  return {
    ...importPreviewView(),
    results: {
      results: [
        { rowNumber: 2, status: 'accepted', replayed: false, reason: null, firmId: FIRM_ID, column: null, outcome: 'created' },
        { rowNumber: 3, status: 'refused', replayed: false, reason: 'duplicate_in_workspace', firmId: null, column: 'contact_email', outcome: null },
      ],
      counts: { accepted: 1, refused: 1 },
    },
  };
}

export const EMPTY_DRAFT = {
  name: '',
  website: '',
  timeZone: '',
  contactName: '',
  contactTitle: '',
  contactEmail: '',
  contactPhone: '',
};

/** Lane g88: one published sequence, and nobody at the firm enrolled yet. */
export const SEQUENCE_VERSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export function firmSequences(overrides: Partial<NonNullable<CrmState['sequences']>> = {}): NonNullable<CrmState['sequences']> {
  return {
    published: [{ sequenceVersionId: SEQUENCE_VERSION_ID, label: 'Founder plan v1' }],
    enrollments: [],
    readError: null,
    ...overrides,
  };
}

/** The Firm page after "Confirm this number": the candidate is usable, one version later. */
function confirmedFirmPage(page: NonNullable<CrmState['firm']>): NonNullable<CrmState['firm']> {
  if (page.visibility !== 'assigned_or_admin' || page.read.visibility !== 'assigned_or_admin') return page;
  return {
    ...page,
    read: {
      ...page.read,
      firm: {
        ...page.read.firm,
        phoneRoutes: page.read.firm.phoneRoutes.map(route =>
          route.eligibility === 'candidate' ? { ...route, eligibility: 'usable' as const, version: route.version + 1 } : route,
        ),
      },
    },
  };
}

/**
 * Lane g90: a Firm page whose three addresses stand at each point of their validation —
 * still being checked, deliverable and usable, and one mail cannot reach.
 */
export const CHECKING_ROUTE_ID = 'abababab-abab-4bab-8bab-abababababab';
export function addressesFirmPage(): NonNullable<CrmState['firm']> {
  const page = assigneeFirmPage();
  if (page.visibility !== 'assigned_or_admin' || page.read.visibility !== 'assigned_or_admin') return page;
  return {
    ...page,
    read: {
      ...page.read,
      firm: {
        ...page.read.firm,
        emailRoutes: [
          { id: CHECKING_ROUTE_ID, contactId: null, value: 'intake@northwind.example.test', eligibility: 'candidate', version: 1, technicalValidation: 'unknown' },
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', contactId: null, value: 'reception@northwind.example.test', eligibility: 'usable', version: 2, technicalValidation: 'passed' },
          { id: 'acacacac-acac-4cac-8cac-acacacacacac', contactId: null, value: 'old@northwind.example.test', eligibility: 'invalid', version: 2, technicalValidation: 'failed' },
        ],
      },
    },
  };
}

export function crmState(overrides: Partial<CrmState> = {}): CrmState {
  return {
    screen: 'firm',
    role: 'salesperson',
    online: true,
    mayMutate: true,
    notice: null,
    firm: assigneeFirmPage(),
    pipeline: null,
    merge: null,
    ...overrides,
  };
}

/** The bridge the browser gets. The same methods the preload script exposes. */
const BRIDGE_SCRIPT = `
globalThis.callieCrm = {
  async state() { return await ask('state'); },
  async openFirm(input) { return await ask('openFirm', input); },
  async openPipeline() { return await ask('openPipeline'); },
  async saveContact(input) { return await ask('saveContact', input); },
  async changeStage(input) { return await ask('changeStage', input); },
  async resolveMerge(input) { return await ask('resolveMerge', input); },
  async openAddFirm() { return await ask('openAddFirm'); },
  async addFirm(input) { return await ask('addFirm', input); },
  async openImport() { return await ask('openImport'); },
  async previewImport(input) { return await ask('previewImport', input); },
  async commitImport() { return await ask('commitImport'); },
  async openOpportunity() { return await ask('openOpportunity'); },
  async enroll(input) { return await ask('enroll', input); },
  async confirmRoute(input) { return await ask('confirmRoute', input); },
  async checkRoute(input) { return await ask('checkRoute', input); },
};
async function ask(method, argument) {
  const response = await fetch('/bridge/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(argument ?? null),
  });
  return await response.json();
}
`;

async function transpile(): Promise<string> {
  const bundle = await build({
    entryPoints: [`${rendererDirectory}firmWorkspace.ts`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    platform: 'browser',
  });
  return bundle.outputFiles[0]?.text ?? '';
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export async function startCrmTestServer(initial: CrmState): Promise<CrmTestServer> {
  const script = await transpile();
  const html = (await readFile(`${rendererDirectory}firmWorkspace.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to
    // the main process across an IPC bridge, which CSP does not see. Here the bridge
    // is `fetch` to this same server, so the policy is relaxed to `'self'` for the
    // test document only; the file on disk stays strict.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  let state = initial;
  const calls: { method: string; argument: unknown }[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' || path === '/firmWorkspace.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/firmWorkspace.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        // The scripted outcomes. What each one proves is in the spec that uses it.
        if (method === 'openPipeline') state = { ...state, screen: 'pipeline', pipeline: pipelineView(), notice: null };
        if (method === 'openFirm') state = { ...state, screen: 'firm', firm: assigneeFirmPage(), notice: null };
        if (method === 'saveContact') state = { ...state, notice: 'saved' };
        if (method === 'changeStage') state = { ...state, notice: 'stage_changed' };
        if (method === 'resolveMerge') state = { ...state, notice: 'merged' };
        // Lane g84: Add firm and Import.
        if (method === 'openAddFirm') {
          state = { ...state, screen: 'add_firm', notice: null, addFirm: { draft: EMPTY_DRAFT, issues: [], duplicateFirmId: null } };
        }
        if (method === 'addFirm') state = { ...state, screen: 'firm', firm: assigneeFirmPage(), addFirm: null, notice: 'firm_added' };
        if (method === 'openImport') {
          state = { ...state, screen: 'import', notice: null, import: { fileName: null, preview: null, fileRefusal: null, results: null } };
        }
        if (method === 'previewImport') state = { ...state, screen: 'import', notice: null, import: importPreviewView() };
        if (method === 'commitImport') state = { ...state, notice: 'imported_with_refusals', import: importResultsView() };
        // Lane g88: Confirm this number, Add to pipeline, Enrol.
        if (method === 'confirmRoute' && state.firm !== null) {
          state = { ...state, firm: confirmedFirmPage(state.firm), notice: 'route_confirmed' };
        }
        if (method === 'openOpportunity') state = { ...state, notice: 'opportunity_opened' };
        // Lane g90: Check again queues a check; the address is still being checked.
        if (method === 'checkRoute') state = { ...state, notice: 'route_check_queued' };
        if (method === 'enroll') {
          const input = argument as { contactId?: string } | null;
          state = {
            ...state,
            notice: 'enrolled',
            sequences: firmSequences({
              enrollments: [
                {
                  enrollmentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                  contactId: input?.contactId ?? '',
                  label: 'Founder plan v1',
                  state: 'active',
                  startedAt: '2026-09-25T13:00:00.000Z',
                },
              ],
            }),
          };
        }
        return send(200, 'application/json', JSON.stringify(state));
      }
      return send(404, 'text/plain', 'not found');
    })().catch(() => {
      send(500, 'text/plain', 'test server failed');
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    calls,
    setState: value => {
      state = value;
    },
    stop: async () => {
      // The page holds a keep-alive socket, and `close` waits for every open
      // connection: a spec that made no bridge call leaves one idle and the hook
      // hangs until the test times out. Closing them first is the whole fix.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
