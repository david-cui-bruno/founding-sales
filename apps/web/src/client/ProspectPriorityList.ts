import {z} from 'zod';
import {prospectPriorityListSchema} from '@fss/contracts';
/** Product conflicts are distinct from an empty list and never use an old-list fallback. */
export const prospectPriorityReadSchema=z.union([prospectPriorityListSchema,z.strictObject({error:z.literal('view_changed')})]);
export const PRIORITY_VIEW_CHANGED='Prospect order changed. Refresh from the first page to continue with current evidence.';
