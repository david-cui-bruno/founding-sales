/**
 * The mail core's structured log port.
 *
 * The shape is the worker's (`apps/worker/src/bootstrap/log.ts`): one JSON object per
 * line with `level` and `event` at the top level, values primitives only. A line names
 * identifiers — mailbox ids, Gmail ids, an RFC Message-ID, a watched address — and never
 * a body, a header value beyond those, or a credential.
 *
 * Deps may pass their own; the default writes the line to stdout, which is what the
 * container's log driver reads.
 */

export type MailLogLevel = 'info' | 'warn' | 'error';
export type MailLogValue = string | number | boolean | null;
export type MailLog = (level: MailLogLevel, event: string, fields: Readonly<Record<string, MailLogValue>>) => void;

export const stdoutMailLog: MailLog = (level, event, fields) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, component: 'mail', event, ...fields })}\n`);
};

/** A log that keeps its lines, for a test that asserts on them. */
export function recordingMailLog(): MailLog & {
  readonly lines: readonly { readonly level: MailLogLevel; readonly event: string; readonly fields: Readonly<Record<string, MailLogValue>> }[];
} {
  const lines: { level: MailLogLevel; event: string; fields: Readonly<Record<string, MailLogValue>> }[] = [];
  const log: MailLog = (level, event, fields) => {
    lines.push({ level, event, fields });
  };
  return Object.assign(log, { lines });
}
