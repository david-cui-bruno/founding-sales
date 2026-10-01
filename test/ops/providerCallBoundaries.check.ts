import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Slice R0: static bypass checks for the final provider-call boundaries.
 *
 * Each outside call is made at ONE authoritative site, after every gate that decides
 * whether it may happen (suppression, switches, clearance, budget, the paid-call
 * reservation). A second call site is a way around those gates, and nothing else in the
 * suite notices one. This reads the source (tests excluded) and fails when a call
 * expression for a boundary appears anywhere but its site.
 *
 * What is matched: call expressions on a member (`x.sendMessage(`, `x?.sendMessage(`,
 * `x['sendMessage'](`, `x.sendMessage.call(`), after comments are blanked. Not matched:
 * the definitions and type declarations (`sendMessage(access: ...): Promise<...>` has no
 * receiver), and bare calls of an unrelated local function of the same name
 * (`crm/import.ts` has its own `classify(`). Not caught, by the nature of a text check:
 * a method pulled off its object first (`const { sendMessage } = gmail`) and called bare.
 * Review still looks for that; the member form is how every call today is written.
 */

interface Boundary {
  /** What the boundary is, for the failure message. */
  readonly name: string;
  /** The method names whose member calls are the provider call. */
  readonly methods: readonly string[];
  /** The one file allowed to call them, repository-relative. */
  readonly site: string;
  /** The function in that file that owns the call. */
  readonly owner: string;
}

export const BOUNDARIES: readonly Boundary[] = [
  {
    name: 'Gmail send',
    methods: ['sendMessage'],
    site: 'packages/domain/outbound/send.ts',
    owner: 'dispatchOutboundMessage',
  },
  {
    name: 'research provider calls (page fetch, token count, extraction)',
    methods: ['fetchPages', 'countInputTokens', 'extract'],
    site: 'packages/domain/research/enrichment.ts',
    owner: 'finishFirmResearch',
  },
  {
    name: 'reply classifier provider',
    methods: ['classify'],
    site: 'packages/domain/classification/classify.ts',
    owner: 'classifyReplyWithModel',
  },
  {
    name: 'call transcription provider',
    methods: ['transcribe'],
    site: 'packages/domain/calls/transcription.ts',
    owner: 'finishCallTranscription',
  },
];

/**
 * A call site allowed somewhere else. Each entry needs a REASON that says why the call
 * cannot go through the boundary and what gates it instead; "it is convenient" is not
 * one. There are none today. Adding an entry is a review decision, not a way to make this
 * check green.
 */
export interface Allowed {
  readonly file: string;
  readonly method: string;
  readonly reason: string;
}
export const ALLOWED_ELSEWHERE: readonly Allowed[] = [
  // { file: 'packages/domain/x/y.ts', method: 'sendMessage', reason: 'why, and what gates it' },
];

const ROOTS = ['apps', 'packages', 'tools', 'scripts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', '.git']);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const TEST_FILE = /\.(?:test|check|spec)\.[a-z]+$/u;

/** Blank comments, keeping offsets and newlines, so a commented-out call is not a call. */
export function blankComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, block => block.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, (whole, lead: string) => lead + ' '.repeat(whole.length - lead.length));
}

/** Member-call expressions of `method` in `text`: the line numbers. */
export function callLines(text: string, method: string): number[] {
  const code = blankComments(text);
  const patterns = [
    new RegExp(`\\??\\.\\s*${method}\\s*\\(`, 'gu'),
    new RegExp(`\\??\\.\\s*${method}\\s*\\??\\.\\s*(?:call|apply)\\s*\\(`, 'gu'),
    new RegExp(`\\[\\s*['"\`]${method}['"\`]\\s*\\]\\s*\\??\\.?\\s*\\(`, 'gu'),
  ];
  const lines = new Set<number>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      lines.add(code.slice(0, match.index).split('\n').length);
    }
  }
  return [...lines].sort((a, b) => a - b);
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
}

/** Every call of a boundary's method outside its site and the allow-list, under `root`. */
export function findViolations(
  root: string,
  boundaries: readonly Boundary[] = BOUNDARIES,
  allowed: readonly Allowed[] = ALLOWED_ELSEWHERE,
): Violation[] {
  const violations: Violation[] = [];
  for (const top of ROOTS) {
    for (const path of sourceFiles(join(root, top))) {
      const file = relative(root, path).split('\\').join('/');
      const text = readFileSync(path, 'utf8');
      for (const boundary of boundaries) {
        for (const method of boundary.methods) {
          if (file === boundary.site) continue;
          if (allowed.some(entry => entry.file === file && entry.method === method)) continue;
          for (const line of callLines(text, method)) {
            violations.push({ boundary: boundary.name, file, line, method });
          }
        }
      }
    }
  }
  return violations;
}

function describeViolations(violations: readonly Violation[], boundaries: readonly Boundary[] = BOUNDARIES): string {
  return violations
    .map(violation => {
      const boundary = boundaries.find(candidate => candidate.name === violation.boundary);
      return (
        `${violation.file}:${String(violation.line)} calls .${violation.method}(, the ${violation.boundary} boundary. ` +
        `That call is made only in ${boundary?.site ?? '?'} (${boundary?.owner ?? '?'}), after every gate; ` +
        'new call sites must go through it. If this one truly cannot, add it to ALLOWED_ELSEWHERE in ' +
        'test/ops/providerCallBoundaries.check.ts with the reason and what gates it instead.'
      );
    })
    .join('\n');
}

const REPOSITORY = repositoryPath('');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A scratch tree: a copy of each boundary's site plus the given extra files. */
function scratch(extra: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'fss-boundaries-'));
  temporary.push(root);
  for (const boundary of BOUNDARIES) {
    const target = join(root, boundary.site);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(REPOSITORY, boundary.site), 'utf8'), 'utf8');
  }
  for (const [file, text] of Object.entries(extra)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  return root;
}

describe('each provider call is made at its one authoritative site', () => {
  it('has no call to any boundary outside its site', () => {
    const violations = findViolations(REPOSITORY);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('is not vacuous: every boundary method is still called at its site', () => {
    for (const boundary of BOUNDARIES) {
      const text = readFileSync(join(REPOSITORY, boundary.site), 'utf8');
      expect(text, `${boundary.site} no longer defines ${boundary.owner}`).toMatch(
        new RegExp(`function\\s+${boundary.owner}\\b`, 'u'),
      );
      for (const method of boundary.methods) {
        expect(
          callLines(text, method).length,
          `${boundary.site} no longer calls .${method}(; the boundary moved, so update this check's table`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps each allow-list entry reasoned and real', () => {
    for (const entry of ALLOWED_ELSEWHERE) {
      expect(entry.reason.trim().length, `${entry.file} (${entry.method}) is allowed without a reason`).toBeGreaterThan(20);
      expect(readFileSync(join(REPOSITORY, entry.file), 'utf8')).toContain(entry.method);
    }
  });
});

describe('the check itself', () => {
  const second = (call: string): string => `export async function sneaky(x: any) {\n  return await ${call};\n}\n`;

  it('fails on a second call to each boundary in a scratch file, naming the boundary', () => {
    const cases: readonly [string, string, string][] = [
      ['Gmail send', 'sendMessage', 'gmail.sendMessage(grant, request)'],
      ['research provider calls (page fetch, token count, extraction)', 'fetchPages', 'deps.pageFetch.fetchPages({ urls })'],
      ['research provider calls (page fetch, token count, extraction)', 'countInputTokens', 'extraction.countInputTokens(request)'],
      ['research provider calls (page fetch, token count, extraction)', 'extract', 'extraction.extract(request)'],
      ['reply classifier provider', 'classify', 'deps.classifierFor(settings).classify(input)'],
      ['call transcription provider', 'transcribe', 'provider.transcribe({ audio })'],
    ];
    for (const [boundary, method, call] of cases) {
      const root = scratch({ 'apps/worker/src/sneaky.ts': second(call) });
      const violations = findViolations(root);
      expect(violations.map(v => [v.boundary, v.file, v.method])).toEqual([[boundary, 'apps/worker/src/sneaky.ts', method]]);
      const message = describeViolations(violations);
      expect(message).toContain(boundary);
      expect(message).toContain('new call sites must go through it');
    }
  });

  it('fails on a second call inside the boundary file’s own package, and on the other spellings', () => {
    for (const call of [
      'gmail?.sendMessage(grant, request)',
      "gmail['sendMessage'](grant, request)",
      'gmail.sendMessage.call(gmail, grant, request)',
      'gmail\n    .sendMessage(grant, request)',
    ]) {
      const root = scratch({ 'packages/domain/outbound/other.ts': second(call) });
      expect(findViolations(root).map(v => v.method), call).toEqual(['sendMessage']);
    }
  });

  it('does not fail on definitions, types, comments, tests or an unrelated bare function', () => {
    const root = scratch({
      'packages/domain/mail/client.ts': 'export interface C {\n  sendMessage(access: A, request: R): Promise<O>;\n}\n',
      'packages/domain/crm/import.ts': 'async function classify(a: A) { return a; }\nawait classify(context);\n',
      'apps/api/src/note.ts': '// gmail.sendMessage(grant, request) is only made in send.ts\n/* x.transcribe(y) */\nexport const a = 1;\n',
      'apps/api/test/second.test.ts': second('gmail.sendMessage(grant, request)'),
      'packages/domain/test/helper.ts': second('gmail.sendMessage(grant, request)'),
      'apps/worker/src/fake.check.ts': second('provider.transcribe(x)'),
    });
    expect(findViolations(root)).toEqual([]);
  });

  it('honours an allow-list entry, and only for that file and method', () => {
    const root = scratch({ 'apps/worker/src/sneaky.ts': second('gmail.sendMessage(g, r); provider.transcribe(x)') });
    const allowed: readonly Allowed[] = [{ file: 'apps/worker/src/sneaky.ts', method: 'sendMessage', reason: 'fixture reason that is long enough' }];
    expect(findViolations(root, BOUNDARIES, allowed).map(v => v.method)).toEqual(['transcribe']);
  });

  it('blanks comments without hiding the call after them', () => {
    expect(callLines('// a.sendMessage(x)\nb.sendMessage(y);\n/* c.sendMessage(z) */', 'sendMessage')).toEqual([2]);
    expect(callLines("const url = 'https://x.example/'; a.sendMessage(y);", 'sendMessage')).toEqual([1]);
  });
});
