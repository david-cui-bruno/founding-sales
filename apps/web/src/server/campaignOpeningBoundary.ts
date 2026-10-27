import { z } from 'zod';
const refusal = z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.enum([
  'invalid_input', 'campaign_unavailable', 'stale_campaign', 'already_configured', 'baseline_unavailable',
  'binding_changed', 'expiry_invalid', 'policy_unavailable', 'policy_changed', 'campaign_changed',
]) });
/** Only finite domain-state refusals are content. Auth loss, command collisions
 * and unrecognized failures preserve uncertain custody as transport failures. */
export function campaignOpeningBrowserResult(path: string, status: number, body: unknown): { status: number; body: unknown } | null {
  if (!['/outreach/email-campaigns/opening/approve', '/outreach/email-campaigns/opening/revoke'].includes(path) || status !== 409) return null;
  const parsed = refusal.safeParse(body);
  return parsed.success ? { status: 200, body: parsed.data } : null;
}
