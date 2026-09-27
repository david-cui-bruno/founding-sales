import type { DesktopBridge } from '../../shared/contract.ts';
import type { DialBridge, ImportBridge, OperationApi } from '../../shared/operations.ts';
import type { UpdateBridge } from '../../shared/updateContract.ts';

/**
 * What the preload installs, read in one place.
 *
 * Since 1.0.13 there are five: the session, the operation registry, the dial handoff, the
 * import handoff and the update line. Each but the session is `undefined` in a page built
 * without the preload — which is a real build (the Playwright harness runs one on purpose,
 * and so does a renderer opened by hand), not a hypothetical — so each accessor answers
 * `undefined` rather than throwing, and a view whose operations are missing says so where
 * a control would have been. The session bridge is the exception: nothing at all can be
 * drawn without it, so it throws.
 */

export function desktopBridge(): DesktopBridge {
  const value = globalThis.callie;
  if (value === undefined) throw new Error('the Callie bridge is not present');
  return value;
}

/** D4's registry: every read and command a view may make, by name. */
export const operations = (): OperationApi | undefined => globalThis.callieApi;
export const dialBridge = (): DialBridge | undefined => globalThis.callieDial;
export const importBridge = (): ImportBridge | undefined => globalThis.callieImport;
export const updateBridge = (): UpdateBridge | undefined => globalThis.callieUpdate;
