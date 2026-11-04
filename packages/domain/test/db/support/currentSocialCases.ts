import {SOCIAL_PRIVATE_CONSTRAINT_CASES} from './socialPrivateCases.ts';
import {SOCIAL_PUBLIC_THREAD_CONSTRAINT_CASES} from './publicThreadCases.ts';
import {SOCIAL_FOUNDER_CONSTRAINT_CASES} from './socialFounderCases.ts';
import {SOCIAL_APPROVED_MEDIA_CONSTRAINT_CASES} from './socialApprovedMediaCases.ts';
import {SOCIAL_PUBLISHER_CONSTRAINT_CASES} from './socialPublisherCases.ts';
import {SOCIAL_STANDING_CONSTRAINT_CASES} from './socialStandingCases.ts';
/** Current-schema composition only; migration135 keeps its frozen private catalog. */
export const CURRENT_SOCIAL_CONSTRAINT_CASES=[...SOCIAL_PRIVATE_CONSTRAINT_CASES,...SOCIAL_PUBLIC_THREAD_CONSTRAINT_CASES,...SOCIAL_FOUNDER_CONSTRAINT_CASES,...SOCIAL_APPROVED_MEDIA_CONSTRAINT_CASES,...SOCIAL_PUBLISHER_CONSTRAINT_CASES,...SOCIAL_STANDING_CONSTRAINT_CASES];
