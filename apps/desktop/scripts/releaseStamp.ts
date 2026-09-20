import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { semanticVersionSchema } from '@fss/contracts';

/**
 * The commit stamp inside the bundle (G13a deliverable 1; specification 16.2, which
 * requires "the deployed commit/image digests match the rehearsal artifacts").
 *
 * The stamp is written into the app directory before it is packed, so it ends up
 * inside the asar and therefore inside the code signature. Editing it after the
 * build invalidates the signature, which is the point: a bundle cannot claim to be
 * a commit it is not without also failing `codesign --verify`.
 *
 * A release stamp is only ever made from a clean tree. A local smoke build may be
 * made from a dirty one — that is what it is for — and it says so in the same field
 * the verifier reads, so the two can never be confused.
 */

export const RELEASE_STAMP_FILE = 'release-stamp.json';

export const releaseStampSchema = z
  .strictObject({
    format: z.literal('fss-desktop-release'),
    version: z.literal(1),
    channel: z.enum(['release', 'local-smoke']),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** True when the working tree had uncommitted changes. Never true for a release. */
    dirty: z.boolean(),
    appVersion: semanticVersionSchema,
    electronVersion: z.string().min(1).max(32),
    /** Base64 SPKI DER of the update-signing public key. Public by construction. */
    updatePublicKey: z.string().max(256),
    builtAt: z.iso.datetime(),
  })
  .refine(stamp => stamp.channel !== 'release' || !stamp.dirty, {
    message: 'a release is never built from a dirty tree',
  })
  .refine(stamp => stamp.channel !== 'release' || stamp.updatePublicKey.length > 0, {
    message: 'a release embeds the update-signing public key',
  })
  .refine(stamp => stamp.channel !== 'release' || stamp.appVersion !== '0.0.0', {
    // The workspace's placeholder version. A release at 0.0.0 is below every
    // minimum the API could publish, so it would ship a client that cannot
    // mutate and cannot be upgraded past itself.
    message: 'a release carries a real version; set FSS_DESKTOP_APP_VERSION',
  });

export type ReleaseStamp = z.infer<typeof releaseStampSchema>;

export function validateReleaseStamp(value: unknown): ReleaseStamp {
  return releaseStampSchema.parse(value);
}

export interface GitState {
  readonly commitSha: string;
  readonly dirty: boolean;
}

/** HEAD and whether anything is uncommitted, with no `GIT_*` from the environment. */
export function readGitState(root: string, run: typeof execFileSync = execFileSync): GitState {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (args: readonly string[]): string =>
    String(run('git', [...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 }));
  return {
    commitSha: git(['rev-parse', '--verify', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain=v1', '--untracked-files=all']).trim() !== '',
  };
}

export interface BuildReleaseStampInput {
  readonly channel: 'release' | 'local-smoke';
  readonly git: GitState;
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly updatePublicKey: string;
  readonly now: Date;
}

export function buildReleaseStamp(input: BuildReleaseStampInput): ReleaseStamp {
  return validateReleaseStamp({
    format: 'fss-desktop-release',
    version: 1,
    channel: input.channel,
    commitSha: input.git.commitSha,
    dirty: input.git.dirty,
    appVersion: input.appVersion,
    electronVersion: input.electronVersion,
    updatePublicKey: input.updatePublicKey,
    builtAt: input.now.toISOString(),
  });
}
