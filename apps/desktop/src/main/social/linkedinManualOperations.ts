import { linkedinManualSavedSchema, linkedinManualViewSchema } from '@fss/contracts';
import type { OperationInput, OperationOutput } from '../../shared/operations.ts';
import type { AuthedClient } from '../authedClient.ts';

export function linkedinManualOperations(deps: { api: AuthedClient; generation(): number }) {
  const read = async (input: OperationInput<'linkedinManual.read'>, generation = deps.generation()): Promise<OperationOutput<'linkedinManual.read'>> => {
    if (generation !== deps.generation()) return { view: null, reason: 'session_changed' };
    try {
      const answer = await deps.api.read('/crm/linkedin/manual/read', value => linkedinManualViewSchema.parse(value), input);
      if (generation !== deps.generation()) return { view: null, reason: 'session_changed' };
      return answer.ok ? { view: answer.value, reason: null } : { view: null, reason: answer.reason };
    } catch { return { view: null, reason: generation === deps.generation() ? 'unavailable' : 'session_changed' }; }
  };
  const mutate = async (path: string, input: OperationInput<'linkedinManual.bind'> | OperationInput<'linkedinManual.record'>): Promise<OperationOutput<'linkedinManual.record'>> => {
    const generation = deps.generation();
    const { commandId, ...payload } = input;
    try {
      const answer = await deps.api.command(path, payload, value => linkedinManualSavedSchema.parse(value), { commandId });
      if (generation !== deps.generation()) return { accepted: false, view: null, reason: 'session_changed' };
      if (!answer.ok) return { accepted: false, view: null, reason: answer.reason };
      // The receipt is immutable history, never today's connection/stop state.
      const fresh = await read({ ledgerId: answer.value.ledgerId }, generation);
      if (generation !== deps.generation()) return { accepted: false, view: null, reason: 'session_changed' };
      return { accepted: true, view: fresh.view, reason: fresh.reason };
    } catch { return { accepted: false, view: null, reason: generation === deps.generation() ? 'unavailable' : 'session_changed' }; }
  };
  return {
    'linkedinManual.read': (input: OperationInput<'linkedinManual.read'>) => read(input),
    'linkedinManual.bind': (input: OperationInput<'linkedinManual.bind'>) => mutate('/crm/linkedin/manual/bind', input),
    'linkedinManual.record': (input: OperationInput<'linkedinManual.record'>) => mutate('/crm/linkedin/manual/record', input),
  };
}
