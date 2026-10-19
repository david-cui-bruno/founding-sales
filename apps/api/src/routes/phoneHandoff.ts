import { z } from 'zod';
import { reservePhoneHandoffCommandSchema, uuid } from '@fss/contracts';
import { readPhoneHandoffResult, reservePhoneHandoff } from '@fss/domain/dial/phoneHandoff.ts';
import { runPolicyCommand, type PolicyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { RouteResult } from './types.ts';

/** Commit an identity-only receipt, then construct a fresh-only actionable response. */
export async function routePhoneHandoff(deps: PolicyRouteDeps): Promise<RouteResult> {
  const answer = await runPolicyCommand(deps, reservePhoneHandoffCommandSchema, 'reserve_phone_handoff',
    (context, body) => reservePhoneHandoff(context, { ...body, deviceId: deps.principal.deviceId }));
  if (answer.status !== 200) return answer;
  const envelope = z.object({ status: z.literal('accepted'), replayed: z.boolean(), result: z.object({ attemptId: uuid }) }).parse(answer.body);
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const result = await readPhoneHandoffResult(scoped.context, envelope.result.attemptId, envelope.replayed);
  if (result === null) return { status: 409, body: { status: 'refused', reason: 'handoff_reconciliation_required' } };
  return { status: 200, body: { status: 'accepted', replayed: envelope.replayed, result } };
}
