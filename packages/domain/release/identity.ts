import { isImageDigest } from '@fss/contracts';

/**
 * Which image this process is running.
 *
 * The release-record rule compares a stored digest with the running one, so each
 * service has to know its own. ECS already says: every task gets
 * `ECS_CONTAINER_METADATA_URI_V4`, and a GET of that URI answers this container's
 * metadata, including `Image` — the reference the task definition registered, which
 * `infra/modules/cluster` refuses unless it ends in `@sha256:<64 hex>` — and `ImageID`.
 * No Terraform, no IAM permission and no new environment variable is needed for it,
 * which is why it is the source rather than a variable a deployment would have to set
 * and keep in step with the image it names.
 *
 * The container endpoint rather than `/task`: `/task` lists every container of the
 * task and a process would then have to know its own container's name to choose one,
 * which is a second copy of a Terraform string. The container endpoint names exactly
 * the container asking.
 *
 * ## The order, and why the variable does not win inside ECS
 *
 *   1. **Inside ECS** (the metadata variable is set): the metadata endpoint, and
 *      nothing else. `Image`'s `@sha256:` suffix first, because it is the digest the
 *      task definition pinned and the release record names; `ImageID` only when the
 *      reference carries no digest. A failed or malformed answer is `unknown`, never a
 *      fall back to `FSS_IMAGE_DIGEST`: an override a task definition or a
 *      `run-task --overrides` could set would otherwise be a way to claim a rehearsed
 *      digest for an image nobody rehearsed.
 *   2. **Outside ECS**: `FSS_IMAGE_DIGEST`, for tests and a laptop, when it is a digest.
 *   3. Otherwise **`unknown`**. The rule refuses to enable or send under an unknown
 *      identity (`release_record_identity_unknown`), so this is fail closed.
 *
 * The digest is public — it is in the task definition, the release record and the
 * registry — so the bootstraps log it in their startup event. The URI is not logged:
 * it is harmless, and nothing needs it.
 */

export const ECS_METADATA_VARIABLE = 'ECS_CONTAINER_METADATA_URI_V4';
export const IMAGE_DIGEST_VARIABLE = 'FSS_IMAGE_DIGEST';
export const UNKNOWN_IMAGE_DIGEST = 'unknown';

export type ImageDigestSource = 'ecs_metadata_image' | 'ecs_metadata_image_id' | 'environment' | 'unknown';

export interface RunningImageIdentity {
  /** A `sha256:` digest, or `unknown`. */
  readonly digest: string;
  readonly source: ImageDigestSource;
  /** Why it is unknown, or what was set aside. A code, never a value from the environment. */
  readonly detail: string | null;
}

/** The part of `fetch` this uses, so a test can hand over its own. */
export type MetadataFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export interface DiscoverImageDigestOptions {
  readonly fetch?: MetadataFetch | undefined;
  /** Per attempt. The endpoint is link-local; two seconds is generous. */
  readonly timeoutMilliseconds?: number | undefined;
  /** The endpoint answers from the moment the container starts; three tries absorb a blip. */
  readonly attempts?: number | undefined;
  readonly retryDelayMilliseconds?: number | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const IMAGE_REFERENCE_DIGEST = /@(sha256:[0-9a-f]{64})$/u;

const unknown = (detail: string): RunningImageIdentity => ({ digest: UNKNOWN_IMAGE_DIGEST, source: 'unknown', detail });

/** The digest in one container-metadata answer, or null. Exported for the tests. */
export function digestFromContainerMetadata(
  metadata: unknown,
): { readonly digest: string; readonly source: 'ecs_metadata_image' | 'ecs_metadata_image_id' } | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const fields = metadata as Record<string, unknown>;
  const image = fields['Image'];
  if (typeof image === 'string') {
    const pinned = IMAGE_REFERENCE_DIGEST.exec(image.trim())?.[1];
    if (pinned !== undefined) return { digest: pinned, source: 'ecs_metadata_image' };
  }
  const imageId = fields['ImageID'];
  if (isImageDigest(imageId)) return { digest: imageId, source: 'ecs_metadata_image_id' };
  return null;
}

const pause = async (milliseconds: number): Promise<void> => {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
};

/** Once, at startup. Never throws: a failure is an `unknown` identity with a reason. */
export async function discoverImageDigest(
  environment: Environment,
  options: DiscoverImageDigestOptions = {},
): Promise<RunningImageIdentity> {
  const endpoint = environment[ECS_METADATA_VARIABLE]?.trim() ?? '';
  const override = environment[IMAGE_DIGEST_VARIABLE]?.trim() ?? '';

  if (endpoint.length === 0) {
    if (override.length === 0) return unknown('not_in_ecs_and_no_override');
    if (!isImageDigest(override)) return unknown('override_not_a_digest');
    return { digest: override, source: 'environment', detail: null };
  }

  const fetcher: MetadataFetch = options.fetch ?? (async (url, init) => await fetch(url, init));
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  let reason = 'metadata_unreachable';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 2000),
      });
      if (!response.ok) {
        reason = `metadata_status_${String(response.status)}`;
      } else {
        const found = digestFromContainerMetadata(await response.json());
        if (found !== null) {
          return {
            digest: found.digest,
            source: found.source,
            // Said, because somebody reading the log would otherwise assume it was used.
            detail: override.length > 0 ? 'override_ignored_inside_ecs' : null,
          };
        }
        // A well-formed answer without a digest will not improve on a retry.
        return unknown('metadata_has_no_digest');
      }
    } catch {
      reason = 'metadata_unreachable';
    }
    if (attempt < attempts) await pause(options.retryDelayMilliseconds ?? 250);
  }
  return unknown(reason);
}
