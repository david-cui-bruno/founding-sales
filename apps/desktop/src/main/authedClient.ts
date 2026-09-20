import { randomUUID } from 'node:crypto';
import type { ApiOutcome, HttpSend } from './apiClient.ts';

/**
 * One authenticated JSON call, for the two windows G2's `apiClient` does not cover.
 *
 * `apiClient.ts` is the sign-in and session surface and it is deliberately a closed
 * list of six methods; the Today and CRM windows need another dozen endpoints between
 * them, all the same shape: bearer token in, typed body back, every failure one of the
 * closed outcomes. So this is the same discipline in a general form rather than twelve
 * more methods there.
 *
 * Two things it is *not*. It does not parse: the caller supplies the schema, because
 * "believe nothing the server said until it matches the contract" only means anything
 * if the contract is named at the call site. And it does not mint command ids for
 * reads — `commandFor` is separate, so a read cannot accidentally become a command
 * with a receipt.
 */

export interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly send: HttpSend;
  /** The live access token, renewed by the session manager. Null when signed out. */
  readonly accessToken: () => Promise<string | null>;
}

export interface AuthedClient {
  /** A read. No command id, no receipt. */
  read<T>(path: string, parse: (value: unknown) => T, body?: Readonly<Record<string, unknown>>): Promise<ApiOutcome<T>>;
  /** A mutation. The envelope of 5.3 is added here so no caller can forget it. */
  command<T>(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
    options?: { readonly commandId?: string },
  ): Promise<ApiOutcome<T>>;
}

const refusalOf = (body: unknown, status: number): string => {
  if (typeof body === 'object' && body !== null) {
    const record = body as { error?: unknown; reason?: unknown };
    const code = record.reason ?? record.error;
    if (typeof code === 'string' && code.length > 0 && code.length <= 80) return code;
  }
  return `http_${String(status)}`;
};

export function createAuthedClient(options: AuthedClientOptions): AuthedClient {
  const call = async (
    path: string,
    method: 'GET' | 'POST',
    body: Readonly<Record<string, unknown>> | undefined,
  ): Promise<ApiOutcome<unknown>> => {
    const token = await options.accessToken();
    if (token === null) return { ok: false, reason: 'not_signed_in', offline: false };
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const answer = await options.send(new URL(path, options.baseUrl).toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (answer.status < 200 || answer.status >= 300) {
        return { ok: false, reason: refusalOf(answer.body, answer.status), offline: false };
      }
      return { ok: true, value: answer.body };
    } catch {
      // The network, the DNS, the load balancer: all one thing from here. The window
      // may show its unexpired cache marked stale and may mutate nothing (4.2).
      return { ok: false, reason: 'offline', offline: true };
    }
  };

  const parsed = <T>(outcome: ApiOutcome<unknown>, parse: (value: unknown) => T): ApiOutcome<T> => {
    if (!outcome.ok) return outcome;
    try {
      return { ok: true, value: parse(outcome.value) };
    } catch {
      return { ok: false, reason: 'unreadable_answer', offline: false };
    }
  };

  return {
    async read(path, parse, body) {
      return parsed(await call(path, body === undefined ? 'GET' : 'POST', body), parse);
    },
    async command(path, payload, parse, commandOptions = {}) {
      const answer = await call(path, 'POST', {
        commandId: commandOptions.commandId ?? randomUUID(),
        clientVersion: options.clientVersion,
        ...payload,
      });
      if (!answer.ok) return answer;
      // Every command answers `{ status, replayed, result | reason }` (crmSupport).
      // A refusal arrives with status 409 and is caught above; this is the accepted
      // shape, and a body that is not it is `unreadable_answer` rather than a guess.
      const envelope = answer.value as { status?: unknown; result?: unknown };
      if (envelope.status !== 'accepted') return { ok: false, reason: 'refused', offline: false };
      return parsed({ ok: true, value: envelope.result }, parse);
    },
  };
}
