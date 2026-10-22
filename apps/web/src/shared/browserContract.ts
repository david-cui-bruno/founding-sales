import { z } from 'zod';
import { instant, membershipRoleSchema, uuid } from '@fss/contracts';

/** Browser presentation metadata only. Credentials remain in server-controlled cookies. */
export const browserSessionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('signed_out'), csrfToken: z.string().min(32).max(200) }),
  z.strictObject({
    status: z.literal('signed_in'),
    csrfToken: z.string().min(32).max(200),
    revision: z.string().min(1).max(300),
    workspaceId: uuid,
    userId: uuid,
    deviceId: uuid,
    role: membershipRoleSchema,
    expiresAt: instant,
  }),
]);
export type BrowserSession = z.infer<typeof browserSessionSchema>;

export const BROWSER_PATHS = Object.freeze({
  session: '/browser/session',
  signIn: '/browser/sign-in',
  callback: '/browser/callback',
  signOut: '/browser/sign-out',
  apiPrefix: '/browser/api',
});
export const BROWSER_CSRF_HEADER = 'x-callie-csrf';
export const BROWSER_REVISION_HEADER = 'x-callie-session';

/** Deliberately not a generic proxy. Existing API handlers own all product policy. */
export const BROWSER_READ_PATHS = Object.freeze([
  '/today', '/firms', '/meetings/outcomes', '/today/actions/v3',
] as const);
export const BROWSER_POST_READ_PATHS = Object.freeze([
  '/today/firm', '/crm/firm-page-v3', '/today/actions/open/v3',
  '/sourcing/research-firms/list', '/sourcing/research-firms/read',
] as const);
export const BROWSER_COMMAND_PATHS = Object.freeze([
  '/meetings/notes', '/sourcing/research-firms/create',
] as const);

export const browserSignInSchema = z.strictObject({
  workspaceId: uuid,
  deviceLabel: z.string().trim().min(1).max(120),
});

/** A firm identity read is the only dynamic resource path in this first slice. */
export function browserApiPathAllowed(method: string, path: string): boolean {
  if (method === 'GET') {
    return BROWSER_READ_PATHS.some(value => value === path) || /^\/firms\/[0-9a-f-]{36}$/iu.test(path);
  }
  return method === 'POST' && [...BROWSER_POST_READ_PATHS, ...BROWSER_COMMAND_PATHS].some(value => value === path);
}
