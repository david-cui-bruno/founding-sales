import { postalAddressSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSettingForRead, readSetting, readSettingHistory } from './store.ts';

/**
 * The workspace's postal address, as the send path asks for it (migration 0020, lane W3-F).
 *
 * Two questions, and both are answered from recorded rows rather than from the shape of a
 * body:
 *
 *   * `readWorkspacePostalAddress` — the address in force, or null. A row that does not
 *     parse is null rather than an exception: the footer then carries the sign-off
 *     alone, which is what an approved body already ends with, so an unreadable setting
 *     can never stop the mail or leak a half-parsed value into a body.
 *   * `readRecordedPostalAddresses` — every address this workspace has *ever* saved,
 *     newest first, from the slice's own version history. That is the provenance the
 *     composition needs to recognise a footer it wrote earlier under an address that has
 *     since changed, instead of guessing which lines are an address (review of PR 296).
 *
 * `lockPostalAddressForRead` holds the slice still until the caller's transaction ends.
 * The claim takes it before it reads, so the footer it composes is the footer the
 * workspace had at the instant of the claim and an admin's save either lands before the
 * read or waits for the commit.
 *
 * Neither function is a rule. Whether an absent address may send at all is
 * `SEND_FOOTER_POLICY.postalAddressRequired` in `packages/domain/src/rules/templates.ts`.
 */

/** Every version the slice has ever had. One workspace, one key: a short list. */
const RECORDED_ADDRESS_LIMIT = 100;

export async function lockPostalAddressForRead(context: RepositoryContext): Promise<void> {
  await lockSettingForRead(context, 'postal_address');
}

const parseAddress = (value: unknown): string | null => {
  const parsed = postalAddressSettingSchema.safeParse(value);
  if (!parsed.success) return null;
  const address = parsed.data.address?.trim() ?? '';
  return address.length === 0 ? null : address;
};

export async function readWorkspacePostalAddress(context: RepositoryContext): Promise<string | null> {
  const stored = await readSetting(context, 'postal_address');
  return parseAddress(stored.value);
}

export async function readRecordedPostalAddresses(context: RepositoryContext): Promise<readonly string[]> {
  const versions = await readSettingHistory(context, 'postal_address', { limit: RECORDED_ADDRESS_LIMIT });
  const addresses: string[] = [];
  for (const version of versions) {
    const address = parseAddress(version.value);
    if (address !== null && !addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}
