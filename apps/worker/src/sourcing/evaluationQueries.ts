import type {EvaluationQuery} from './evaluateDiscovery.ts';
/** Versioned hypotheses, not keyword-based admission criteria. */
export const SOURCING_EVALUATION_QUERIES:readonly EvaluationQuery[]=[
 {id:'dfw-burden-v1',cohort:'explicit_burden',query:'Dallas Fort Worth property management "maintenance" "overwhelmed"'},
 {id:'dfw-coordination-v1',cohort:'coordination_hiring',query:'Dallas Fort Worth property management "maintenance coordinator" "after hours"'},
 {id:'dfw-fit-v1',cohort:'fit_only',query:'Dallas Fort Worth single family property management owner small team'},
 {id:'providence-burden-v1',cohort:'explicit_burden',query:'Providence property management "maintenance" "help" "coordination"'},
 {id:'providence-coordination-v1',cohort:'coordination_hiring',query:'Providence property management "maintenance coordinator"'},
 {id:'providence-fit-v1',cohort:'fit_only',query:'Providence residential property management owner team'},
 {id:'boston-burden-v1',cohort:'explicit_burden',query:'Boston property management "maintenance" "overwhelmed"'},
 {id:'boston-coordination-v1',cohort:'coordination_hiring',query:'Boston property management "maintenance coordinator" "after hours"'},
 {id:'boston-fit-v1',cohort:'fit_only',query:'Boston residential property management owner small team'},
];
