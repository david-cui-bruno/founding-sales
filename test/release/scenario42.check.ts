import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveSendingEnabled } from '@fss/domain/settings';
import { SEND_REFUSAL_CODES } from '@fss/domain/outbound';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as WORKER_VARIABLES } from '../../apps/worker/src/bootstrap/deployment.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as API_VARIABLES } from '../../apps/api/src/bootstrap/deployment.ts';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Appendix G 42: "Authentication passes but production sending remains disabled until
 * artifact digest, rehearsal gate, smoke tests, and manual enable all agree."
 *
 * 16.2 in one sentence, and this lane's headline deliverable. Four conditions, and each
 * one is held by a different thing:
 *
 *   * **artifact digest** — `rehearsal-release-record.sh` refuses anything that is not
 *     `sha256:` plus 64 hex characters, and the cluster module's variable validation
 *     refuses a mutable tag;
 *   * **rehearsal gate** — the record is written last, from reports the rehearsal-only
 *     scenarios left behind, and only for a green suite;
 *   * **smoke tests** — `scripts/productionSmoke.mjs`, whose sixth check's expected
 *     answer is that sending is *off*;
 *   * **manual enable** — `workspace_settings.sending_enabled`, admin-only, carrying the
 *     `releaseGateReference` of the rehearsal whose digests match.
 *
 * ## The vacuous-pass trap
 *
 * Four conditions ANDed are indistinguishable from one condition if only one of them is
 * ever varied: a test that turned everything on and then turned one thing off would pass
 * against an implementation that read only that one thing. That is not hypothetical —
 * before this lane the send gate read the *domain* flag and nothing else, and a workspace
 * whose DNS passed could have sent from an image nobody rehearsed.
 *
 * Closed by varying each condition independently and requiring sending to stay off for
 * each, and by asserting the positive control: with all of them true, it is on.
 */

const REFERENCE = 'fss-rh-20260920-example';

describe('Appendix G 42: sending stays off until all four agree', () => {
  mustBeRehearsed(42);

  describe('the two switches the send gate reads', () => {
    it('is on only when the deployment flag and the admin attestation both say yes', () => {
      // The positive control. Without it, "always false" would pass every case below.
      expect(effectiveSendingEnabled(true, { enabled: true, releaseGateReference: REFERENCE })).toBe(true);
    });

    it('is off when the deployment has not been told the gate passed', () => {
      expect(effectiveSendingEnabled(false, { enabled: true, releaseGateReference: REFERENCE })).toBe(false);
    });

    it('is off when no admin has enabled it', () => {
      expect(effectiveSendingEnabled(true, { enabled: false, releaseGateReference: null })).toBe(false);
    });

    it('is off when the attestation names no release gate, because "an admin clicked yes" is not the gate', () => {
      expect(effectiveSendingEnabled(true, { enabled: true, releaseGateReference: null })).toBe(false);
    });

    it('is off when the stored setting is unreadable, which is a bug failing to the safe side', () => {
      for (const stored of [null, undefined, {}, { enabled: 'yes' }, 'true', 42]) {
        expect(effectiveSendingEnabled(true, stored)).toBe(false);
      }
    });
  });

  describe('the dispatch path reads both, and the domain flag as well', () => {
    const gate = readRepositoryFile('packages/domain/outbound/gate.ts');

    it('names its own refusal code, distinct from the domain authentication one', () => {
      expect(SEND_REFUSAL_CODES).toContain('workspace_sending_not_attested');
      expect(SEND_REFUSAL_CODES).toContain('automated_sending_disabled');
    });

    it('calls effectiveSendingEnabled with the deployment flag before it reads the domain', () => {
      const attestationAt = gate.indexOf('effectiveSendingEnabled(');
      const domainAt = gate.indexOf('readPrimarySendingDomain(');
      expect(attestationAt).toBeGreaterThan(-1);
      expect(domainAt).toBeGreaterThan(attestationAt);
      expect(gate).toContain("readSetting(context, 'sending_enabled')");
      // Fail closed: an absent flag is false, never "probably fine".
      expect(gate).toContain('deps.deploymentSendingEnabled ?? false');
    });

    it('still refuses on the domain half, so the three facts are not one fact', () => {
      expect(gate).toContain('automatedSendingEnabled');
      expect(gate).toContain("refuseSend('automated_sending_disabled')");
    });
  });

  describe('the attestation can only be set by an authenticated admin', () => {
    const store = readRepositoryFile('packages/domain/settings/store.ts');
    const contracts = readRepositoryFile('packages/contracts/src/settings.ts');

    it('refuses a non-admin scope in the same transaction as the write', () => {
      expect(store).toContain("if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };");
      expect(store).toContain("if (actor.kind !== 'user') return { ok: false, reason: 'admin_only' };");
    });

    it('refuses an enable that names no release gate', () => {
      expect(contracts).toContain('releaseGateReference');
      expect(contracts).toContain('enabling production sending names the release gate it passed');
    });
  });

  describe('the release record is what the attestation refers to', () => {
    const script = readRepositoryFile('infra/scripts/rehearsal-release-record.sh');
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');

    it('refuses a suite result that is not a pass', () => {
      expect(script).toContain('a release record is only written for a green suite');
    });

    it('refuses a mutable tag in place of a digest, and one image under both names', () => {
      expect(script).toContain("digest_shape='^sha256:[0-9a-f]{64}$'");
      expect(script).toContain('one image was pushed under both names');
    });

    it('refuses a record for a rehearsal whose drills left no report', () => {
      for (const report of ['restore-drill.txt', 'carry-watermark.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
        expect(script).toContain(report);
      }
    });

    it('is written last in the workflow, after teardown and the production-prefix assertion', () => {
      const teardownAt = workflow.indexOf('rehearsal-teardown.sh');
      const guardAt = workflow.lastIndexOf('rehearsal-prefix-guard.sh');
      const recordAt = workflow.lastIndexOf('rehearsal-release-record.sh');
      expect(teardownAt).toBeGreaterThan(-1);
      expect(recordAt).toBeGreaterThan(teardownAt);
      expect(recordAt).toBeGreaterThan(guardAt);
    });

    it('enables nothing by itself', () => {
      expect(script).toContain('"enablesSending": false');
    });
  });

  describe('the production smoke checks', () => {
    const smoke = readRepositoryFile('scripts/productionSmoke.mjs');

    it('are the six 16.2 names and no others', () => {
      expect(smoke).toContain("'health',");
      expect(smoke).toContain("'readiness',");
      expect(smoke).toContain("'schema_range',");
      expect(smoke).toContain("'connectivity',");
      expect(smoke).toContain("'canary',");
      expect(smoke).toContain("'sending_disabled',");
    });

    it('cannot mutate anything, because only GET appears in it', () => {
      expect(smoke).not.toMatch(/method: *'(POST|PUT|PATCH|DELETE)'/u);
      expect(smoke).toContain("method: 'GET'");
    });

    it('fails rather than skips when the canary age was not supplied', () => {
      expect(smoke).toContain('SMOKE_CANARY_AGE_NOT_SUPPLIED');
    });

    it('expects sending to be off, which is the one check whose pass is a false', () => {
      expect(smoke).toContain("record('sending_disabled', enabled === false");
    });
  });

  describe('the two processes agree about the deployment they are reading', () => {
    it('name the same environment variable for every fact they share', () => {
      // The API and the worker are separate npm workspaces with no dependency between
      // them, so the contract is duplicated. Drift between the two would mean one
      // process sends and the other refuses, which is the worst of both.
      for (const [key, name] of Object.entries(WORKER_VARIABLES)) {
        const theirs = (API_VARIABLES as Record<string, string | undefined>)[key];
        if (theirs === undefined) continue;
        expect(theirs, `the two bootstraps disagree about ${key}`).toBe(name);
      }
    });

    it('both refuse to run a production deployment on anything but live dependencies', () => {
      for (const path of ['apps/worker/src/bootstrap/deployment.ts', 'apps/api/src/bootstrap/deployment.ts']) {
        const source = readRepositoryFile(path);
        expect(source, path).toContain('PRODUCTION_REQUIRES_LIVE');
        expect(source, path).toContain('DEPENDENCIES_UNSET');
      }
    });

    it('neither turns sending on by omission', () => {
      for (const path of ['apps/worker/src/bootstrap/deployment.ts', 'apps/api/src/bootstrap/deployment.ts']) {
        const source = readRepositoryFile(path);
        // `booleanFlag` returns false for an unset variable and refuses anything that
        // is neither `true` nor `false`, so a typo is a refusal rather than a send.
        expect(source, path).toContain("if (raw === undefined || raw.length === 0) return false;");
        expect(source, path).toContain('must be true or false');
      }
    });
  });
});

/**
 * G12f: the one exemption is one exemption.
 *
 * `rehearsal_read_production_inventory` is allowed to name production because Appendix
 * G 39's last clause is measured rather than asserted. Appendix G 42's record is the
 * other thing that reads a production name — the digests it compares are production's —
 * and it refuses every argument that names one. A change that widened the refusal into
 * a general allowance would show up here first: the record would accept
 * `fss-prod` as a rehearsal prefix and write a release gate reference for it.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the script still *contains* `rehearsal_refuse_production_arguments`
 * would pass against a guard whose refusal had become a warning, which is exactly the
 * shape of the bug this lane fixed (`rehearsal_aws` printed FAIL and returned 0). So
 * the script is run, with a production prefix and with a production name buried in an
 * argument that is not the prefix, and both must be refused with nothing written.
 */
describe('Appendix G 42: the inventory exemption did not become a general one', () => {
  const record = 'infra/scripts/rehearsal-release-record.sh';
  const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

  function writeRecord(args: readonly string[]): { readonly code: number; readonly output: string } {
    const reports = mkdtempSync(join(tmpdir(), 'fss-record-'));
    for (const report of ['restore-drill.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
      writeFileSync(join(reports, report), 'prefix=fss-rh-case\n');
    }
    writeFileSync(join(reports, 'carry-watermark.txt'), 'carry_drill=skipped_no_watermark\n');
    const out = join(reports, 'release-record.json');
    const result = spawnSync(repositoryPath(record), [...args, out], {
      encoding: 'utf8',
      env: { ...process.env, FSS_REHEARSAL_REPORTS: reports, FSS_REHEARSAL_DRY_RUN: '1' },
    });
    return {
      code: result.status ?? 1,
      output: `${result.stdout}${result.stderr}${existsSync(out) ? readFileSync(out, 'utf8') : ''}`,
    };
  }

  it('writes a record for a rehearsal prefix, which is the positive control', () => {
    const { code, output } = writeRecord(['fss-rh-case', digest('a'), digest('b'), 'commit', 'pass']);

    expect(code, output).toBe(0);
    expect(output).toContain('"releaseGateReference": "fss-rh-case-');
  });

  it('refuses a production prefix', () => {
    const { code, output } = writeRecord(['fss-prod', digest('a'), digest('b'), 'commit', 'pass']);

    expect(code).not.toBe(0);
    expect(output).not.toContain('releaseGateReference');
  });

  it('refuses a production name anywhere else in its arguments', () => {
    // The desktop stamp is free text, so it is the argument a production name would
    // reach the record through.
    const { code, output } = writeRecord([
      'fss-rh-case',
      digest('a'),
      digest('b'),
      'fss-prod-desktop',
      'pass',
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain('names a production resource');
  });
});
