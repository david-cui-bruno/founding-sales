import { z } from 'zod';
import { socialWorkspaceSchema } from '@fss/contracts';
import type { OperationInput } from '../../shared/operations.ts';
import type { AuthedClient } from '../authedClient.ts';

/** Existing post handlers, extracted without changing their wire shapes or session checks. */
export function socialContentOperations(deps: { api: AuthedClient; generation(): number }) {
  return {
    'social.workspace': async () => {
      const generation = deps.generation();
      const answer = await deps.api.read('/social', value => socialWorkspaceSchema.parse(value), {});
      if (generation !== deps.generation()) return { view: null, reason: 'not_found' };
      return answer.ok ? { view: answer.value, reason: null } : { view: null, reason: answer.reason };
    },
    'social.mutate': async (input: OperationInput<'social.mutate'>) => {
      const generation = deps.generation();
      const { action, commandId, ...payload } = input;
      const paths = { save: '/social/posts/save', approve: '/social/posts/approve', cancel: '/social/posts/cancel' } as const;
      const answer = await deps.api.command(paths[action], payload, value => z.unknown().parse(value), { commandId });
      if (generation !== deps.generation()) return { accepted: false, view: null, reason: 'not_found' };
      if (!answer.ok) return { accepted: false, view: null, reason: answer.reason };
      const view = await deps.api.read('/social', value => socialWorkspaceSchema.parse(value), {});
      if (generation !== deps.generation()) return { accepted: false, view: null, reason: 'not_found' };
      return { accepted: true, view: view.ok ? view.value : null, reason: view.ok ? null : 'refresh_failed' };
    },
  };
}
