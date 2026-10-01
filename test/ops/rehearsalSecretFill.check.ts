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

/** The names in `locals { secret_names = [ ... ] }`, comments and blank lines ignored. */
export function declaredSecretNames(terraform: string): string[] {
  const block = /secret_names\s*=\s*\[([\s\S]*?)\n\s*\]/u.exec(terraform);
  if (block === null) throw new Error('infra/modules/secrets/main.tf has no `secret_names = [ ... ]` list');
  const names: string[] = [];
  for (const raw of (block[1] ?? '').split('\n')) {
    const line = raw.replace(/#.*$/u, '').trim();
    if (line === '') continue;
    const match = /^"([a-z0-9-]+)",?$/u.exec(line);
    if (match === null) throw new Error(`unreadable entry in secret_names: ${raw.trim()}`);
    names.push(match[1] ?? '');
  }
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
  for (const line of lines.slice(caseAt + 1, esacAt)) {
    const match = /^\s{10,}([a-z0-9-]+(?:\|[a-z0-9-]+)*)\)/u.exec(line);
    if (match !== null) names.push(...(match[1] ?? '').split('|'));
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
    const covered = RELEASE.replace('twilio-voice|calcom|transcription)', 'twilio-voice|calcom|transcription|dummy-new-secret)');
    expect(covered).not.toBe(RELEASE);
    expect(uncoveredSecretNames(declared, filledSecretNames(covered), {})).toEqual([]);
    expect(uncoveredSecretNames(declared, filledSecretNames(RELEASE), { 'dummy-new-secret': 'fixture' })).toEqual([]);
  });

  it('refuses a terraform or workflow it cannot read rather than passing', () => {
    expect(() => declaredSecretNames('locals {}')).toThrow(/no `secret_names/u);
    expect(() => filledSecretNames('steps: []')).toThrow(/no loop over/u);
  });
});
