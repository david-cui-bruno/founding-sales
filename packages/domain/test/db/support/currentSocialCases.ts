import {SOCIAL_PRIVATE_CONSTRAINT_CASES} from './socialPrivateCases.ts';
import {SOCIAL_PUBLIC_THREAD_CONSTRAINT_CASES} from './publicThreadCases.ts';
/** Current-schema composition only; migration135 keeps its frozen private catalog. */
export const CURRENT_SOCIAL_CONSTRAINT_CASES=[...SOCIAL_PRIVATE_CONSTRAINT_CASES,...SOCIAL_PUBLIC_THREAD_CONSTRAINT_CASES];
