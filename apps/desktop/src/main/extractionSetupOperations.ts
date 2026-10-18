import type { AuthedClient } from './authedClient.ts';
import { OPERATIONS, type OperationInput } from '../shared/operations.ts';

/** Existing authenticated read/save bridge. The API alone owns revision and owner policy. */
export function extractionSetupOperations(deps: { api: AuthedClient; identity: { current(): number } }) {
  return {
    'crm.processingPurpose': async (input: OperationInput<'crm.processingPurpose'>) => {
      const generation = deps.identity.current();
      const answer = await deps.api.read('/crm/processing/purpose/read', value => OPERATIONS['crm.processingPurpose'].output.parse(value), input);
      if (generation !== deps.identity.current()) throw new Error('identity_changed');
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'crm.processingPurposeSave': async (input: OperationInput<'crm.processingPurposeSave'>) => {
      const generation = deps.identity.current();
      const answer = await deps.api.command('/crm/processing/purpose/save', input, value => OPERATIONS['crm.processingPurposeSave'].output.parse(value));
      if (generation !== deps.identity.current()) throw new Error('identity_changed');
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
  };
}
