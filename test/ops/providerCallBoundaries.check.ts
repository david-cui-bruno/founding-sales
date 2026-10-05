import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Slice R0: static bypass checks for the final provider-call boundaries.
 *
 * Each outside call is made at ONE authoritative site, inside one function, after every
 * gate that decides whether it may happen (suppression, switches, clearance, budget, the
 * paid-call reservation). A second call, a helper, or a detached reference to the method
 * is a way around those gates, and nothing else in the suite notices one.
 *
 * This parses every non-test source file with the TypeScript compiler (syntax only, no
 * type check) and reports EVERY Identifier, PrivateIdentifier, StringLiteral or
 * NoSubstitutionTemplateLiteral node whose text equals a guarded method name, anywhere
 * outside its owner function, unless it sits in a pure declaration position. It does not
 * enumerate spellings: property access, optional calls, element access, every form of
 * destructuring (declaration, computed key, assignment), aliases, arguments and anything
 * not yet thought of are all just "the name appears".
 *
 * A pure declaration position is the NAME of a method or property signature, a method,
 * property or accessor declaration (interface, type literal, class), or an object-literal
 * member (`m(...) {}`, `m: ...`, shorthand `{ m }`), a computed name of one of those, or a
 * literal type (`Pick<X, 'm'>`). Those define or describe the method, so the adapters
 * and interfaces need no file-level exemption. An unrelated hit (another object's
 * `kind === 'extract'`, say) goes in ALLOWED_ELSEWHERE with a reason.
 *
 * Inside the owner, the number of references must be exactly the expected number of
 * calls (all of them call expressions), so a second call or an alias inside the owner
 * fails too.
 *
 * Not caught, by the nature of a syntactic check: a provider reached through a name this
 * table does not list (a new method), or built at run time (`x['send' + 'Message']`).
 */

interface Boundary {
  /** What the boundary is, for the failure message. */
  readonly name: string;
  /** The one file allowed to touch the methods, repository-relative. */
  readonly site: string;
  /** The function in that file that owns them (declaration, method or const arrow). */
  readonly owner: string;
  /** Each provider method and the number of call sites expected inside the owner. */
  readonly methods: Readonly<Record<string, number>>;
}

/**
 * The one table. A change to an owner function's name, or to how many calls it makes,
 * is a one-line change here.
 */
export const BOUNDARIES: readonly Boundary[] = [
  { name:'Zoom local recording update', site:'packages/domain/meetings/autoRecording.ts', owner:'runMeetingRecordingSetup', methods:{setLocalAutoRecording:1} },
  {
    name: 'Gmail send',
    site: 'packages/domain/outbound/send.ts',
    owner: 'dispatchOutboundMessage',
    methods: { sendMessage: 1 },
  },
  {
    name: 'research provider calls (page fetch, token count, extraction)',
    site: 'packages/domain/research/enrichment.ts',
    // P1 fix round 2: chunk 3's body; `finishFirmResearch` wraps it only to write the page-fetch ledger row last.
    owner: 'finishFirmResearchBody',
    methods: { fetchPages: 1, countInputTokens: 1, extract: 1 },
  },
  {
    name: 'reply classifier provider',
    site: 'packages/domain/classification/classify.ts',
    // P1 fix round 2: the classifier is three chunks; the request is chunk 3's, after chunk 2 committed `calling`.
    owner: 'finishClassification',
    methods: { classify: 1 },
  },
  {
    name: 'call transcription provider',
    site: 'packages/domain/calls/transcription.ts',
    owner: 'finishCallTranscription',
    methods: { transcribe: 1 },
  },
];

/**
 * A reference allowed somewhere else. Each entry needs a REASON that says why it cannot
 * go through the boundary and what gates it instead; "it is convenient" is not one.
 * There are none today. Adding an entry is a review decision, not a way to make this
 * check green.
 */
export interface Allowed {
  readonly file: string;
  readonly method: string;
  readonly reason: string;
}
export const ALLOWED_ELSEWHERE: readonly Allowed[] = [
  {
    file:'packages/domain/sourcing/sourceCheck.ts',method:'fetchPages',
    reason:'Candidate source checks cannot use firm enrichment without creating a callable CRM firm. requestSourceCheck consumes the shared daily research count before enqueue; runSourceCheck checks research settings/holds, the pending check ID, dismissal and deadline, then uses the same bounded page adapter with one URL/page. It never calls a model or search provider; tests cover limits, retries and stale results.',
  },
  ...['analysisAdapter', 'analysisInput', 'analysisRequests'].map(name => ({
    file: `packages/domain/meetings/${name}.ts`, method: 'extract',
    reason: "the literal 'extract' names the meeting-analysis phase (versus merge), never a research provider method; paid analysis dispatch is gated by analysisPaid and the meeting worker",
  })),
  {
    file: 'packages/contracts/src/meetingTranscription.ts',
    method: 'transcribe',
    reason: "the Zod literal 'transcribe' identifies the service in audited credit-coverage metadata; it is not a provider reference or a paid call",
  },
  {
    file: 'apps/desktop/src/main/updateInstall.ts',
    method: 'extract',
    reason: "the string 'extract' names a failed install step (`step: 'extract'`) after `ditto` unzips an update; it is not the research provider",
  },
  {
    file: 'apps/worker/src/tools/fss/readOnlyGmail.ts',
    method: 'sendMessage',
    reason: "`refusedAsync('sendMessage')` installs a REFUSING stub on the read-only Gmail wrapper; it makes the method throw and never calls the provider",
  },
  {
    file: 'packages/domain/mail/gmailClientFake.ts',
    method: 'sendMessage',
    reason: "`record('sendMessage', ...)` is the in-memory fake logging that it was called; the fake is a test double with no provider behind it",
  },
  {
    file: 'packages/domain/crm/import.ts',
    method: 'classify',
    reason: 'a local function that classifies spreadsheet import rows as new, duplicate or invalid; unrelated to the reply classifier provider',
  },
];

const ROOTS = ['apps', 'packages', 'tools', 'scripts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', '.git']);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const TEST_FILE = /\.(?:test|check|spec)\.[a-z]+$/u;

export interface Reference {
  readonly method: string;
  readonly line: number;
  /** Whether the appearance is the callee of a call expression. */
  readonly called: boolean;
  /** The enclosing named functions, innermost first. */
  readonly enclosing: readonly string[];
}

/** The names a function-like node answers to: its own, or its variable's. */
function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function enclosingFunctions(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    const name = functionName(current);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Whether an object or array literal is the TARGET of an assignment (`({ m: x } = y)`,
 * `[{ m }] = ys`, `for ({ m } of ys)`), where its members read from the right-hand side
 * instead of defining anything.
 */
function isAssignmentTarget(literal: ts.Node): boolean {
  let current: ts.Node = literal;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isObjectLiteralExpression(parent)) {
      current = parent;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      current = parent;
    } else if (ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer === current) {
      current = parent;
    } else {
      break;
    }
  }
  const parent = current.parent;
  if (parent === undefined) return false;
  if (ts.isBinaryExpression(parent)) return parent.left === current && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current;
}

/** Whether `node` is the name (or computed name) of a definition, or a literal type. */
function inDeclarationPosition(node: ts.Node): boolean {
  let name: ts.Node = node;
  if (name.parent !== undefined && ts.isComputedPropertyName(name.parent)) name = name.parent;
  const parent = name.parent;
  if (parent === undefined) return false;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (
    ts.isMethodSignature(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  ) {
    return parent.name === name;
  }
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
    // An object-literal member defines a method, unless the literal is being assigned to.
    return parent.name === name && !isAssignmentTarget(parent.parent);
  }
  return false;
}

/** Every appearance of one of `methods` in `text` outside a declaration position. */
export function referencesIn(text: string, methods: ReadonlySet<string>, fileName = 'file.ts'): Reference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.[cm]?[jt]sx$/u.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Reference[] = [];
  const calleeOf = (node: ts.Node): boolean => {
    let outer: ts.Node = node;
    // `x.m!(...)`, `(x.m)(...)` and `x.m?.(...)` are still calls of the reference.
    while (outer.parent !== undefined && (ts.isNonNullExpression(outer.parent) || ts.isParenthesizedExpression(outer.parent))) outer = outer.parent;
    return outer.parent !== undefined && ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
  };
  const visit = (node: ts.Node): void => {
    let name: string | undefined;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      name = node.text.replace(/^#/u, '');
    }
    if (name !== undefined && methods.has(name) && !inDeclarationPosition(node)) {
      // The expression the name belongs to: `x.m` or `x['m']`, else the name itself.
      let expression: ts.Node = node;
      const parent = node.parent;
      if (parent !== undefined && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node))) {
        expression = parent;
      }
      found.push({
        method: name,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        called: calleeOf(expression),
        enclosing: enclosingFunctions(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

export interface Violation {
  readonly boundary: string;
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly kind: 'outside-owner' | 'owner-calls' | 'owner-missing';
  readonly detail: string;
}

/** Every breach of a boundary under `root`: references outside the owner, a wrong count inside it. */
export function findViolations(
  root: string,
  boundaries: readonly Boundary[] = BOUNDARIES,
  allowed: readonly Allowed[] = ALLOWED_ELSEWHERE,
): Violation[] {
  const violations: Violation[] = [];
  const all = new Set(boundaries.flatMap(boundary => Object.keys(boundary.methods)));
  const ownerCalls = new Map<string, number>();
  const ownerReferences = new Map<string, number>();
  for (const top of ROOTS) {
    for (const path of sourceFiles(join(root, top))) {
      const file = relative(root, path).split('\\').join('/');
      for (const reference of referencesIn(readFileSync(path, 'utf8'), all, path)) {
        for (const boundary of boundaries) {
          if (!(reference.method in boundary.methods)) continue;
          const key = `${boundary.name}\0${reference.method}`;
          if (file === boundary.site && reference.enclosing.includes(boundary.owner)) {
            ownerReferences.set(key, (ownerReferences.get(key) ?? 0) + 1);
            if (reference.called) ownerCalls.set(key, (ownerCalls.get(key) ?? 0) + 1);
            continue;
          }
          if (allowed.some(entry => entry.file === file && entry.method === reference.method)) continue;
          violations.push({
            boundary: boundary.name,
            file,
            line: reference.line,
            method: reference.method,
            kind: 'outside-owner',
            detail: `${file}:${String(reference.line)} references .${reference.method}, the ${boundary.name} boundary, outside ${boundary.owner} in ${boundary.site}`,
          });
        }
      }
    }
  }
  for (const boundary of boundaries) {
    let ownerSeen = true;
    try {
      ownerSeen = new RegExp(`\\b${boundary.owner}\\b`, 'u').test(readFileSync(join(root, boundary.site), 'utf8'));
    } catch {
      ownerSeen = false;
    }
    if (!ownerSeen) {
      violations.push({
        boundary: boundary.name,
        file: boundary.site,
        line: 0,
        method: '',
        kind: 'owner-missing',
        detail: `${boundary.site} no longer has ${boundary.owner}; the boundary moved, so update BOUNDARIES in this check`,
      });
      continue;
    }
    for (const [method, expected] of Object.entries(boundary.methods)) {
      const key = `${boundary.name}\0${method}`;
      const calls = ownerCalls.get(key) ?? 0;
      const references = ownerReferences.get(key) ?? 0;
      if (calls !== expected || references !== expected) {
        violations.push({
          boundary: boundary.name,
          file: boundary.site,
          line: 0,
          method,
          kind: 'owner-calls',
          detail: `${boundary.owner} in ${boundary.site} has ${String(calls)} call(s) and ${String(references)} reference(s) to .${method}, expected exactly ${String(expected)} call(s) and no other reference`,
        });
      }
    }
  }
  return violations;
}

function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map(violation =>
      violation.kind === 'outside-owner'
        ? `${violation.detail}. Every call goes through that function, after every gate; new call sites must go through it. ` +
          'If this one truly cannot, add it to ALLOWED_ELSEWHERE in test/ops/providerCallBoundaries.check.ts with the reason and what gates it instead.'
        : `${violation.boundary}: ${violation.detail}. New call sites must go through the boundary; if the owner legitimately changed, update BOUNDARIES in test/ops/providerCallBoundaries.check.ts.`,
    )
    .join('\n');
}

const REPOSITORY = repositoryPath('');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'fss-boundaries-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  return root;
}

const real = (file: string): string => readFileSync(join(REPOSITORY, file), 'utf8');

describe('each provider call is made at its one authoritative site, inside its owner', () => {
  it('has no reference outside an owner, and exactly the expected calls inside it', () => {
    const violations = findViolations(REPOSITORY);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('keeps each allow-list entry reasoned and real', () => {
    for (const entry of ALLOWED_ELSEWHERE) {
      expect(entry.reason.trim().length, `${entry.file} (${entry.method}) is allowed without a reason`).toBeGreaterThan(20);
      expect(real(entry.file)).toContain(entry.method);
    }
  });
});

describe('the check itself', () => {
  // A one-boundary table over a scratch site, so each bypass is a few lines.
  const TABLE: readonly Boundary[] = [{ name: 'Fixture send', site: 'packages/domain/site.ts', owner: 'sendOnce', methods: { sendMessage: 1 } }];
  const SITE = 'export async function sendOnce(gmail: G) {\n  return await gmail.sendMessage(a, b);\n}\n';
  const withSite = (extra: string, other: Readonly<Record<string, string>> = {}): Violation[] =>
    findViolations(scratch({ 'packages/domain/site.ts': SITE + extra, ...other }), TABLE);
  const kinds = (violations: readonly Violation[]): string[] => violations.map(v => `${v.kind}:${v.method}`);

  it('passes the clean fixture', () => {
    expect(withSite('')).toEqual([]);
  });

  it('fails on a helper in the same file that calls the provider (the review’s case)', () => {
    const found = withSite('export async function sendWithoutGates(gmail: G) {\n  return gmail.sendMessage(a, b);\n}\n');
    expect(kinds(found)).toEqual(['outside-owner:sendMessage']);
    expect(found[0]?.line).toBe(5);
    expect(describeViolations(found)).toContain('new call sites must go through it');
  });

  it('fails on a helper that is an arrow function or a method in the same file', () => {
    expect(kinds(withSite('const viaArrow = (g: G) => g.sendMessage(a, b);\n'))).toEqual(['outside-owner:sendMessage']);
    expect(kinds(withSite('class Helper {\n  run(g: G) { return g.sendMessage(a, b); }\n}\n'))).toEqual(['outside-owner:sendMessage']);
  });

  it('fails on destructuring, in the same file and elsewhere', () => {
    for (const code of ['const { sendMessage } = gmail;', 'const { sendMessage: send } = gmail;', "const { 'sendMessage': send } = gmail;", 'function f({ sendMessage }: G) { return 1; }', 'const { ["sendMessage"]: send } = gmail;', 'const { [`sendMessage`]: send } = gmail;', 'let send: any;\n({ sendMessage: send } = gmail);', 'let send2: any;\n[{ sendMessage: send2 }] = [gmail];', 'for (const { sendMessage } of gmails) {}']) {
      expect(kinds(withSite(`${code}\n`)), code).toEqual(['outside-owner:sendMessage']);
      expect(kinds(findViolations(scratch({ 'packages/domain/site.ts': SITE, 'apps/worker/src/x.ts': `${code}\n` }), TABLE)), code).toEqual(['outside-owner:sendMessage']);
    }
  });

  it('fails on an alias, an argument to a wrapper, and an uncalled reference', () => {
    for (const code of ['const send = gmail.sendMessage;', 'withRetry(gmail.sendMessage, 3);', 'const bound = gmail.sendMessage.bind(gmail);', 'export const table = [gmail.sendMessage];']) {
      expect(kinds(withSite(`${code}\n`)), code).toEqual(['outside-owner:sendMessage']);
    }
  });

  it('fails on optional calls and element access', () => {
    for (const code of ['gmail.sendMessage?.(a, b);', 'gmail?.sendMessage(a, b);', "gmail['sendMessage'](a, b);", 'gmail["sendMessage"]?.(a, b);', 'gmail.sendMessage!(a, b);', '(gmail.sendMessage)(a, b);', 'gmail.sendMessage.call(gmail, a, b);']) {
      expect(kinds(withSite(`${code}\n`)), code).toEqual(['outside-owner:sendMessage']);
    }
  });

  it('fails inside the owner on a second call, an alias, or a missing call', () => {
    const twice = SITE.replace('  return await gmail.sendMessage(a, b);', '  await gmail.sendMessage(a, b);\n  return await gmail.sendMessage(a, b);');
    expect(kinds(findViolations(scratch({ 'packages/domain/site.ts': twice }), TABLE))).toEqual(['owner-calls:sendMessage']);
    const alias = SITE.replace('  return await gmail.sendMessage(a, b);', '  const send = gmail.sendMessage;\n  return await gmail.sendMessage(a, b);');
    expect(kinds(findViolations(scratch({ 'packages/domain/site.ts': alias }), TABLE))).toEqual(['owner-calls:sendMessage']);
    const none = SITE.replace('gmail.sendMessage(a, b)', 'gmail.other(a, b)');
    expect(kinds(findViolations(scratch({ 'packages/domain/site.ts': none }), TABLE))).toEqual(['owner-calls:sendMessage']);
    const renamed = SITE.replace('sendOnce', 'sendTwice');
    expect(kinds(findViolations(scratch({ 'packages/domain/site.ts': renamed }), TABLE)).sort()).toEqual(['outside-owner:sendMessage', 'owner-missing:'].sort());
  });

  it('accepts a call inside a closure of the owner, as the real research and send paths make them', () => {
    const closure = 'export async function sendOnce(gmail: G) {\n  return await attempt(async () => await gmail.sendMessage(a, b));\n}\n';
    expect(findViolations(scratch({ 'packages/domain/site.ts': closure }), TABLE)).toEqual([]);
  });

  it('does not fail on definitions, types and implementations, with no file exempted', () => {
    const definitions = [
      'export interface Client {\n  sendMessage(access: A, request: R): Promise<O>;\n}',
      'export interface Client2 {\n  readonly sendMessage: (access: A) => Promise<O>;\n}',
      "export type Narrow = Pick<Client, 'sendMessage'>;",
      "export type Member = Client['sendMessage'];",
      'export class Http implements Client {\n  async sendMessage(access: A, request: R) { return post(access, request); }\n}',
      'export const adapter = {\n  sendMessage: async (access: A) => post(access),\n  async fetchPages() {},\n};',
      'export const shorthand = { sendMessage };',
    ].join('\n');
    expect(findViolations(scratch({ 'packages/domain/adapter.ts': definitions, 'packages/domain/site.ts': SITE }), TABLE)).toEqual([]);
    // And the same definitions placed in the site file itself, beside the owner.
    expect(withSite(`${definitions}\n`)).toEqual([]);
  });

  it('does not fail on comments, strings that merely contain the name, or tests', () => {
    const found = withSite('', {
      'apps/api/src/note.ts': "// gmail.sendMessage(grant, request) is only made in site.ts\n/* x.sendMessage(y) */\nexport const a = 'x.sendMessage(y)';\n",
      'apps/api/test/second.test.ts': 'gmail.sendMessage(a, b);\n',
      'packages/domain/test/helper.ts': 'gmail.sendMessage(a, b);\n',
      'apps/worker/src/fake.check.ts': 'gmail.sendMessage(a, b);\n',
    });
    expect(found).toEqual([]);
  });

  it('flags an unrelated hit of the same name until it is allow-listed with a reason', () => {
    const files = { 'packages/domain/site.ts': SITE, 'packages/domain/crm/import.ts': 'async function sendMessage(a: A) { return a; }\nawait sendMessage(context);\n' };
    expect(kinds(findViolations(scratch(files), TABLE))).toEqual(['outside-owner:sendMessage', 'outside-owner:sendMessage']);
    const allowed: readonly Allowed[] = [{ file: 'packages/domain/crm/import.ts', method: 'sendMessage', reason: 'a local function of the same name, unrelated' }];
    expect(findViolations(scratch(files), TABLE, allowed)).toEqual([]);
  });

  it('honours an allow-list entry, and only for that file and method', () => {
    const root = scratch({ 'packages/domain/site.ts': SITE, 'apps/worker/src/x.ts': 'a.sendMessage(1);\nb.other(2);\n' });
    const allowed: readonly Allowed[] = [{ file: 'apps/worker/src/x.ts', method: 'sendMessage', reason: 'fixture reason that is long enough' }];
    expect(findViolations(root, TABLE, allowed)).toEqual([]);
    const elsewhere: readonly Allowed[] = [{ file: 'apps/worker/src/y.ts', method: 'sendMessage', reason: 'fixture reason that is long enough' }];
    expect(kinds(findViolations(root, TABLE, elsewhere))).toEqual(['outside-owner:sendMessage']);
  });

  it('fails the real files on the review’s bypasses, appended to a copy of each site', () => {
    const cases: readonly [string, string][] = [
      ['packages/domain/outbound/send.ts', 'export async function sendWithoutGates(g: any) {\n  return g.sendMessage(1, 2);\n}\n'],
      ['packages/domain/outbound/send.ts', 'const { sendMessage } = deps.gmail;\n'],
      ['packages/domain/outbound/send.ts', 'withRetry(deps.gmail.sendMessage, 3);\n'],
      ['packages/domain/outbound/send.ts', 'const alias = deps.gmail.sendMessage;\n'],
      ['packages/domain/outbound/send.ts', 'deps.gmail.sendMessage?.(1, 2);\n'],
      ['packages/domain/outbound/send.ts', 'const { ["sendMessage"]: viaComputed } = deps.gmail;\n'],
      ['packages/domain/outbound/send.ts', 'let viaAssignment: any;\n({ sendMessage: viaAssignment } = deps.gmail);\n'],
      ['packages/domain/research/enrichment.ts', 'export const helper = (e: any) => e.extract(1);\n'],
      ['packages/domain/classification/classify.ts', 'export const helper = (c: any) => c.classify(1);\n'],
      ['packages/domain/calls/transcription.ts', 'export const helper = (p: any) => p.transcribe(1);\n'],
    ];
    for (const [file, extra] of cases) {
      const files: Record<string, string> = {};
      for (const boundary of BOUNDARIES) files[boundary.site] = real(boundary.site);
      files[file] = `${files[file] ?? ''}\n${extra}`;
      const found = findViolations(scratch(files));
      expect(found.map(v => v.kind), `${file}: ${extra}`).toContain('outside-owner');
      expect(found.every(v => v.file === file), `${file}: ${extra}`).toBe(true);
    }
  });
});
