import {
  clientVersionNoticeSchema,
  deviceListSchema,
  deviceSessionSchema,
  sessionGrantSchema,
  todayListResponseSchema,
  type ClientVersionNotice,
  type DeviceList,
  type DeviceSession,
  type SessionGrant,
} from '@fss/contracts';
import { z } from 'zod';
import { cachedTodaySchema, signInHandoffSchema, type CachedToday, type SignInHandoff } from '../shared/contract.ts';

/**
 * The only thing on this Mac that talks to the cloud (specification 14.2).
 *
 * Every answer is parsed through the shared contract before it is believed, so a
 * changed or hostile response becomes a refusal rather than a surprise inside the
 * session manager. Every failure is one of a closed set of outcomes: there is no
 * thrown exception to forget to catch, and no message from the server is ever shown
 * to a person unparsed.
 */

export type ApiOutcome<T> =
  | { readonly ok: true; readonly value: T }
  /**
   * The API answered and refused, with one of its stable codes. `refusal` is the
   * refusal's whole body, unparsed, for the one caller that has typed details to read
   * out of it — a merge's conflicts (lane g78, D05). Everyone else reads `reason`.
   */
  | { readonly ok: false; readonly reason: string; readonly offline: false; readonly refusal?: unknown }
  /** The API did not answer at all. The client may show its cache, marked stale. */
  | { readonly ok: false; readonly reason: 'offline'; readonly offline: true };

export interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

export type HttpSend = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
) => Promise<HttpAnswer>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly send: HttpSend;
}

export interface ApiClient {
  clientVersionNotice(): Promise<ApiOutcome<ClientVersionNotice>>;
  startSignIn(input: {
    readonly workspaceId: string;
    readonly deviceLabel: string;
  }): Promise<ApiOutcome<SignInHandoff>>;
  claimSignIn(handoffSecret: string): Promise<ApiOutcome<SessionGrant>>;
  /**
   * A session from the device secret (wave 3b, audit item S7).
   *
   * The one way this Mac gets an access token after the claim. The secret does not
   * rotate and opening twice is not reuse, so there is nothing to serialise against
   * losing and nothing to spend: a Mac restored from a backup opens exactly as one
   * that never stopped. `POST /auth/session/renew` has no caller on this Mac.
   */
  openSession(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly deviceSecret: string;
  }): Promise<ApiOutcome<DeviceSession>>;
  signOut(accessToken: string): Promise<ApiOutcome<null>>;
  /** The workspace's Macs (wave 3b, A4). */
  devices(accessToken: string): Promise<ApiOutcome<DeviceList>>;
  /** Sign one of them out. Revoking the caller's own device is this Mac signing out. */
  revokeDevice(accessToken: string, deviceId: string): Promise<ApiOutcome<RevokedDevice>>;
  today(accessToken: string): Promise<ApiOutcome<CachedToday>>;
}

/** `POST /devices/revoke`'s answer. */
export const revokedDeviceSchema = z.strictObject({
  revoked: z.boolean(),
  deviceId: z.string(),
  thisDevice: z.boolean(),
});
export type RevokedDevice = z.infer<typeof revokedDeviceSchema>;

const refusalOf = (answer: HttpAnswer): string => {
  const body = answer.body;
  if (typeof body === 'object' && body !== null) {
    const code = (body as { error?: unknown; reason?: unknown }).error ?? (body as { reason?: unknown }).reason;
    if (typeof code === 'string' && code.length > 0 && code.length <= 80) return code;
  }
  return `http_${String(answer.status)}`;
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const call = async (
    path: string,
    init: { readonly method: string; readonly body?: unknown; readonly accessToken?: string },
  ): Promise<ApiOutcome<unknown>> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.accessToken !== undefined) headers['authorization'] = `Bearer ${init.accessToken}`;
    try {
      const answer = await options.send(new URL(path, options.baseUrl).toString(), {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (answer.status < 200 || answer.status >= 300) {
        return { ok: false, reason: refusalOf(answer), offline: false };
      }
      return { ok: true, value: answer.body };
    } catch {
      // The network, the DNS, the load balancer: all one thing from here. The client
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
    async clientVersionNotice() {
      return parsed(await call('/auth/client-version', { method: 'GET' }), value =>
        clientVersionNoticeSchema.parse(value),
      );
    },
    async startSignIn(input) {
      return parsed(
        await call('/auth/sign-in/start', {
          method: 'POST',
          body: { ...input, clientVersion: options.clientVersion },
        }),
        value => signInHandoffSchema.parse(value),
      );
    },
    async claimSignIn(handoffSecret) {
      return parsed(
        await call('/auth/sign-in/claim', {
          method: 'POST',
          body: { handoffSecret, clientVersion: options.clientVersion },
        }),
        value => sessionGrantSchema.parse(value),
      );
    },
    async openSession(input) {
      return parsed(
        await call('/auth/session/open', {
          method: 'POST',
          body: {
            workspaceId: input.workspaceId,
            deviceId: input.deviceId,
            deviceSecret: input.deviceSecret,
            clientVersion: options.clientVersion,
          },
        }),
        value => deviceSessionSchema.parse(value),
      );
    },
    async signOut(accessToken) {
      const outcome = await call('/auth/sign-out', { method: 'POST', body: {}, accessToken });
      return outcome.ok ? { ok: true, value: null } : outcome;
    },
    async devices(accessToken) {
      return parsed(await call('/devices', { method: 'GET', accessToken }), value => deviceListSchema.parse(value));
    },
    async revokeDevice(accessToken, deviceId) {
      return parsed(await call('/devices/revoke', { method: 'POST', body: { deviceId }, accessToken }), value =>
        revokedDeviceSchema.parse(value),
      );
    },
    async today(accessToken) {
      // The wire contract first, which drops a key the API added and this build does not
      // know; then the cache's own strict shape, which is what may be written to disk
      // (lane g78). Before g78 the cache schema read the wire directly, so any field the
      // API added would have made every Mac refuse its own Today list.
      return parsed(await call('/today', { method: 'GET', accessToken }), value =>
        cachedTodaySchema.parse(todayListResponseSchema.parse(value)),
      );
    },
  };
}

/** The real sender. Nothing else in the package knows `fetch` exists. */
export const fetchSend: HttpSend = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
};
