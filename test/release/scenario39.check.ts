import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 39: "Production and rehearsal Terraform plans use distinct state keys,
 * roles, secrets and resource namespaces; rehearsal teardown cannot address
 * production resources."
 *
 * Half of this is checkable offline and the two `isolation.tftest.hcl` suites check
 * it: each root pins its own name prefix, refuses the other's, and asserts no
 * resource name carries the neighbour's string. The other half — that a rehearsal
 * teardown *cannot* reach a production resource — is an IAM boundary, and no plan
 * proves an IAM boundary, which is why `rehearsal-prefix-guard.sh` runs after
 * teardown in the rehearsal and why this check insists the workflow calls it.
 *
 * ## The vacuous-pass trap
 *
 * Two plans that differ in every value are isolated by accident rather than by
 * construction: change one variable and the accident evaporates, and no offline test
 * notices. Closed by pinning the two things that must be structurally different —
 * the state key prefix and the name prefix — and by asserting each root refuses the
 * other's prefix explicitly, so isolation is a rule the plan enforces rather than a
 * coincidence of the values somebody typed.
 */

describe('Appendix G 39: the two roots cannot address each other', () => {
  mustBeRehearsed(39);

  it('pins two different state-key prefixes, and the gate compares them', () => {
    const keyOf = (backend: string): string => {
      const line = backend.split('\n').find(row => row.trimStart().startsWith('key '));
      return (line ?? '').split('"')[1] ?? '';
    };
    const production = keyOf(readRepositoryFile('infra/roots/production/backend.hcl'));
    const rehearsal = keyOf(readRepositoryFile('infra/roots/rehearsal/backend.hcl'));

    expect(production).toBe('fss/greenfield/production/terraform.tfstate');
    expect(rehearsal.startsWith('fss/greenfield/rehearsal/')).toBe(true);
    expect(rehearsal).not.toBe(production);

    // The comparison is in the gate rather than only here, so a hand-run of the
    // offline gate catches it too.
    const gate = readRepositoryFile('infra/scripts/offline-gate.sh');
    expect(gate).toContain('if [ "$production_key" = "$rehearsal_key" ]; then');
    expect(gate).toContain('fss/greenfield/production/*');
    expect(gate).toContain('fss/greenfield/rehearsal/*');
  });

  it('makes each root refuse the other’s namespace rather than merely avoid it', () => {
    const production = readRepositoryFile('infra/roots/production/tests/isolation.tftest.hcl');
    const rehearsal = readRepositoryFile('infra/roots/rehearsal/tests/isolation.tftest.hcl');

    expect(production).toContain('output.name_prefix == "fss-prod"');
    expect(production).toContain('output.deployment_role_name == "fss-prod-deploy"');
    expect(production).toContain('run "a_rehearsal_prefix_is_refused"');
    expect(production).toContain('expect_failures');

    expect(rehearsal).toContain('startswith(output.name_prefix, "fss-rh-")');
    expect(rehearsal).toContain('run "the_production_prefix_is_refused"');
    // A prefix that merely looks like production's is refused too, which is the
    // difference between a rule and a string comparison somebody got lucky with.
    expect(rehearsal).toContain('run "a_prefix_that_merely_starts_like_production_is_refused"');
    expect(rehearsal).toContain('expect_failures');
  });
});
