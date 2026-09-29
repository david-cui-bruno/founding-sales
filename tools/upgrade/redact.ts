/**
 * Take anything that looks like a connection URL out of text before it is printed.
 *
 * The child processes are handed the runtime role's URL in the environment and never
 * print it, but a `pg` error, a stack frame or a `node` diagnostic can carry it, and
 * the evidence artifact is uploaded (GPT-6 review, P2-2). This is a belt over that
 * brace: it is not a reason to pass a credential anywhere it could be printed.
 *
 * It replaces the whole URL rather than only its password, because a URL naming a host
 * and a user is itself more than an evidence file needs.
 */
const CONNECTION_URL = /\b(?:postgres|postgresql):\/\/[^\s'"`)]+/giu;
/** `user:password@host`, which is how `pg` sometimes renders one without a scheme. */
const USERINFO = /\b[A-Za-z0-9_.-]+:[^\s:@/]{3,}@[A-Za-z0-9_.-]+(?::\d+)?/gu;

export const REDACTED = '[redacted connection string]';

export function redactConnectionStrings(text: string): string {
  return text.replaceAll(CONNECTION_URL, REDACTED).replaceAll(USERINFO, REDACTED);
}
