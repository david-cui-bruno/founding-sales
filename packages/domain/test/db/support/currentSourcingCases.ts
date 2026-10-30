import {SOURCING_CONSTRAINT_CASES} from './sourcingCases.ts';
import {PROSPECT_PRIORITY_CONSTRAINT_CASES} from './prospectPriorityCases.ts';
import {PREPARED_SOURCE_IDENTITY_CONSTRAINT_CASES} from './preparedSourceIdentityCases.ts';
/** Current-schema composition; historical sourcing catalogs remain unchanged. */
export const CURRENT_SOURCING_CONSTRAINT_CASES=[...SOURCING_CONSTRAINT_CASES,...PROSPECT_PRIORITY_CONSTRAINT_CASES,...PREPARED_SOURCE_IDENTITY_CONSTRAINT_CASES];
