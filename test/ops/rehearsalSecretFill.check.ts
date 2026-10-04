import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

/**
 * Slice R0: the rehearsal secret fill covers every declared secret.
 *
 * `infra/modules/secrets/main.tf` declares the production secret names
 * (`local.secret_names`). `greenfield-release.yml` fills the rehearsal copies before
 * deploy, with a `case` over each name; a name the case does not know stops the step
 * ("this step does not know how to fill it"). That is a correct refusal, but it arrived
 * about 20 minutes into a rehearsal, after the plan and the create. This check moves it
 * to the pull request: a name added to the terraform alone fails here.
 *
 * The parsers take text, so the guard is itself tested against fixture strings.
 */

/**
 * Names that are declared and deliberately not filled by the loop. Each needs a reason
 * written next to it; there are none today. An entry here is a decision that a rehearsal
 * task will never name the secret.
 */
const NOT_FILLED_BY_THE_LOOP: Readonly<Record<string, string>> = {
  // 'example-name': 'why a rehearsal task can start without a value in it',
};

/** Terraform with `#`, `//` and block comments blanked; string literals are left alone. */
export function stripTerraformComments(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; ) {
    const here = text[at] ?? '';
    const pair = text.slice(at, at + 2);
    if (here === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(at, end + 1);
      at = end + 1;
    } else if (here === '#' || pair === '//') {
      while (at < text.length && text[at] !== '\n') at += 1;
    } else if (pair === '/*') {
      const end = text.indexOf('*/', at + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(at, stop).replace(/[^\n]/gu, ' ');
      at = stop;
    } else {
      out += here;
      at += 1;
    }
  }
  return out;
}

/**
 * The names in `locals { secret_names = [ ... ] }`. Only one shape is supported, the
 * shape the module has: ONE literal list of string literals, feeding ONE
 * `aws_secretsmanager_secret` resource through `for_each = toset(local.secret_names)`.
 * Anything else (a concat, a second list, a for_each over something else, a computed
 * entry) throws, because reading "the first literal" of a different structure would
 * undercount the secrets that exist.
 */
export function declaredSecretNames(terraform: string): string[] {
  const code = stripTerraformComments(terraform);
  const unsupported = (why: string): Error =>
    new Error(`infra/modules/secrets/main.tf has an unsupported secret inventory (${why}); extend rehearsalSecretFill.check.ts before changing its shape`);
  const assignments = [...code.matchAll(/(?<![\w.])secret_names\s*=/gu)];
  if (assignments.length === 0) throw new Error('infra/modules/secrets/main.tf has no `secret_names = [ ... ]` list');
  if (assignments.length > 1) throw unsupported('more than one secret_names assignment');
  const start = (assignments[0]?.index ?? 0) + (assignments[0]?.[0].length ?? 0);
  const rest = code.slice(start);
  const list = /^\s*\[([^\]]*)\]([^\n]*)/u.exec(rest);
  if (list === null) throw unsupported('secret_names is not a single literal list');
  // Nothing may follow the closing bracket: not on its line (`] + [...]`, `] != x ? ..`),
  // and not as the next token (a continued expression).
  if ((list[2] ?? '').trim() !== '') throw unsupported('something follows the secret_names list on its line');
  const after = rest.slice((list[0] ?? '').length).trimStart();
  if (/^[?:.[+\-*/%&|=!<>,]/u.test(after)) throw unsupported('the secret_names list continues into an expression');
  const names: string[] = [];
  for (const entry of (list[1] ?? '').split(',')) {
    const item = entry.trim();
    if (item === '') continue;
    const match = /^"([a-z0-9-]+)"$/u.exec(item);
    if (match === null) throw unsupported(`entry ${item} is not a plain string literal`);
    names.push(match[1] ?? '');
  }
  if (new Set(names).size !== names.length) throw unsupported('a name is listed twice');
  const resources = [...code.matchAll(/resource\s+"aws_secretsmanager_secret"\s+"[^"]+"\s*\{/gu)];
  if (resources.length !== 1) throw unsupported(`${String(resources.length)} aws_secretsmanager_secret resources, expected one`);
  const forEach = /resource\s+"aws_secretsmanager_secret"\s+"[^"]+"\s*\{\s*for_each\s*=([^\n]*)/u.exec(code);
  const expression = (forEach?.[1] ?? '').replace(/\s+/gu, '');
  if (expression !== 'toset(local.secret_names)') {
    throw unsupported(`the secret resource's for_each is \`${expression}\`, not exactly \`toset(local.secret_names)\``);
  }
  const mentions = [...code.matchAll(/(?<![\w.])local\.secret_names\b/gu)];
  if (mentions.length !== 1) throw unsupported('secret_names is used somewhere other than the one for_each');
  return names;
}

/** The names the fill loop's `case "$name" in` labels, from the loop over `secret_names`. */
export function filledSecretNames(workflow: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => line.includes('terraform output -json secret_names'));
  if (start === -1) throw new Error('the release workflow has no loop over `terraform output -json secret_names`');
  const caseAt = lines.findIndex((line, index) => index > start && /case "\$name" in/u.test(line));
  const esacAt = lines.findIndex((line, index) => index > caseAt && line.trim() === 'esac');
  if (caseAt === -1 || esacAt === -1) throw new Error('the fill loop has no `case "$name" in ... esac`');
  const names: string[] = [];
  const word = '["\']?[a-z0-9-]+["\']?';
  const label = new RegExp(`^\\s+(${word}(?:\\s*\\|\\s*${word})*)\\s*\\)`, 'u');
  for (const line of lines.slice(caseAt + 1, esacAt)) {
    if (line.trim().startsWith('#')) continue;
    const match = label.exec(line);
    if (match !== null) names.push(...(match[1] ?? '').split('|').map(part => part.trim().replace(/["']/gu, '')));
  }
  return names;
}

/** Declared names that neither the loop nor the commented exclusion list covers. */
export function uncoveredSecretNames(
  declared: readonly string[],
  filled: readonly string[],
  excluded: Readonly<Record<string, string>>,
): string[] {
  return declared.filter(name => !filled.includes(name) && !Object.hasOwn(excluded, name));
}

const TERRAFORM = readRepositoryFile('infra/modules/secrets/main.tf');
const RELEASE = readRepositoryFile('.github/workflows/greenfield-release.yml');

describe('the rehearsal fills every secret the stack declares', () => {
  it('covers each declared name, in the loop or in the commented exclusion list', () => {
    const declared = declaredSecretNames(TERRAFORM);
    const filled = filledSecretNames(RELEASE);
    // Not vacuous: both parsers found the real lists.
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(filled.length).toBeGreaterThanOrEqual(10);
    const missing = uncoveredSecretNames(declared, filled, NOT_FILLED_BY_THE_LOOP);
    expect(
      missing,
      `infra/modules/secrets/main.tf declares ${missing.join(', ')}, which the rehearsal fill in ` +
        '.github/workflows/greenfield-release.yml does not know ("Fill every secret entry this run\'s tasks resolve"). ' +
        'A rehearsal would fail about 20 minutes in. Add the name to that `case` with a rehearsal fixture of the shape ' +
        'the code parses, or to NOT_FILLED_BY_THE_LOOP in this test with the reason.',
    ).toEqual([]);
  });

  it('keeps the exclusion list honest: every excluded name is declared and not also filled', () => {
    const declared = declaredSecretNames(TERRAFORM);
    const filled = filledSecretNames(RELEASE);
    for (const [name, reason] of Object.entries(NOT_FILLED_BY_THE_LOOP)) {
      expect(reason.trim(), `${name} is excluded without a reason`).not.toBe('');
      expect(declared, `${name} is excluded but the terraform no longer declares it`).toContain(name);
      expect(filled, `${name} is excluded but the loop fills it`).not.toContain(name);
    }
  });

  it('fails when a name is added to the terraform alone (fixture)', () => {
    const withDummy = TERRAFORM.replace('"app-runtime-database",', '"app-runtime-database",\n    "dummy-new-secret",');
    expect(withDummy).not.toBe(TERRAFORM);
    const declared = declaredSecretNames(withDummy);
    expect(declared).toContain('dummy-new-secret');
    expect(uncoveredSecretNames(declared, filledSecretNames(RELEASE), NOT_FILLED_BY_THE_LOOP)).toEqual(['dummy-new-secret']);
  });

  it('passes the same name once the loop, or the exclusion list, covers it (fixture)', () => {
    const withDummy = TERRAFORM.replace('"app-runtime-database",', '"app-runtime-database",\n    "dummy-new-secret",');
    const declared = declaredSecretNames(withDummy);
    const covered = RELEASE.replace('twilio-voice|calcom|transcription|zoom-meetings)', 'twilio-voice|calcom|transcription|zoom-meetings|dummy-new-secret)');
    expect(covered).not.toBe(RELEASE);
    expect(uncoveredSecretNames(declared, filledSecretNames(covered), {})).toEqual([]);
    expect(uncoveredSecretNames(declared, filledSecretNames(RELEASE), { 'dummy-new-secret': 'fixture' })).toEqual([]);
  });

  it('refuses a terraform or workflow it cannot read rather than passing', () => {
    expect(() => declaredSecretNames('locals {}')).toThrow(/no `secret_names/u);
    expect(() => filledSecretNames('steps: []')).toThrow(/no loop over/u);
  });

  const block = (list: string): string => `locals {\n  secret_names = [\n${list}\n  ]\n}\nresource "aws_secretsmanager_secret" "this" {\n  for_each = toset(local.secret_names)\n}\n`;

  it('ignores every comment style and tolerates several entries per line', () => {
    const text = block('    # "old-one",\n    // "old-two",\n    /* "old-three",\n    "old-four", */\n    "a-1", "b-2",\n    "c-3", # trailing');
    expect(declaredSecretNames(text)).toEqual(['a-1', 'b-2', 'c-3']);
    const old = `/*\nlocals {\n  secret_names = ["stale"]\n}\n*/\n${block('    "real",')}`;
    expect(declaredSecretNames(old)).toEqual(['real']);
  });

  it('refuses inventory structures it does not understand instead of reading the first literal', () => {
    const base = block('    "a-1",');
    const cases = [
      base.replace('toset(local.secret_names)', 'toset(concat(local.secret_names, ["extra"]))'),
      base.replace('toset(local.secret_names)', 'toset(local.other_names)'),
      `${base}locals {\n  secret_names = ["b-2"]\n}\n`,
      block('    "a-1",\n    var.more,'),
      block('    "a-1",\n    "a-1",'),
      `${base}resource "aws_secretsmanager_secret" "second" {\n  for_each = toset(local.secret_names)\n}\n`,
      base.replace('secret_names = [', 'secret_names = concat(["x"], ['),
      `${base}locals {\n  more = local.secret_names\n}\n`,
      // The follow-up review's two mutations, and a continued list.
      base.replace('toset(local.secret_names)', 'toset(local.secret_names) != toset([]) ? toset(["new-secret"]) : toset([])'),
      base.replace('\n  ]\n}', '\n  ] != [] ? ["new-secret"] : []\n}'),
      base.replace('\n  ]\n}', '\n  ]\n  + ["new-secret"]\n}'),
    ];
    for (const text of cases) expect(() => declaredSecretNames(text), text).toThrow();
    expect(declaredSecretNames(base)).toEqual(['a-1']);
    // Whitespace inside the exact expression is fine.
    expect(declaredSecretNames(base.replace('toset(local.secret_names)', 'toset( local.secret_names )  '))).toEqual(['a-1']);
  });

  it('reads case labels with spaces around the bar, several per line, quotes and comment lines', () => {
    const loop = (labels: string): string =>
      `terraform output -json secret_names | python3 -c x\n  case "$name" in\n          # note\n          ${labels}) value='{}' ;;\n          other) value=1 ;;\n          *) exit 1 ;;\n  esac\n`;
    expect(filledSecretNames(loop('twilio-voice | calcom | transcription'))).toEqual(['twilio-voice', 'calcom', 'transcription', 'other']);
    expect(filledSecretNames(loop('"quoted-name"|plain'))).toEqual(['quoted-name', 'plain', 'other']);
  });
});

