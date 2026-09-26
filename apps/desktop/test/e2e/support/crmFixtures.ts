import type { CrmState, ImportView, PipelineView } from '../../../src/renderer/firmWorkspaceContract.ts';
import type { Call } from './appServer.ts';

/**
 * The Firms view's fixtures and the `callieCrm` fake's scripted answers, for the one
 * harness (`appServer.ts`).
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

export const FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_FIRM_ID = '44444444-4444-4444-8444-444444444444';
export const ASSIGNEE_ID = '22222222-2222-4222-8222-222222222222';
export const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';

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

/** `callieCrm`, scripted. What each outcome proves is in the spec that uses it. */
export function crmAnswer(state: CrmState, method: string, argument: unknown, _calls: readonly Call[]): CrmState {
  if (method === 'openPipeline') return { ...state, screen: 'pipeline', pipeline: pipelineView(), notice: null };
  if (method === 'openFirm') {
    // The firm page the bridge would read for that id: the one held when it is that
    // firm's (a colleague's view stays a colleague's), the assignee's otherwise.
    const firmId = (argument as { firmId?: string } | null)?.firmId;
    const held = state.firm !== null && state.firm.read.firm.id === firmId ? state.firm : null;
    const page = assigneeFirmPage();
    const firm = held ?? ({ ...page, read: { ...page.read, firm: { ...page.read.firm, id: firmId ?? FIRM_ID } } } as NonNullable<CrmState['firm']>);
    return { ...state, screen: 'firm', firm, notice: null };
  }
  if (method === 'saveContact') return { ...state, notice: 'saved' };
  if (method === 'changeStage') return { ...state, notice: 'stage_changed' };
  if (method === 'resolveMerge') return { ...state, notice: 'merged' };
  // Lane g84: Add firm and Import.
  if (method === 'openAddFirm') {
    return { ...state, screen: 'add_firm', notice: null, addFirm: { draft: EMPTY_DRAFT, issues: [], duplicateFirmId: null } };
  }
  if (method === 'addFirm') return { ...state, screen: 'firm', firm: assigneeFirmPage(), addFirm: null, notice: 'firm_added' };
  if (method === 'openImport') {
    return { ...state, screen: 'import', notice: null, import: { fileName: null, preview: null, fileRefusal: null, results: null } };
  }
  if (method === 'previewImport') return { ...state, screen: 'import', notice: null, import: importPreviewView() };
  if (method === 'commitImport') return { ...state, notice: 'imported_with_refusals', import: importResultsView() };
  // Lane g88: Confirm this number, Add to pipeline, Enrol.
  if (method === 'confirmRoute' && state.firm !== null) {
    return { ...state, firm: confirmedFirmPage(state.firm), notice: 'route_confirmed' };
  }
  if (method === 'openOpportunity') return { ...state, notice: 'opportunity_opened' };
  // Lane g90: Check again queues a check; the address is still being checked.
  if (method === 'checkRoute') return { ...state, notice: 'route_check_queued' };
  if (method === 'enroll') {
    const input = argument as { contactId?: string } | null;
    return {
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
  return state;
}
