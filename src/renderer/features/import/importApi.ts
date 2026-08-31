/**
 * Import provider surface consumed by this feature.
 *
 * Re-exports the real preload `ImportApi` type so components, tests, and the
 * workflow hook stay pinned to the exact IPC surface: preview, remap, commit,
 * and status, all shaped by the shared import contract.
 */
export type { ImportApi } from '../../../preload/apis/importApi';
