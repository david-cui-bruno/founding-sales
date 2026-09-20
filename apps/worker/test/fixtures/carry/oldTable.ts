/**
 * Synthetic items in the old DynamoDB table's shapes (lane G11).
 *
 * Every record here is invented. No real firm name, no real person, no address, and
 * no phone number outside the NANP reserved fictional 555-01XX block. The shapes are
 * copied from `cloud/lambdas/delegated-worker/src/v1/{firmsWrite,evidence,suppression,templates}.ts`
 * at the tag `dynamo-rebuild-final`; the values are not.
 *
 * The old table stores one item per record: `pk = WORKSPACE#<id>`, `sk` = the record's
 * prefixed sort key, and `data` = the record body. The carry reader sees exactly that,
 * through `OldTableReader`, so a fixture here and a page from the real table are the
 * same thing to every line of the tool.
 */

export interface FixtureItem {
  readonly sk: string;
  readonly workspaceId: string;
  readonly data: unknown;
}

/** The instant David disabled the old worker's schedule, in every fixture below. */
export const FIXTURE_WATERMARK = '2026-09-21T13:00:00.000Z';
/** Comfortably before the watermark: everything a good export carries. */
const BEFORE = '2026-09-20T09:15:00.000Z';
const EARLIER = '2026-09-18T11:00:00.000Z';
/** After it. Only the scenario-20 fixtures use this. */
export const AFTER_WATERMARK = '2026-09-21T13:00:00.001Z';

const OLD_WORKSPACE = 'legacy-workspace';

function item(sk: string, data: unknown, workspaceId = OLD_WORKSPACE): FixtureItem {
  return { sk, workspaceId, data };
}

/** A `FIRM#` record: the shape the old core wrote for a firm it knew about. */
export function firmRecord(overrides: {
  readonly firmId: string;
  readonly name: string;
  readonly domain?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly timeZone?: string | null;
  readonly routes?: readonly unknown[];
  readonly updatedAt?: string;
}): FixtureItem {
  return item(`FIRM#${overrides.firmId}`, {
    version: 1,
    firmId: overrides.firmId,
    name: overrides.name,
    domain: overrides.domain ?? null,
    city: overrides.city ?? null,
    state: overrides.state ?? null,
    timeZone: overrides.timeZone ?? null,
    derivedZoneFrom: overrides.timeZone == null ? null : 'territory_state_map',
    status: 'new',
    enteredBy: 'research',
    evidenceSummary: '2 sources',
    routes: overrides.routes ?? [],
    enteredAt: EARLIER,
    updatedAt: overrides.updatedAt ?? BEFORE,
  });
}

export function route(overrides: {
  readonly id: string;
  readonly channel: 'phone' | 'email';
  readonly value: string;
  readonly verification?: string;
}): unknown {
  return {
    id: overrides.id,
    channel: overrides.channel,
    value: overrides.value,
    purpose: 'business',
    verification: overrides.verification ?? 'published',
    version: 1,
    enteredAt: EARLIER,
  };
}

/** An `ACCOUNT#` record: the older firm shape, read only where no `FIRM#` exists. */
export function accountRecord(overrides: {
  readonly firmId: string;
  readonly name: string;
  readonly domain?: string | null;
  readonly routes?: readonly unknown[];
  readonly at?: string;
}): FixtureItem {
  return item(`ACCOUNT#${overrides.firmId}`, {
    account: { id: overrides.firmId, name: overrides.name, domain: overrides.domain ?? null },
    routes: overrides.routes ?? [],
    claims: [],
    sources: [],
    history: [{ at: overrides.at ?? BEFORE, note: 'admitted' }],
  });
}

export function evidenceRecord(overrides: {
  readonly firmId: string;
  readonly sources: readonly { id: string; url: string; sha256: string; excerpt?: string }[];
  readonly updatedAt?: string;
}): FixtureItem {
  return item(`EVIDENCE#${overrides.firmId}`, {
    version: 1,
    firmId: overrides.firmId,
    sources: overrides.sources.map(source => ({
      id: source.id,
      url: source.url,
      fetchedAt: EARLIER,
      sha256: source.sha256,
      excerpt: source.excerpt ?? 'A synthetic excerpt from a page that does not exist.',
    })),
    extraction: null,
    businessEmailFinding: null,
    revision: 1,
    updatedAt: overrides.updatedAt ?? BEFORE,
  });
}

export function firmSuppression(overrides: {
  readonly firmId: string;
  readonly handles?: readonly string[];
  readonly at?: string;
}): FixtureItem {
  return item(`SUPPRESS#FIRM#${overrides.firmId}`, {
    version: 1,
    firmId: overrides.firmId,
    reason: 'asked not to be contacted again',
    source: 'reply',
    evidenceRef: null,
    recordedBy: 'fixture',
    at: overrides.at ?? BEFORE,
    handles: overrides.handles ?? [],
  });
}

export function handleSuppression(overrides: {
  readonly handle: string;
  readonly channel: 'phone' | 'email';
  readonly firmId?: string | null;
  readonly at?: string;
}): FixtureItem {
  return item(`SUPPRESS#${encodeURIComponent(overrides.handle)}`, {
    version: 1,
    handle: overrides.handle,
    channel: overrides.channel,
    firmId: overrides.firmId ?? null,
    reason: 'do not call this number',
    source: 'call',
    evidenceRef: null,
    recordedBy: 'fixture',
    at: overrides.at ?? BEFORE,
  });
}

export function templateRecord(overrides: {
  readonly templateId: string;
  readonly subject: string;
  readonly body: string;
  readonly approved?: boolean;
  readonly updatedAt?: string;
}): FixtureItem {
  const approved = overrides.approved ?? false;
  return item(`TEMPLATE#${overrides.templateId}`, {
    version: 1,
    templateId: overrides.templateId,
    name: `Template ${overrides.templateId}`,
    subject: overrides.subject,
    body: overrides.body,
    variables: [],
    revision: approved ? 2 : 1,
    approval: approved
      ? {
          state: 'approved',
          approvedRevision: 2,
          approvedAt: EARLIER,
          contentHash: 'f'.repeat(64),
          footerPostalAddress: 'A synthetic postal address, Somewhere',
        }
      : { state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null, footerPostalAddress: null },
    updatedAt: overrides.updatedAt ?? BEFORE,
  });
}

/**
 * The table a good carry reads: four firms, two of them with evidence, four
 * suppressions across both scopes, and two templates.
 *
 * `account-delta` has an `ACCOUNT#` row and no `FIRM#` row, so it exercises the
 * old-key fall-back. `account-alpha` has both, so it exercises the rule that the
 * `FIRM#` record wins and the firm is carried once rather than twice.
 */
export function goodOldTable(): readonly FixtureItem[] {
  return [
    firmRecord({
      firmId: 'account-alpha',
      name: 'Alpha Synthetic Partners',
      domain: 'alpha.example.test',
      city: 'Providence',
      state: 'RI',
      timeZone: 'America/New_York',
      routes: [
        route({ id: 'route-a1', channel: 'phone', value: '+14015550101' }),
        route({ id: 'route-a2', channel: 'email', value: 'contact@alpha.example.test' }),
      ],
    }),
    accountRecord({ firmId: 'account-alpha', name: 'Alpha Synthetic Partners', domain: 'alpha.example.test' }),
    firmRecord({
      firmId: 'account-bravo',
      name: 'Bravo Invented Group',
      domain: 'bravo.example.test',
      city: 'Austin',
      // Texas spans two zones, so the carried firm lands uncallable on purpose.
      state: 'TX',
      timeZone: 'America/Chicago',
      routes: [route({ id: 'route-b1', channel: 'phone', value: '+14015550102' })],
    }),
    firmRecord({
      firmId: 'account-charlie',
      name: 'Charlie Notional Works',
      domain: null,
      city: null,
      state: null,
      timeZone: null,
    }),
    accountRecord({
      firmId: 'account-delta',
      name: 'Delta Imaginary Supply',
      domain: 'delta.example.test',
      routes: [route({ id: 'route-d1', channel: 'phone', value: '+14015550104' })],
    }),
    evidenceRecord({
      firmId: 'account-alpha',
      sources: [
        { id: 'src-a1', url: 'https://alpha.example.test/about', sha256: 'a'.repeat(64) },
        { id: 'src-a2', url: 'https://alpha.example.test/contact', sha256: 'b'.repeat(64) },
      ],
    }),
    evidenceRecord({
      firmId: 'account-bravo',
      sources: [{ id: 'src-b1', url: 'https://bravo.example.test/', sha256: 'c'.repeat(64) }],
    }),
    firmSuppression({ firmId: 'account-charlie', handles: ['+14015550103'] }),
    handleSuppression({ handle: '+14015550103', channel: 'phone', firmId: 'account-charlie' }),
    handleSuppression({ handle: '+14015550199', channel: 'phone', firmId: null }),
    handleSuppression({ handle: 'stop@delta.example.test', channel: 'email', firmId: 'account-delta' }),
    templateRecord({ templateId: 'T1', subject: 'A first synthetic subject', body: 'A first synthetic body.' }),
    templateRecord({
      templateId: 'T2',
      subject: 'A second synthetic subject',
      body: 'A second synthetic body.',
      approved: true,
    }),
  ];
}

/** The same table plus one suppression recorded after the watermark (Appendix G 20). */
export function tableWithPostWatermarkWrite(): readonly FixtureItem[] {
  return [
    ...goodOldTable(),
    handleSuppression({ handle: '+14015550188', channel: 'phone', firmId: null, at: AFTER_WATERMARK }),
  ];
}

/** A table with one record the reader cannot understand. A carry must not skip it. */
export function tableWithUnreadableRecord(): readonly FixtureItem[] {
  return [...goodOldTable(), item('FIRM#account-echo', { version: 1, firmId: 'account-echo' })];
}

/** The prefixes the export queries, in the order it queries them. */
export const OLD_TABLE_PREFIXES = ['FIRM#', 'ACCOUNT#', 'EVIDENCE#', 'SUPPRESS#', 'TEMPLATE#'] as const;
