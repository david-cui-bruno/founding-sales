import { postalAddressSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from './store.ts';

/**
 * The workspace's postal address, as the send path asks for it (migration 0020, lane W3-F).
 *
 * One question, one answer: the configured address, or null. A row that does not parse is
 * null rather than an exception — the footer then carries the sign-off and the stop line,
 * which is the shape every approved body already ends with, so an unreadable setting can
 * never stop the mail or leak a half-parsed value into a body.
 *
 * It is a *read*, not a rule. Whether an absent address may send at all is
 * `SEND_FOOTER_POLICY.postalAddressRequired` in `packages/domain/src/rules/templates.ts`.
 */
export async function readWorkspacePostalAddress(context: RepositoryContext): Promise<string | null> {
  const stored = await readSetting(context, 'postal_address');
  const parsed = postalAddressSettingSchema.safeParse(stored.value);
  if (!parsed.success) return null;
  const address = parsed.data.address?.trim() ?? '';
  return address.length === 0 ? null : address;
}
