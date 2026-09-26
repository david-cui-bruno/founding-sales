import type { GmailStatus } from '@fss/contracts';
import {
  beginGmailGrant,
  completeGmailGrant,
  disconnectMailbox,
  readOwnMailbox,
  verifyGrantState,
} from '@fss/domain/mail/oauth.ts';
import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { registerMailboxSendingDomain } from '@fss/domain/outbound/domainGuard.ts';
import { errorFields, type Logger } from '../bootstrap/log.ts';
import { connectMailboxCommandSchema, disconnectMailboxCommandSchema } from '@fss/contracts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { mailRouteDeps, membershipScope } from './mailSupport.ts';
import { contextForPrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Gmail grant surface (specification 5.1, 12.1, 12.6, 14.1).
 *
 * Four exact paths. `/oauth/gmail/callback` is spelled the way it is because Google
 * holds the registered redirect URI and it is
 * `https://api.usecallie.com/oauth/gmail/callback`: the path is a fact about a
 * console setting, not a choice this file gets to make, and a mistyped one is a
 * consent screen that ends in an error page.
 *
 * The callback is the one route here with no session, and that is not a hole. The
 * `state` is a MAC over the workspace, the user and a ten-minute expiry, made with a
 * key only this process holds; the callback verifies it, re-checks the membership
 * (5.1), and builds the scope from what it proved. Google's authorization code is
 * single-use on top of that. Nothing about the grant reaches the browser: the page is
 * a fixed document, and the Mac learns the outcome from `/gmail/status`, which is the
 * same shape `docs/decisions/g2-redirect-target.md` chose for sign-in.
 */

export const GMAIL_PATHS: readonly string[] = [
  '/gmail/connect',
  '/gmail/disconnect',
  '/gmail/status',
  '/oauth/gmail/callback',
];

const CALLBACK_PAGE = (heading: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Callie</title></head><body><h1>${heading}</h1><p>${body}</p></body></html>`;

const CONNECTED_PAGE = CALLBACK_PAGE('Gmail connected', 'You can close this tab and return to Callie.');
const REFUSED_PAGE = CALLBACK_PAGE('Gmail not connected', 'Return to Callie; it will tell you what to do next.');

const html = (page: string, status: number): RouteResult => ({
  status,
  body: page,
  contentType: 'text/html; charset=utf-8',
});

export async function routeGmail(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!GMAIL_PATHS.includes(request.path)) return null;

  const mail = options.mail;
  const auth = options.auth;
  if (mail === undefined || auth === undefined) {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  // The browser redirect. No session, and no interpolation into the page.
  if (request.path === '/oauth/gmail/callback') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const state = request.query.get('state') ?? '';
    const code = request.query.get('code');
    if (code === null || code.length === 0) return html(REFUSED_PAGE, 400);

    const claims = verifyGrantState(mail.stateSigningKey, state, Math.floor(Date.now() / 1000));
    if (claims === null) return html(REFUSED_PAGE, 400);
    const scoped = await membershipScope(auth, claims);
    if (scoped === null) return html(REFUSED_PAGE, 403);

    const outcome = await completeGmailGrant(scoped.context, mail, { state, code });
    if (!outcome.ok) return html(REFUSED_PAGE, 409);
    await registerConnectedDomain(auth.db, scoped.context, outcome.value, options.log);
    return html(CONNECTED_PAGE, 200);
  }

  const prepared = await mailRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/gmail/status') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const mailbox = await readOwnMailbox(scoped.context, deps.principal.userId);
    // Appendix F: the mailbox owner sees their own diagnostics. Nothing here is a
    // credential, and the token's existence is reported as a boolean, never a value.
    // `satisfies GmailStatus`: the Mac parses this body with the same schema
    // (`@fss/contracts` `gmailStatusSchema`), so a field renamed here is a type error
    // rather than a Mailbox row that silently says "Not connected".
    return {
      status: 200,
      body: {
        connected: mailbox !== null && mailbox.status === 'connected',
        mailbox:
          mailbox === null
            ? null
            : {
                id: mailbox.id,
                emailAddress: mailbox.emailAddress,
                status: mailbox.status,
                syncState: mailbox.syncState,
                coverageWatermarkAt: mailbox.coverageWatermarkAt,
                lastSyncedAt: mailbox.lastSyncedAt,
                lastSyncError: mailbox.lastSyncError,
              },
      } satisfies GmailStatus,
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/gmail/connect':
      return await runRouteCommand(
        deps,
        connectMailboxCommandSchema,
        'connect_mailbox',
        async context => await beginGmailGrant(context, mail),
      );
    case '/gmail/disconnect':
      return await runRouteCommand(
        deps,
        disconnectMailboxCommandSchema,
        'disconnect_mailbox',
        async (context, body) =>
          await disconnectMailbox(context, mail, { mailboxId: body.mailboxId, reason: body.reason }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

/**
 * A connected mailbox's domain is the workspace's sending domain.
 *
 * Runs after `completeGmailGrant` has returned, so the mailbox, its token and its
 * coverage hold are already written, and nothing here can undo them: a registration
 * that throws is a `warn` line and a connected mailbox, never a consent page that says
 * "not connected" about a mailbox that is. The admin can still create the row with
 * `POST /outbound/domain` or the operator with `fss admin workspace bootstrap
 * --sending-domain`, and both are idempotent with this.
 *
 * The registration and its audit row commit together or not at all, in a transaction
 * of their own on the request session — the same session `runCommand` opens its
 * transactions on — so a failure leaves neither behind.
 *
 * `registerSendingDomain` never changes a row that exists and never moves the primary,
 * so a reconnect is a read. A personal-Gmail address is refused there, quietly — an
 * `info` line naming the reason — because 12.6 treats that domain as a recipient
 * class, not as somewhere Callie sends from; `completeGmailGrant`'s hosted-domain check
 * already makes it unreachable in any deployment whose hosted domain is a Workspace.
 */
async function registerConnectedDomain(
  session: SessionQueryable,
  context: RepositoryContext,
  connected: { readonly mailboxId: string; readonly emailAddress: string },
  log: Logger | undefined,
): Promise<void> {
  try {
    const registered = await withTransaction(session, async () =>
      registerMailboxSendingDomain(context, { emailAddress: connected.emailAddress }),
    );
    if (!registered.ok) {
      log?.log('info', 'sending_domain_not_registered', { mailbox_id: connected.mailboxId, reason: registered.reason });
      return;
    }
    if (registered.outcome === 'created') {
      log?.log('info', 'sending_domain_registered', {
        mailbox_id: connected.mailboxId,
        domain: registered.domain.domain,
        primary: registered.domain.isPrimary,
      });
    }
  } catch (error) {
    log?.log('warn', 'sending_domain_registration_failed', { mailbox_id: connected.mailboxId, ...errorFields(error) });
  }
}
