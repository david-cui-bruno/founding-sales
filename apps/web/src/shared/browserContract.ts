import { z } from 'zod';
import { instant, membershipRoleSchema, uuid } from '@fss/contracts';

export const browserErrorConfigurationSchema = z.strictObject({
  dsn: z.string().regex(/^https:\/\/[a-f0-9]+@o[0-9]+\.ingest\.us\.sentry\.io\/[0-9]+$/u).refine(value => !/\s/u.test(value)).optional(),
  release: z.union([z.literal(''), z.string().length(40).regex(/^[a-f0-9]{40}$/u)]),
});
export type BrowserErrorConfiguration = z.infer<typeof browserErrorConfigurationSchema>;

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
  runtime: '/browser/runtime',
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
  '/today', '/firms', '/meetings/outcomes', '/today/actions/v3', '/today/actions/v4',
  '/meetings/firm', '/meetings/brief',
  '/calls/calling', '/calling-identities', '/calling/setup',
] as const);
export const BROWSER_POST_READ_PATHS = Object.freeze([
  '/dial/check',
  '/today/firm', '/crm/firm-page-v3', '/today/actions/open/v3', '/today/actions/open/v4',
  '/sourcing/research-firms/list', '/sourcing/research-firms/read',
  '/sourcing/prepared-prospects/list', '/sourcing/prepared-prospects/read',
  '/sourcing/candidates/list', '/sourcing/candidates/authority/read',
  '/sourcing/candidates/prospects/list',
  '/sourcing/candidates/prospects/priority/list', '/sourcing/candidates/prospects/priority/learning', '/sourcing/candidates/prospects/priority/receipt',
  '/sourcing/candidates/prospects/activity/list', '/sourcing/candidates/prospects/activity/read',
  '/sourcing/candidates/prospects/activity/receipt',
  '/sourcing/qualification/read',
  '/sourcing/candidates/phone-discovery/read', '/sourcing/candidates/phone-discovery/receipt',
  '/sourcing/candidates/phone-discovery/refusal-original/read',
  '/outreach/answer-blocks',
  '/outreach/email-campaigns/control',
  '/settings/booking-link/read',
  '/outreach/email-campaigns/opening/control', '/outreach/email-campaigns/opening/receipt',
  '/replies', '/replies/card', '/replies/composer/context', '/replies/composer/preview',
  '/social/publishing/readiness', '/social/threads/list', '/social/threads/read',
  '/social/drafts', '/social/drafts/read', '/social/drafts/request/receipt',
  '/social/private-drafts/list', '/social/private-drafts/read', '/social/private-drafts/receipt',
  '/social/voice-preferences/read', '/social/voice-preferences/receipt',
  '/social/inputs/list','/social/inputs/read','/social/calibration/read','/social/founder/receipt',
  '/social/media/list','/social/media/preview','/social/assets/upload-url',
  '/social/media/receipt',
  '/social/standing-plan/read','/social/standing-plan/options','/social/standing-plan/activity','/social/standing-plan/receipt',
  '/calling/follow-ups/list', '/calling/follow-ups/read', '/calling/follow-ups/receipt',
  '/calling/execution/receipt', '/calling/setup/receipt','/calling/setup/budget-receipt','/calling/audio-test/receipt',
  '/calling/preparation/read','/calling/preparation/receipt',
] as const);
/** Ephemeral outgoing-only Voice credential. Not a command, never persisted by the client. */
export const BROWSER_VOICE_POST_PATHS = Object.freeze(['/calls/access-token'] as const);
export const BROWSER_COMMAND_PATHS = Object.freeze([
  '/meetings/notes', '/sourcing/research-firms/create',
  '/sourcing/candidates/prospects/feedback',
  '/sourcing/candidates/prospects/priority/save', '/sourcing/candidates/prospects/priority/consider',
  '/sourcing/candidates/prospects/activity/save',
  '/sourcing/qualification/request', '/sourcing/qualification/admit',
  '/sourcing/candidates/phone-discovery/request',
  '/sourcing/qualification/recovery/identity', '/sourcing/qualification/recovery/interpret',
  '/outreach/answer-blocks/save', '/outreach/answer-blocks/approve', '/outreach/answer-blocks/retire',
  '/outreach/email-campaigns/approve', '/outreach/email-campaigns/revoke',
  '/settings/booking-link/update',
  '/outreach/email-campaigns/opening/approve', '/outreach/email-campaigns/opening/revoke',
  '/replies/composer/generate',
  '/social/private-drafts/save', '/social/voice-preferences/save',
  '/social/drafts/request',
  '/social/inputs/save','/social/calibration/finish',
  '/social/assets/register','/social/assets/delete','/social/media/complete','/social/media/approve','/social/media/withdraw',
  '/social/standing-plan/command',
  '/calling/wrap', '/calling/follow-ups/save',
  '/calls/session', '/calling/setup/provider','/calling/setup/budget','/calling/audio-test/session',
  '/calling/preparation/confirm',
] as const);
/** Interactive account login is ephemeral: never a persisted command or receipt. */
export const BROWSER_SOCIAL_EPHEMERAL_PATHS=Object.freeze(['/social/publisher/connection'] as const);

export const browserSignInSchema = z.strictObject({
  workspaceId: uuid,
  deviceLabel: z.string().trim().min(1).max(120),
});

/** A firm identity read is the only dynamic resource path in this first slice. */
export function browserApiPathAllowed(method: string, path: string): boolean {
  if (method === 'GET') {
    return BROWSER_READ_PATHS.some(value => value === path) || /^\/firms\/[0-9a-f-]{36}$/iu.test(path);
  }
  return method === 'POST' && [...BROWSER_POST_READ_PATHS, ...BROWSER_COMMAND_PATHS, ...BROWSER_VOICE_POST_PATHS,...BROWSER_SOCIAL_EPHEMERAL_PATHS].some(value => value === path);
}
