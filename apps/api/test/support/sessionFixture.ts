import { randomUUID } from 'node:crypto';
import { claimSignIn, handleCallback, startSignIn, type SessionGrant } from '../../src/auth/index.ts';
import {
  CURRENT_CLIENT_VERSION,
  nonceOf,
  stateOf,
  type AuthFixture,
  type SeededWorkspace,
} from './authFixture.ts';

/**
 * A real session grant, through the real sign-in.
 *
 * The CRM tests need a bearer token, and there is exactly one way to get one: the
 * whole authorization-code flow, against the stubbed Google of `authFixture`. Minting
 * a row straight into `sessions` would be quicker and would prove nothing — the thing
 * under test is what `dispatch` does with a token an actual sign-in produced.
 */
export async function issueSessionFor(
  fixture: AuthFixture,
  workspace: SeededWorkspace,
  member: { readonly googleSub: string; readonly email: string },
  options: { readonly deviceLabel?: string } = {},
): Promise<SessionGrant> {
  const started = await startSignIn(fixture.deps, {
    workspaceId: workspace.workspaceId,
    deviceLabel: options.deviceLabel ?? fixture.collidingDeviceLabel,
    clientVersion: CURRENT_CLIENT_VERSION,
  });
  if (!started.started) throw new Error(`sign-in did not start: ${started.refusal}`);

  const code = `code-${randomUUID()}`;
  fixture.google.issueCode(code);
  fixture.google.nextIdToken(
    fixture.google.signIdToken({
      sub: member.googleSub,
      email: member.email,
      hd: fixture.hostedDomain,
      nonce: nonceOf(started.authorizationUrl),
    }),
  );
  const callback = await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code });
  if (!callback.authenticated) throw new Error(`callback refused: ${callback.refusal}`);

  const claimed = await claimSignIn(fixture.deps, {
    handoffSecret: started.handoffSecret,
    clientVersion: CURRENT_CLIENT_VERSION,
  });
  if (!claimed.claimed) throw new Error(`claim refused: ${claimed.refusal}`);
  return claimed.grant;
}
