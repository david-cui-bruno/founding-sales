import { bookingLinkSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from './store.ts';

/**
 * The workspace's booking link, as `{booking_link}` asks for it (migration 0157): the
 * public HTTPS URL an admin saved, or null. A row that does not parse is null rather than
 * an exception, so an unreadable setting leaves the variable absent and the step held
 * (11.1: "Missing required variables hold the step") instead of putting a half-parsed
 * value into a body.
 */
export async function readWorkspaceBookingLink(context: RepositoryContext): Promise<string | null> {
  const parsed = bookingLinkSettingSchema.safeParse((await readSetting(context, 'booking_link')).value);
  return parsed.success ? parsed.data.url : null;
}
