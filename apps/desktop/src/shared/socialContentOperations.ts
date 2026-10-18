import { z } from 'zod';
import { socialWorkspaceSchema, socialPostMutationSchema } from '@fss/contracts';

/** Existing post operations kept separate from the Person-bound manual ledger. */
export const SOCIAL_CONTENT_OPERATIONS = {
  'social.workspace': { kind: 'read', calls: [{ method: 'POST', path: '/social' }], input: z.strictObject({}), output: z.strictObject({ view: socialWorkspaceSchema.nullable(), reason: z.string().nullable() }), transform: 'Owner social drafts and destination connections' },
  'social.mutate': { kind: 'command', calls: [{ method: 'POST', path: '/social/posts/save' }, { method: 'POST', path: '/social/posts/approve' }, { method: 'POST', path: '/social/posts/cancel' }, { method: 'POST', path: '/social' }], input: socialPostMutationSchema, output: z.strictObject({ accepted: z.boolean(), view: socialWorkspaceSchema.nullable(), reason: z.string().nullable() }), transform: 'Exact revision and explicit scheduling approval' },
} as const;
