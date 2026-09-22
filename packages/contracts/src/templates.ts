/**
 * The one sentence every approved automated template ends with (specification 12.6:
 * reply-based opt-out, no web unsubscribe link).
 *
 * It is here rather than in `@fss/domain` because two packages need the same bytes:
 * the approval rule in `packages/domain/src/rules/templates.ts`, which refuses a body
 * that does not end with the footer block, and the Mac's template panel, which shows
 * that block and says whether the body carries it. The desktop depends on
 * `@fss/contracts` and not on `@fss/domain`, so a copy in the renderer would be a
 * second spelling of a sentence that has to have one.
 *
 * `@fss/domain` re-exports it, so every existing importer is unchanged.
 */
export const SENDING_STOP_LINE = 'Reply "stop" and I will not email you again.';
