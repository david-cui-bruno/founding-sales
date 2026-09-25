import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * Terraform creates every Secrets Manager entry empty and never holds a value, and an
 * ECS task whose `secrets` block names an entry with no value does not start at all —
 * `ResourceInitializationError … can't find the specified secret value for staging
 * label: AWSCURRENT`, before the container exists. Every task definition but the
 * migration's names all eight entries. Run 35891175510 (23 September 2026) migrated the
 * database, created the runtime user, and then could not start `fss verify`, because
 * the rehearsal had filled the two database entries and nothing else — and the
 * production order in release.md 5 said to fill the other six after the first deploy.
 *
 * So: the stack's list is the input, and the rehearsal step must know how to fill every
 * name on it.
 */

const NAMES_BLOCK = /variable "secret_names" \{[\s\S]*?default = \[([\s\S]*?)\]/u;

function stackSecretNames(): readonly string[] {
  const variables = readRepositoryFile('infra/modules/stack/variables.tf');
  const block = NAMES_BLOCK.exec(variables);
  expect(block, 'infra/modules/stack/variables.tf declares secret_names with a default list').not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/"([a-z-]+)"/gu)].map(match => match[1] ?? '');
}

function fillStep(): string {
  const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
  const start = workflow.indexOf("- name: Fill every secret entry this run's tasks resolve");
  expect(start, 'the fill step exists under that name').toBeGreaterThan(0);
  const next = workflow.indexOf('\n      - name: ', start + 10);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe('every secret entry is filled before a task can name it', () => {
  it('the stack declares eight entries, the two database ones last', () => {
    const names = stackSecretNames();
    expect(names).toHaveLength(8);
    expect(names.slice(-2)).toEqual(['migration-database', 'app-runtime-database']);
  });

  it('the rehearsal fill step reads the list from the stack and knows how to fill every name on it', () => {
    const step = fillStep();
    expect(step).toContain('terraform output -json secret_names');
    for (const name of stackSecretNames()) {
      // Each name appears in a `case` arm (the two database ones in the skip arm,
      // because the step filled them with real values just above).
      expect(step, name).toMatch(new RegExp(`^\\s+(?:[a-z-]+\\|)*${name}(?:\\|[a-z-]+)*\\)`, 'mu'));
    }
    // A ninth name would not be left empty in silence.
    expect(step).toMatch(/\*\)\s*\n\s*echo "::error::/u);
    // Fixtures are masked and written by name under this run's prefix; never a literal credential.
    expect(step).toContain('echo "::add-mask::$value"');
    expect(step).toContain('--secret-id "${prefix}/${name}"');
    expect(step).not.toMatch(/client_secret":"[A-Za-z0-9+/=]{20,}"/u);
  });
});
