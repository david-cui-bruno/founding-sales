import { z } from 'zod';
import { semanticVersionSchema } from '@fss/contracts';

/**
 * What the page may be told about an update, and the one thing it may ask for (lane g83).
 *
 * Three states and a version. The page never learns a path, a digest, a reason code or
 * the channel's address: the main process decides everything, verifies everything, and
 * tells the page only enough to draw one line in Home's sidebar — "Updating Callie to
 * 1.0.6…" while an install is under way, or "Callie 1.0.6 is ready" with a Restart to
 * update button once a verified update is staged. `restart` takes no argument, so nothing
 * the page sends can choose what is installed.
 */

export const UPDATE_IPC_CHANNELS = {
  state: 'callie-update:state',
  restart: 'callie-update:restart',
  /** Wave 1: "Update now" on the upgrade screen — the six-hourly check, run now. No argument. */
  checkNow: 'callie-update:check-now',
  /** Main to page: the state changed; ask for it again. Carries nothing. */
  changed: 'callie-update:changed',
} as const;

export const updateStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  /** Verified and being put in place; Callie restarts by itself when it is. */
  z.strictObject({ kind: z.literal('installing'), version: semanticVersionSchema }),
  /** Verified and staged while the app was in use; installed on Restart or at the next launch. */
  z.strictObject({ kind: z.literal('ready'), version: semanticVersionSchema }),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const NO_UPDATE: UpdateStatus = { kind: 'none' };

export interface UpdateBridge {
  state(): Promise<UpdateStatus>;
  /** Installs the staged update and relaunches. Answers the state, which is `none` when nothing was staged. */
  restart(): Promise<UpdateStatus>;
  /**
   * Checks the channel now rather than in up to six hours (wave 1). A build the API has
   * blocked installs what it finds at once; any other stages it for Restart to update.
   * Answers the state after the check: `none` when the channel offered nothing.
   */
  checkNow(): Promise<UpdateStatus>;
  /** Called whenever the main process's update state changes. */
  onChange(listener: () => void): void;
}

declare global {
  var callieUpdate: UpdateBridge | undefined;
}
