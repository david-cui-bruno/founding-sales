import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The release build path, as a file that can be read rather than a run that can be
 * watched (G13b deliverables 1 and 2).
 *
 * Nobody here can run this workflow: the signing identity, the Apple credentials and
 * the update key exist only as David's repository secrets, and the release job is the
 * only place they are ever present. What can be checked, on every change, is the
 * shape of the thing that will run — which is where the mistakes that matter live:
 *
 *   * an action reference that floats, so a later commit under the same tag runs on a
 *     runner holding a Developer ID certificate;
 *   * a secret on a line that is not an `env:` mapping, which is a secret one `set -x`
 *     away from a log;
 *   * a build whose provenance cannot be checked afterwards — a dirty tree, a
 *     placeholder version, or a stamp that is not the commit the release record names;
 *   * an artifact that never leaves the runner, which is the state this lane found.
 *
 * Every assertion below is about one of those. None of them proves the workflow
 * succeeds; that is what running it proves, and it has not been run.
 */

const workflow = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/greenfield-desktop.yml', import.meta.url)), 'utf8');

/**
 * `actions/upload-artifact` v4.6.2, resolved on 20 September 2026 with
 * `git ls-remote --tags https://github.com/actions/upload-artifact.git`: both
 * `refs/tags/v4.6.2` and `refs/tags/v4` point at this object and neither has a peeled
 * `^{}` entry, so it is a commit rather than an annotated tag.
 * `docs/decisions/g13b-the-artifact-leaves-on-a-pinned-action.md`.
 */
const UPLOAD_ARTIFACT = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';

/**
 * One job's text. Anchored, because `      release:` is the workflow_dispatch input
 * and an unanchored search for the job finds that first.
 */
function job(name: 'host' | 'release'): string {
  const start = new RegExp(`^ {2}${name}:$`, 'mu').exec(workflow)?.index;
  if (start === undefined) throw new Error(`the workflow declares no ${name} job`);
  const rest = workflow.slice(start + 1);
  const end = /^ {2}\w+:$/mu.exec(rest)?.index;
  return end === undefined ? rest : rest.slice(0, end);
}

describe('the desktop workflow pins what it runs', () => {
  it('references every action by a full commit sha, never by a tag', () => {
    const references = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map(match => match[1] ?? '');

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference, reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
    }
  });

  it('carries the artifact away on the digest this lane checked', () => {
    expect(workflow).toContain(UPLOAD_ARTIFACT);
  });
});

describe('the release job refuses before it builds something it cannot publish', () => {
  it('names FSS_UPDATE_CHANNEL_URL, which does not exist until the production apply', () => {
    // The Mac reads its update channel from a value compiled into the build. Without
    // one, a release would install and then never update — and the variable is absent
    // on purpose until CloudFront exists, so the refusal has to name it rather than
    // default to a hostname nobody applied.
    expect(workflow).toMatch(/FSS_UPDATE_CHANNEL_URL[\s\S]{0,400}?absent repository variables/u);
  });

  it('refuses a placeholder version', () => {
    expect(workflow).toContain('0.0.0');
  });

  it('refuses a dirty tree before packaging, not after', () => {
    const release = job('release');
    const dirtyCheck = release.indexOf('git status --porcelain');
    const build = release.indexOf('npm run package:desktop');

    expect(dirtyCheck).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(dirtyCheck).toBeLessThan(build);
  });

  it('compares the stamp with the commit and with the release record input', () => {
    const release = job('release');

    expect(workflow).toContain('desktop_commit_stamp');
    expect(release).toContain('inputs.desktop_commit_stamp');
    // The stamp inside the asar is the manifest's `commitSha`; comparing that to
    // `github.sha` is what makes "the build is of this commit" checkable from the
    // signed artifact rather than from the build log.
    expect(release).toContain('manifest.commitSha');
    expect(release).toContain('github.sha');
  });
});

describe('no step is one edit away from printing a secret', () => {
  it('uses a secret only as the value of an env entry named after it', () => {
    for (const line of workflow.split('\n')) {
      const match = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/u.exec(line);
      if (match === null) continue;
      expect(line.trim(), line.trim()).toBe(`${match[1] ?? ''}: \${{ secrets.${match[1] ?? ''} }}`);
    }
  });

  it('never turns on shell tracing', () => {
    expect(workflow).not.toMatch(/set -[a-z]*x/u);
  });

  it('prints only public facts in the step summary', () => {
    const summary = workflow.slice(workflow.indexOf('GITHUB_STEP_SUMMARY') - 1200, workflow.indexOf('GITHUB_STEP_SUMMARY') + 200);

    expect(summary).not.toMatch(/secrets\./u);
    for (const fact of ['version', 'commit', 'sha256', 'bytes']) expect(summary, fact).toContain(fact);
  });

  it('keeps the host job free of every signing credential', () => {
    const host = job('host');

    expect(host).not.toContain('${{ secrets.');
    // And it says so out loud, so a credential arriving here stops the job rather
    // than producing something that looks signed and was never verified as such.
    expect(host).toContain('is set in the unsigned host job');
  });
});
