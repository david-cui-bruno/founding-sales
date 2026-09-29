import type { StartupOutcome, RegistryReport } from './startup.ts';
import type { WorkflowOutcome } from './workflows.ts';

/**
 * What the post-upgrade checks report, and the line they report it on.
 *
 * A module of its own for the same reason `fixtureProtocol.ts` is: `checksMain.ts`
 * runs on import, so a parent that imported the constant from there would run the
 * checks in its own process — which is the very thing the two-checkout arrangement
 * exists to prevent (GPT-6 review, P1-4).
 */
export const CHECKS_JSON_PREFIX = 'CHECKS_JSON ';

/** `startup` alone is what the base checkout is asked for: its images' refusal. */
export type ChecksMode = 'startup' | 'startup+workflows';

export interface ChecksReport {
  readonly tree: string;
  readonly mode: ChecksMode;
  readonly startup: readonly StartupOutcome[];
  readonly registry: RegistryReport | null;
  readonly workflows: readonly WorkflowOutcome[] | null;
}
