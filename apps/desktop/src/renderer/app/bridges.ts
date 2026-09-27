import type { DesktopBridge, MailboxBridge } from '../../shared/contract.ts';
import type { UpdateBridge } from '../../shared/updateContract.ts';
import type { AdminBridge } from '../settingsContract.ts';

/**
 * The bridges the preload installs, read in one place.
 *
 * Each is `undefined` in a page built without the preload — which is a real build (the
 * Playwright harness runs one on purpose, and so does a renderer opened by hand), not a
 * hypothetical — so every accessor answers `undefined` rather than throwing, and the
 * views say "unavailable in this build" where a control would have been. The session
 * bridge is the exception: nothing at all can be drawn without it, so it throws.
 */

export function desktopBridge(): DesktopBridge {
  const value = globalThis.callie;
  if (value === undefined) throw new Error('the Callie bridge is not present');
  return value;
}

export const mailboxBridge = (): MailboxBridge | undefined => globalThis.callieMailbox;
export const updateBridge = (): UpdateBridge | undefined => globalThis.callieUpdate;
export const adminBridge = (): AdminBridge | undefined => globalThis.callieAdmin;
