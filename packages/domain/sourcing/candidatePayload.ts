import {legacyCandidateInputSchema,currentPreparedCandidateInputSchema,type CandidateInput,type LegacyCandidateInput} from '@fss/contracts';

/** Frozen admission/retained-phone payload guard. Current preparation must not widen it. */
export const isLegacyCandidatePayload=(value:unknown):value is LegacyCandidateInput=>legacyCandidateInputSchema.safeParse(value).success;
export const isCurrentPreparedCandidatePayload=(value:unknown):value is CandidateInput=>currentPreparedCandidateInputSchema.safeParse(value).success;
