import type {EvaluationQuery} from './evaluateDiscovery.ts';
/** Versioned hypotheses; none establishes fit, a current vacancy or unmet need. */
export const SOURCING_EVALUATION_QUERIES:readonly EvaluationQuery[]=[
 {id:'dfw-workflow-v2',cohort:'workflow_context',query:'Dallas Fort Worth Texas single family property management tenant maintenance emergency after hours owner phone'},
 {id:'dfw-coordination-v2',cohort:'coordination_hiring',query:'Dallas Fort Worth Texas residential property management hiring maintenance coordinator job apply -technician -supervisor'},
 {id:'dfw-fit-v2',cohort:'fit_only',query:'Dallas Fort Worth Texas single family rental property management locally owned family team -commercial'},
 {id:'providence-workflow-v2',cohort:'workflow_context',query:'Providence Rhode Island residential property management tenant emergency maintenance after hours'},
 {id:'providence-coordination-v2',cohort:'coordination_hiring',query:'Providence Rhode Island residential property management hiring maintenance coordinator job apply -technician -supervisor'},
 {id:'providence-fit-v2',cohort:'fit_only',query:'Providence Rhode Island single family rental property management locally owned team -commercial'},
 {id:'boston-workflow-v2',cohort:'workflow_context',query:'Boston Massachusetts residential rental property management tenant maintenance emergency after hours'},
 {id:'boston-coordination-v2',cohort:'coordination_hiring',query:'Boston Massachusetts residential property management hiring maintenance coordinator job apply -technician -supervisor'},
 {id:'boston-fit-v2',cohort:'fit_only',query:'Boston Massachusetts single family rental property management locally owned team -HOA -commercial'},
];
